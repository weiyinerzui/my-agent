import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface StoredSettingsShape {
	profiles: Array<{
		apiKey?: { v: number; iv: string; ct: string };
	}>;
}

const BASE = "https://example.com";
const AUTH = { Authorization: "Bearer test-token" };

async function api(path, init = {}) {
	const headers = new Headers(init.headers || {});
	for (const [key, value] of Object.entries(AUTH)) headers.set(key, value);
	if (init.body) headers.set("Content-Type", "application/json");
	return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

describe("API routes", () => {
	it("rejects requests without a token", async () => {
		const response = await SELF.fetch(`${BASE}/api/config`);
		expect(response.status).toBe(401);
		const body = await response.json();
		expect(body.error.code).toBe("unauthorized");
	});

	it("rejects a wrong token", async () => {
		const response = await SELF.fetch(`${BASE}/api/config`, {
			headers: { Authorization: "Bearer nope" },
		});
		expect(response.status).toBe(401);
	});

	it("runs the configuration and chat lifecycle", async () => {
		const initial = await api("/api/config");
		expect(initial.status).toBe(200);
		const initialConfig = await initial.json();
		expect(initialConfig.profiles).toEqual([]);
		expect(initialConfig.activeProfileId).toBeNull();
		expect(initialConfig.encryptionReady).toBe(true);

		// Chat without an active profile is a clear conflict, not an empty answer.
		const noModel = await api("/api/chat", {
			method: "POST",
			body: JSON.stringify({ prompt: "hello" }),
		});
		expect(noModel.status).toBe(409);
		const noModelBody = await noModel.json();
		expect(noModelBody.error.code).toBe("conflict");
		expect(noModelBody.error.message).toMatch(/active model/i);

		const created = await api("/api/config/profiles", {
			method: "POST",
			body: JSON.stringify({
				name: "Test profile",
				baseUrl: "https://api.example.com/v1/",
				modelId: "test-model",
				apiKey: "test-api-key-one",
			}),
		});
		expect(created.status).toBe(200);
		const createdBody = await created.json();
		expect(createdBody.profile.hasApiKey).toBe(true);
		expect(createdBody.profile.baseUrl).toBe("https://api.example.com/v1");
		expect(JSON.stringify(createdBody)).not.toContain("test-api-key-one");
		expect(createdBody.profile).not.toHaveProperty("apiKey");
		expect(createdBody.profile).not.toHaveProperty("encryptedApiKey");
		expect(createdBody.profile).not.toHaveProperty("iv");
		expect(createdBody.profile).not.toHaveProperty("ct");

		const firstId = createdBody.profile.id;

		const stored = await runInDurableObject(
			env.Assistant.getByName("demo"),
			async (_instance, state) =>
				state.storage.get<StoredSettingsShape>("settings:v1"),
		);
		expect(stored?.profiles[0]?.apiKey?.v).toBe(1);
		expect(stored?.profiles[0]?.apiKey?.iv).toBeTruthy();
		expect(stored?.profiles[0]?.apiKey?.ct).toBeTruthy();
		expect(JSON.stringify(stored)).not.toContain("test-api-key-one");

		const config = await (await api("/api/config")).json();
		expect(config.activeProfileId).toBe(firstId);
		expect(JSON.stringify(config)).not.toContain("test-api-key-one");
		expect(config.model).toEqual({
			provider: `profile-${firstId}`,
			id: "test-model",
		});

		const second = await api("/api/config/profiles", {
			method: "POST",
			body: JSON.stringify({
				name: "Second",
				baseUrl: "https://api.example.com",
				modelId: "model-2",
				apiKey: "test-api-key-two",
			}),
		});
		expect(second.status).toBe(200);
		const secondId = (await second.json()).profile.id;

		const activated = await api(
			`/api/config/profiles/${secondId}/activate`,
			{ method: "POST" },
		);
		expect(activated.status).toBe(200);
		expect((await activated.json()).config.activeProfileId).toBe(secondId);

		const updated = await api("/api/config/profiles", {
			method: "POST",
			body: JSON.stringify({ id: firstId, name: "Renamed" }),
		});
		expect(updated.status).toBe(200);
		const updatedProfile = (await updated.json()).profile;
		expect(updatedProfile.name).toBe("Renamed");
		expect(updatedProfile.hasApiKey).toBe(true);

		const missing = await api("/api/config/profiles/does-not-exist", {
			method: "DELETE",
		});
		expect(missing.status).toBe(404);

		const deleted = await api(`/api/config/profiles/${secondId}`, {
			method: "DELETE",
		});
		expect(deleted.status).toBe(200);

		const afterDelete = await (await api("/api/config")).json();
		expect(afterDelete.activeProfileId).toBe(firstId);

		const history = await (await api("/api/chat/history")).json();
		expect(history.messages).toEqual([]);

		const reset = await api("/api/chat/reset", { method: "POST" });
		expect(reset.status).toBe(200);
	});
});
