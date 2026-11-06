import { fail } from "./errors";
import type {
	ProfileInput,
	PublicConfig,
	PublicProfile,
	StoredProfile,
	StoredSettings,
	ValidatedProfileInput,
} from "./types";

export const SETTINGS_KEY = "settings:v1";
export const MAX_PROFILES = 20;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

const MAX_NAME = 60;
const MAX_BASE_URL = 500;
const MAX_MODEL_ID = 200;
const MAX_API_KEY = 8_192;

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"metadata",
	"metadata.google.internal",
	"instance-data",
]);

function isBlockedHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

	if (BLOCKED_HOSTNAMES.has(host)) return true;
	if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return true;
	}
	if (host === "::" || host === "::1") return true;
	if (host.startsWith("fc") || host.startsWith("fd")) return true;
	if (host.startsWith("fe80")) return true;
	if (host.startsWith("::ffff:")) {
		const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (!mapped) return true;
		const high = Number.parseInt(mapped[1], 16);
		const low = Number.parseInt(mapped[2], 16);
		return isBlockedIpv4(
			`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
		);
	}
	return isBlockedIpv4(host);
}

function isBlockedIpv4(host: string): boolean {
	const parts = host.split(".");
	if (parts.length !== 4) return false;
	const octets = parts.map((part) => {
		if (!/^\d{1,3}$/.test(part)) return Number.NaN;
		return Number(part);
	});
	if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
		return false;
	}
	const [a, b] = octets;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a >= 224) return true;
	return false;
}

export function normalizeBaseUrl(raw: unknown): string {
	if (typeof raw !== "string") fail("bad_request", "Base URL is required");
	const trimmed = raw.trim();
	if (!trimmed) fail("bad_request", "Base URL is required");
	if (trimmed.length > MAX_BASE_URL) {
		fail("bad_request", `Base URL must be at most ${MAX_BASE_URL} characters`);
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		fail("bad_request", "Base URL is not a valid URL");
	}

	if (url.protocol !== "https:" && url.protocol !== "http:") {
		fail("bad_request", "Base URL must start with http:// or https://");
	}
	if (url.username || url.password) {
		fail("bad_request", "Base URL must not include credentials");
	}
	if (url.search || url.hash) {
		fail("bad_request", "Base URL must not include a query string or fragment");
	}
	if (isBlockedHostname(url.hostname)) {
		fail("bad_request", "Base URL points to a local or private address");
	}

	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path}`;
}

function asTrimmedString(
	value: unknown,
	field: string,
	max: number,
	required: boolean,
): string | undefined {
	if (value === undefined || value === null) {
		if (required) fail("bad_request", `${field} is required`);
		return undefined;
	}
	if (typeof value !== "string") fail("bad_request", `${field} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) {
		if (required) fail("bad_request", `${field} is required`);
		return undefined;
	}
	if (trimmed.length > max) {
		fail("bad_request", `${field} must be at most ${max} characters`);
	}
	return trimmed;
}

function asInteger(
	value: unknown,
	field: string,
	fallback: number,
	min: number,
	max: number,
): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		fail("bad_request", `${field} must be an integer`);
	}
	if (value < min || value > max) {
		fail("bad_request", `${field} must be between ${min} and ${max}`);
	}
	return value;
}

export function validateProfileInput(
	input: ProfileInput,
	existing?: StoredProfile,
): ValidatedProfileInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		fail("bad_request", "Invalid request body");
	}

	const name =
		asTrimmedString(input.name, "Name", MAX_NAME, !existing) ?? existing?.name;
	if (!name) fail("bad_request", "Name is required");

	const baseUrl =
		input.baseUrl === undefined
			? existing?.baseUrl
			: normalizeBaseUrl(input.baseUrl);
	if (!baseUrl) fail("bad_request", "Base URL is required");

	const modelId =
		asTrimmedString(input.modelId, "Model ID", MAX_MODEL_ID, !existing) ??
		existing?.modelId;
	if (!modelId) fail("bad_request", "Model ID is required");
	if (/[\u0000-\u001f\u007f]/.test(modelId)) {
		fail("bad_request", "Model ID contains invalid characters");
	}

	let apiKey: string | undefined;
	if (input.apiKey !== undefined) {
		if (input.apiKey !== null && typeof input.apiKey !== "string") {
			fail("bad_request", "API key must be a string");
		}
		const trimmed = (input.apiKey ?? "").trim();
		if (/[\r\n\u0000]/.test(trimmed)) {
			fail("bad_request", "API key contains invalid characters");
		}
		if (trimmed.length > MAX_API_KEY) {
			fail("bad_request", `API key must be at most ${MAX_API_KEY} characters`);
		}
		apiKey = trimmed || undefined;
	}

	const contextWindow = asInteger(
		input.contextWindow,
		"Context window",
		existing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		1_024,
		2_000_000,
	);
	const maxTokens = asInteger(
		input.maxTokens,
		"Max tokens",
		existing?.maxTokens ?? DEFAULT_MAX_TOKENS,
		1,
		131_072,
	);
	if (maxTokens > contextWindow) {
		fail("bad_request", "Max tokens must not exceed the context window");
	}

	const reasoning =
		input.reasoning === undefined
			? (existing?.reasoning ?? false)
			: Boolean(input.reasoning);

	return {
		id: existing?.id ?? crypto.randomUUID(),
		name,
		baseUrl,
		modelId,
		apiKey,
		reasoning,
		contextWindow,
		maxTokens,
	};
}

function isEncryptedSecret(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const secret = value as Record<string, unknown>;
	return (
		secret.v === 1 &&
		typeof secret.iv === "string" &&
		Boolean(secret.iv) &&
		typeof secret.ct === "string" &&
		Boolean(secret.ct)
	);
}

function parseProfile(value: unknown): StoredProfile | undefined {
	if (!value || typeof value !== "object") return undefined;
	const profile = value as Record<string, unknown>;
	if (
		typeof profile.id !== "string" ||
		typeof profile.name !== "string" ||
		typeof profile.baseUrl !== "string" ||
		typeof profile.modelId !== "string"
	) {
		return undefined;
	}
	return {
		id: profile.id,
		name: profile.name,
		baseUrl: profile.baseUrl,
		modelId: profile.modelId,
		apiKey: isEncryptedSecret(profile.apiKey)
			? (profile.apiKey as StoredProfile["apiKey"])
			: undefined,
		reasoning: Boolean(profile.reasoning),
		contextWindow:
			typeof profile.contextWindow === "number"
				? profile.contextWindow
				: DEFAULT_CONTEXT_WINDOW,
		maxTokens:
			typeof profile.maxTokens === "number"
				? profile.maxTokens
				: DEFAULT_MAX_TOKENS,
		createdAt:
			typeof profile.createdAt === "number" ? profile.createdAt : Date.now(),
		updatedAt:
			typeof profile.updatedAt === "number" ? profile.updatedAt : Date.now(),
	};
}

export async function readSettings(
	storage: DurableObjectStorage,
): Promise<StoredSettings> {
	const stored = await storage.get<unknown>(SETTINGS_KEY);
	if (!stored || typeof stored !== "object") {
		return { version: 1, profiles: [], activeProfileId: null };
	}

	const raw = stored as Record<string, unknown>;
	const profiles = Array.isArray(raw.profiles)
		? raw.profiles
				.map(parseProfile)
				.filter((profile): profile is StoredProfile => Boolean(profile))
				.slice(0, MAX_PROFILES)
		: [];
	const activeProfileId =
		typeof raw.activeProfileId === "string" &&
		profiles.some((profile) => profile.id === raw.activeProfileId)
			? raw.activeProfileId
			: null;

	return { version: 1, profiles, activeProfileId };
}

export async function writeSettings(
	storage: DurableObjectStorage,
	settings: StoredSettings,
): Promise<void> {
	await storage.put(SETTINGS_KEY, settings);
}

export function toPublicProfile(
	profile: StoredProfile,
	activeProfileId: string | null,
): PublicProfile {
	return {
		id: profile.id,
		name: profile.name,
		baseUrl: profile.baseUrl,
		modelId: profile.modelId,
		hasApiKey: Boolean(profile.apiKey),
		reasoning: profile.reasoning,
		contextWindow: profile.contextWindow,
		maxTokens: profile.maxTokens,
		createdAt: profile.createdAt,
		updatedAt: profile.updatedAt,
		active: profile.id === activeProfileId,
	};
}

export function toPublicConfig(
	settings: StoredSettings,
	encryptionReady: boolean,
): PublicConfig {
	const active = settings.profiles.find(
		(profile) => profile.id === settings.activeProfileId,
	);
	return {
		profiles: settings.profiles.map((profile) =>
			toPublicProfile(profile, settings.activeProfileId),
		),
		activeProfileId: settings.activeProfileId,
		encryptionReady,
		model: active
			? { provider: `profile-${active.id}`, id: active.modelId }
			: null,
	};
}
