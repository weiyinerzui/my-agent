export interface EncryptedSecret {
	v: 1;
	iv: string;
	ct: string;
}

export interface StoredProfile {
	id: string;
	name: string;
	baseUrl: string;
	modelId: string;
	apiKey?: EncryptedSecret;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	createdAt: number;
	updatedAt: number;
}

export interface StoredSettings {
	version: 1;
	profiles: StoredProfile[];
	activeProfileId: string | null;
}

export interface PublicProfile {
	id: string;
	name: string;
	baseUrl: string;
	modelId: string;
	hasApiKey: boolean;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	createdAt: number;
	updatedAt: number;
	active: boolean;
}

export interface PublicConfig {
	profiles: PublicProfile[];
	activeProfileId: string | null;
	encryptionReady: boolean;
	model: { provider: string; id: string } | null;
}

export interface ProfileInput {
	id?: string;
	name?: string;
	baseUrl?: string;
	modelId?: string;
	apiKey?: string | null;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

export interface ValidatedProfileInput {
	id: string;
	name: string;
	baseUrl: string;
	modelId: string;
	apiKey?: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
}

export interface TestProfileResult {
	ok: boolean;
	latencyMs?: number;
	error?: string;
}
