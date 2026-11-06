import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker entry", () => {
	it("returns 401 for an unauthenticated API request", async () => {
		const response = await SELF.fetch("https://example.com/api/config");
		expect(response.status).toBe(401);
	});

	it("returns config for an authenticated request", async () => {
		const response = await SELF.fetch("https://example.com/api/config", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toHaveProperty("profiles");
		expect(body).toHaveProperty("activeProfileId");
	});
});
