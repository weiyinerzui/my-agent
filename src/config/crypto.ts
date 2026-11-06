import type { EncryptedSecret } from "./types";

const AES_GCM = { name: "AES-GCM", length: 256 } as const;
const IV_BYTES = 12;
const keyCache = new Map<string, Promise<CryptoKey>>();

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function sha256(value: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return new Uint8Array(digest);
}

async function deriveKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error("CONFIG_ENCRYPTION_KEY is not configured");

	let raw: Uint8Array | undefined;
	try {
		const decoded = fromBase64(secret.trim());
		if (decoded.length === 32) raw = decoded;
	} catch {
		// Not base64: fall through to the deterministic hash.
	}

	raw ??= await sha256(secret);
	return crypto.subtle.importKey("raw", raw, AES_GCM, false, [
		"encrypt",
		"decrypt",
	]);
}

export function importAesKey(secret: string): Promise<CryptoKey> {
	let key = keyCache.get(secret);
	if (!key) {
		key = deriveKey(secret);
		keyCache.set(secret, key);
	}
	return key;
}

export async function encryptSecret(
	plaintext: string,
	aad: string,
	secret: string,
): Promise<EncryptedSecret> {
	const key = await importAesKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv,
			additionalData: new TextEncoder().encode(aad),
		},
		key,
		new TextEncoder().encode(plaintext),
	);

	return {
		v: 1,
		iv: toBase64(iv),
		ct: toBase64(new Uint8Array(ciphertext)),
	};
}

export async function decryptSecret(
	encrypted: EncryptedSecret,
	aad: string,
	secret: string,
): Promise<string> {
	if (encrypted.v !== 1 || !encrypted.iv || !encrypted.ct) {
		throw new Error("Unsupported encrypted secret format");
	}

	const key = await importAesKey(secret);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: fromBase64(encrypted.iv),
			additionalData: new TextEncoder().encode(aad),
		},
		key,
		fromBase64(encrypted.ct),
	);

	return new TextDecoder().decode(plaintext);
}
