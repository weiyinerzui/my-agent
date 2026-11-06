import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	normalizeBaseUrl,
	validateProfileInput,
} from "../src/config/store";

describe("base URL validation", () => {
	it("keeps a path prefix and strips trailing slashes", () => {
		expect(normalizeBaseUrl("https://api.openai.com/v1/")).toBe(
			"https://api.openai.com/v1",
		);
		expect(normalizeBaseUrl("  https://api.deepseek.com  ")).toBe(
			"https://api.deepseek.com",
		);
	});

	it("rejects non-http protocols", () => {
		expect(() => normalizeBaseUrl("ftp://example.com")).toThrow();
		expect(() => normalizeBaseUrl("file:///etc/passwd")).toThrow();
	});

	it("rejects credentials, query strings and fragments", () => {
		expect(() => normalizeBaseUrl("https://user:pass@example.com")).toThrow();
		expect(() => normalizeBaseUrl("https://example.com/v1?x=1")).toThrow();
		expect(() => normalizeBaseUrl("https://example.com/v1#x")).toThrow();
	});

	it("rejects local and private targets", () => {
		for (const url of [
			"http://localhost:11434/v1",
			"http://127.0.0.1:8080/v1",
			"http://10.0.0.2/v1",
			"http://192.168.1.10/v1",
			"http://169.254.169.254/latest",
			"http://[::1]:8080/v1",
			"http://[::ffff:127.0.0.1]/v1",
			"http://2130706433/v1",
			"http://0x7f000001/v1",
		]) {
			expect(() => normalizeBaseUrl(url), url).toThrow();
		}
	});
});

describe("profile validation", () => {
	it("applies defaults and generates an id", () => {
		const value = validateProfileInput({
			name: "  Test  ",
			baseUrl: "https://example.com/v1/",
			modelId: "model-a",
		});
		expect(value.id).toMatch(/[0-9a-f-]{36}/);
		expect(value.name).toBe("Test");
		expect(value.baseUrl).toBe("https://example.com/v1");
		expect(value.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(value.maxTokens).toBe(DEFAULT_MAX_TOKENS);
		expect(value.reasoning).toBe(false);
	});

	it("requires the core fields", () => {
		expect(() => validateProfileInput({})).toThrow(/Name/);
		expect(() =>
			validateProfileInput({ name: "x", baseUrl: "https://example.com" }),
		).toThrow(/Model ID/);
	});

	it("bounds the token settings", () => {
		expect(() =>
			validateProfileInput({
				name: "x",
				baseUrl: "https://example.com",
				modelId: "m",
				contextWindow: 4096,
				maxTokens: 8192,
			}),
		).toThrow(/must not exceed/);
	});

	it("keeps the existing id and key when updating", () => {
		const value = validateProfileInput(
			{ id: "old", name: "Renamed" },
			{
				id: "old",
				name: "Old",
				baseUrl: "https://example.com/v1",
				modelId: "model-a",
				reasoning: true,
				contextWindow: 64000,
				maxTokens: 4096,
				createdAt: 1,
				updatedAt: 2,
			},
		);
		expect(value.id).toBe("old");
		expect(value.name).toBe("Renamed");
		expect(value.baseUrl).toBe("https://example.com/v1");
		expect(value.modelId).toBe("model-a");
		expect(value.contextWindow).toBe(64000);
	});
});
