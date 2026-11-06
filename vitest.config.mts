import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					AUTH_TOKEN: "test-token",
					CONFIG_ENCRYPTION_KEY: "vitest-only-encryption-key",
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.spec.ts"],
	},
});
