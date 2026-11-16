import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";

/**
 * Registers OAuth flow loaders with literal dynamic imports, for Node bundles
 * that split at dynamic imports (esbuild `splitting`, Chord's worker base):
 * each flow lands in a chunk loaded on its first use, inside the bundle.
 * Without it, pi-ai imports the flows through a variable specifier that
 * bundlers cannot follow, so a bundle loads them from pi-ai's own files.
 * Browser bundles must not import this module (the flows are Node-only).
 */
// Primus: only the Anthropic and OpenAI (ChatGPT) OAuth flows are built in.
export function registerLazyOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: async () => (await import("./auth/oauth/anthropic.ts")).anthropicOAuth,
		openaiChatGPT: async () => (await import("./auth/oauth/openai-chatgpt.ts")).openaiChatGPTOAuth,
	});
}
