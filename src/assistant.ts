import { DurableObject } from "cloudflare:workers";
import {
	createModels,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	Harness,
	type EntryRecord,
	type LiveState,
} from "@earendil-works/pi-durable";
import { PiHarness, type PiSession } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { toChatMessages } from "./chat/history";
import { createSseStream } from "./chat/sse";
import { decryptSecret, encryptSecret } from "./config/crypto";
import { errorMessage, fail } from "./config/errors";
import { buildProvider, providerIdFor } from "./config/provider";
import {
	MAX_PROFILES,
	readSettings,
	toPublicConfig,
	toPublicProfile,
	validateProfileInput,
	writeSettings,
} from "./config/store";
import type {
	ChatMessage,
	ProfileInput,
	PublicConfig,
	PublicProfile,
	StoredProfile,
	StoredSettings,
	TestProfileResult,
} from "./config/types";

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PROMPT_CHARS = 32_000;
const HISTORY_LIMIT = 200;

function normalizeSessionId(value: string | undefined): string | undefined {
	if (value === undefined || value === "") return undefined;
	if (!SESSION_ID.test(value)) fail("bad_request", "Invalid session id");
	return value;
}

export class Assistant extends DurableObject<Env> {
	private readonly models: MutableModels;
	private readonly registry = createRegistry();
	private readonly harness: PiHarness;
	private readonly lifecycle: Lifecycle<Env>;
	private readonly registeredProfiles = new Set<string>();
	private readonly keyErrors = new Map<string, string>();
	private readonly appliedModels = new Map<string, string>();
	private settings: StoredSettings | null = null;
	private settingsLoad: Promise<StoredSettings> | null = null;
	private readyPromise: Promise<void> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.models = createModels({
			authContext: {
				env: async () => undefined,
				fileExists: async () => false,
			},
		});
		this.harness = new PiHarness({
			harness: async ({ storage, context, onWake }) => {
				await this.loadSettings();
				return Harness.open(
					storage,
					{
						models: this.models,
						registry: this.registry,
						onWake,
						// Interactive chat: fail fast instead of retrying for minutes.
						settings: {
							retry: { enabled: true, maxRetries: 1, baseDelayMs: 800 },
						},
					},
					context,
				);
			},
		});
		this.lifecycle = Lifecycle.install(this).use(this.harness);
	}

	private ready(): Promise<void> {
		if (!this.readyPromise) {
			this.readyPromise = (async () => {
				await this.lifecycle.start();
				await this.loadSettings();
			})().catch((error) => {
				this.readyPromise = null;
				throw error;
			});
		}
		return this.readyPromise;
	}

	private loadSettings(): Promise<StoredSettings> {
		if (!this.settingsLoad) {
			this.settingsLoad = this.doLoadSettings().catch((error) => {
				this.settingsLoad = null;
				throw error;
			});
		}
		return this.settingsLoad;
	}

	private async doLoadSettings(): Promise<StoredSettings> {
		const settings = await readSettings(this.ctx.storage);
		await this.syncProviders(settings);
		this.settings = settings;
		return settings;
	}

	private async requireSettings(): Promise<StoredSettings> {
		await this.ready();
		if (!this.settings) fail("internal", "Settings are not loaded");
		return this.settings;
	}

	private async syncProviders(settings: StoredSettings): Promise<void> {
		const secret = this.env.CONFIG_ENCRYPTION_KEY;
		const next = new Set<string>();
		this.keyErrors.clear();

		for (const profile of settings.profiles) {
			const providerId = providerIdFor(profile.id);
			next.add(providerId);

			let key = "";
			if (profile.apiKey) {
				if (!secret) {
					this.keyErrors.set(
						profile.id,
						"CONFIG_ENCRYPTION_KEY is not configured on the server",
					);
				} else {
					try {
						key = await decryptSecret(
							profile.apiKey,
							`profile:${profile.id}`,
							secret,
						);
					} catch {
						this.keyErrors.set(
							profile.id,
							"The stored API key cannot be decrypted; save it again",
						);
					}
				}
			}

			this.models.setProvider(buildProvider(profile, key));
		}

		for (const providerId of this.registeredProfiles) {
			if (!next.has(providerId)) this.models.deleteProvider(providerId);
		}
		this.registeredProfiles.clear();
		for (const providerId of next) this.registeredProfiles.add(providerId);
	}

	private async persist(settings: StoredSettings): Promise<void> {
		await writeSettings(this.ctx.storage, settings);
		this.settings = settings;
		this.settingsLoad = Promise.resolve(settings);
		await this.syncProviders(settings);
		this.appliedModels.clear();
	}

	private async decryptProfileKey(profile: StoredProfile): Promise<string> {
		if (!profile.apiKey) {
			fail("conflict", "This profile has no API key");
		}
		const secret = this.env.CONFIG_ENCRYPTION_KEY;
		if (!secret) {
			fail("conflict", "CONFIG_ENCRYPTION_KEY is not configured on the server");
		}
		try {
			return await decryptSecret(
				profile.apiKey,
				`profile:${profile.id}`,
				secret,
			);
		} catch {
			fail("conflict", "The stored API key cannot be decrypted; save it again");
		}
	}

	private async applyActiveModel(session: PiSession): Promise<void> {
		const settings = await this.requireSettings();
		const profile = settings.profiles.find(
			(candidate) => candidate.id === settings.activeProfileId,
		);
		if (!profile) {
			fail("conflict", "No active model profile. Add one in Settings first.");
		}
		if (!profile.apiKey) {
			fail("conflict", "The active profile has no API key. Add one in Settings.");
		}
		const keyError = this.keyErrors.get(profile.id);
		if (keyError) fail("conflict", keyError);

		const model = {
			provider: providerIdFor(profile.id),
			id: profile.modelId,
		};
		const fingerprint = `${model.provider}:${model.id}`;
		if (this.appliedModels.get(session.id) === fingerprint) return;

		try {
			await session.setModel(model);
			this.appliedModels.set(session.id, fingerprint);
		} catch (error) {
			fail(
				"conflict",
				`The active model is not available: ${errorMessage(error)}`,
			);
		}
	}

	async getConfig(): Promise<PublicConfig> {
		const settings = await this.requireSettings();
		return toPublicConfig(settings, Boolean(this.env.CONFIG_ENCRYPTION_KEY));
	}

	async saveProfile(input: ProfileInput): Promise<PublicProfile> {
		const settings = await this.requireSettings();
		const existing = input?.id
			? settings.profiles.find((profile) => profile.id === input.id)
			: undefined;

		if (input?.id && !existing) fail("not_found", "Profile not found");
		if (!existing && settings.profiles.length >= MAX_PROFILES) {
			fail("bad_request", `At most ${MAX_PROFILES} profiles are allowed`);
		}

		const values = validateProfileInput(input, existing);
		let apiKey = existing?.apiKey;

		if (values.apiKey !== undefined) {
			const secret = this.env.CONFIG_ENCRYPTION_KEY;
			if (!secret) {
				fail(
					"bad_request",
					"CONFIG_ENCRYPTION_KEY is not configured; cannot store an API key",
				);
			}
			apiKey = await encryptSecret(
				values.apiKey,
				`profile:${values.id}`,
				secret,
			);
		} else if (!existing) {
			fail("bad_request", "API key is required for a new profile");
		}

		const now = Date.now();
		const profile: StoredProfile = {
			id: values.id,
			name: values.name,
			baseUrl: values.baseUrl,
			modelId: values.modelId,
			apiKey,
			reasoning: values.reasoning,
			contextWindow: values.contextWindow,
			maxTokens: values.maxTokens,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};

		const profiles = existing
			? settings.profiles.map((candidate) =>
					candidate.id === profile.id ? profile : candidate,
				)
			: [...settings.profiles, profile];
		const activeProfileId = settings.activeProfileId ?? profile.id;

		await this.persist({ ...settings, profiles, activeProfileId });
		return toPublicProfile(profile, activeProfileId);
	}

	async deleteProfile(id: string): Promise<{ ok: true }> {
		const settings = await this.requireSettings();
		if (!settings.profiles.some((profile) => profile.id === id)) {
			fail("not_found", "Profile not found");
		}
		const profiles = settings.profiles.filter((profile) => profile.id !== id);
		const activeProfileId =
			settings.activeProfileId === id
				? (profiles[0]?.id ?? null)
				: settings.activeProfileId;
		await this.persist({ ...settings, profiles, activeProfileId });
		return { ok: true };
	}

	async activateProfile(id: string): Promise<PublicConfig> {
		const settings = await this.requireSettings();
		if (!settings.profiles.some((profile) => profile.id === id)) {
			fail("not_found", "Profile not found");
		}
		const next = { ...settings, activeProfileId: id };
		await this.persist(next);
		return toPublicConfig(next, Boolean(this.env.CONFIG_ENCRYPTION_KEY));
	}

	async testProfile(id: string): Promise<TestProfileResult> {
		const settings = await this.requireSettings();
		const profile = settings.profiles.find((candidate) => candidate.id === id);
		if (!profile) fail("not_found", "Profile not found");

		const keyError = this.keyErrors.get(profile.id);
		if (keyError) return { ok: false, error: keyError };

		const provider = this.models.getProvider(providerIdFor(profile.id));
		const model = provider?.getModels().find(
			(candidate) => candidate.id === profile.modelId,
		) as Parameters<MutableModels["completeSimple"]>[0] | undefined;
		if (!model) return { ok: false, error: "The configured model is not registered" };

		const startedAt = Date.now();
		const key = this.keyErrors.has(profile.id)
			? ""
			: await this.decryptProfileKey(profile).catch(() => "");
		const redact = (text: string): string =>
			key ? text.replaceAll(key, "[redacted]").slice(0, 1_000) : text.slice(0, 1_000);
		try {
			const message = await this.models.completeSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: "Reply with OK.",
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 16, signal: AbortSignal.timeout(20_000) },
			);
			const latencyMs = Date.now() - startedAt;
			if (
				message.stopReason === "error" ||
				message.stopReason === "aborted" ||
				message.stopReason === "pending"
			) {
				return {
					ok: false,
					latencyMs,
					error: redact(
						message.errorMessage?.trim() || "The model did not answer",
					),
				};
			}
			return { ok: true, latencyMs };
		} catch (error) {
			return {
				ok: false,
				latencyMs: Date.now() - startedAt,
				error: redact(errorMessage(error)),
			};
		}
	}

	async getHistory(sessionId?: string): Promise<ChatMessage[]> {
		await this.ready();
		const session = this.harness.session(normalizeSessionId(sessionId));
		const entries = await session.messages();
		return toChatMessages(entries.slice(-HISTORY_LIMIT));
	}

	async resetChat(sessionId?: string): Promise<{ ok: true }> {
		await this.ready();
		const session = this.harness.session(normalizeSessionId(sessionId));
		await session.abort().catch(() => undefined);
		await session.reset();
		this.appliedModels.delete(session.id);
		return { ok: true };
	}

	async streamChat(
		sessionId: string | undefined,
		prompt: string,
	): Promise<ReadableStream<Uint8Array>> {
		await this.ready();
		const id = normalizeSessionId(sessionId);
		if (typeof prompt !== "string" || !prompt.trim()) {
			fail("bad_request", "Prompt is required");
		}
		if (prompt.length > MAX_PROMPT_CHARS) {
			fail("bad_request", `Prompt must be at most ${MAX_PROMPT_CHARS} characters`);
		}

		const session = this.harness.session(id);
		await this.applyActiveModel(session);

		const operationId = crypto.randomUUID();
		try {
			await session.submit(prompt, { operationId, whenBusy: "reject" });
		} catch (error) {
			const message = errorMessage(error);
			if (/busy/i.test(message)) {
				fail("conflict", "The assistant is already answering another message");
			}
			fail("internal", `Failed to submit the prompt: ${message}`);
		}

		const watch = await session.watch({ min: 1, max: 100 });
		return createSseStream(session, watch, operationId);
	}

	async askOnce(
		prompt: string,
	): Promise<{ text: string; ok: boolean; reason?: string }> {
		await this.ready();
		if (typeof prompt !== "string" || !prompt.trim()) {
			fail("bad_request", "Prompt is required");
		}
		if (prompt.length > MAX_PROMPT_CHARS) {
			fail("bad_request", `Prompt must be at most ${MAX_PROMPT_CHARS} characters`);
		}

		const session = this.harness.session();
		await this.applyActiveModel(session);
		try {
			const result = await session.prompt(prompt, { whenBusy: "reject" });
			return {
				text: result.text ?? "",
				ok: result.status === "done",
				reason: result.reason,
			};
		} catch (error) {
			if (/busy/i.test(errorMessage(error))) {
				fail("conflict", "The assistant is already answering another message");
			}
			throw error;
		}
	}
}
