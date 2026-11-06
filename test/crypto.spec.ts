import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/config/crypto";

const SECRET = "unit-test-encryption-secret";

describe("config encryption", () => {
	it("round-trips a secret", async () => {
		const encrypted = await encryptSecret(
			"test-api-key-value",
			"profile:abc",
			SECRET,
		);
		expect(encrypted.v).toBe(1);
		expect(encrypted.iv).not.toBe("");
		expect(encrypted.ct).not.toContain("test-api-key-value");
		await expect(decryptSecret(encrypted, "profile:abc", SECRET)).resolves.toBe(
			"test-api-key-value",
		);
	});

	it("uses a fresh IV for each encryption", async () => {
		const first = await encryptSecret("same", "profile:abc", SECRET);
		const second = await encryptSecret("same", "profile:abc", SECRET);
		expect(first.iv).not.toBe(second.iv);
		expect(first.ct).not.toBe(second.ct);
	});

	it("rejects a different master key", async () => {
		const encrypted = await encryptSecret("secret", "profile:abc", SECRET);
		await expect(
			decryptSecret(encrypted, "profile:abc", "another-master-key"),
		).rejects.toThrow();
	});

	it("binds ciphertext to its AAD", async () => {
		const encrypted = await encryptSecret("secret", "profile:abc", SECRET);
		await expect(
			decryptSecret(encrypted, "profile:other", SECRET),
		).rejects.toThrow();
	});

	it("rejects tampered ciphertext", async () => {
		const encrypted = await encryptSecret("secret", "profile:abc", SECRET);
		const tampered = {
			...encrypted,
			ct: `${encrypted.ct.slice(0, -2)}AA`,
		};
		await expect(
			decryptSecret(tampered, "profile:abc", SECRET),
		).rejects.toThrow();
	});
});
