import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import type { StoredProfile } from "./types";

export function providerIdFor(profileId: string): string {
	return `profile-${profileId}`;
}

export function buildProvider(profile: StoredProfile, apiKey: string): Provider {
	return createProvider({
		id: providerIdFor(profile.id),
		name: profile.name,
		baseUrl: profile.baseUrl,
		auth: {
			apiKey: {
				name: `${profile.name} API key`,
				resolve: async () =>
					apiKey
						? {
								auth: { apiKey },
								source: `profile:${profile.id}`,
							}
						: undefined,
			},
		},
		models: [
			{
				id: profile.modelId,
				name: profile.modelId,
				api: "openai-completions",
				provider: providerIdFor(profile.id),
				baseUrl: profile.baseUrl,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: profile.contextWindow,
				maxTokens: profile.maxTokens,
				reasoning: profile.reasoning,
			},
		],
		api: openAICompletionsApi(),
	});
}
