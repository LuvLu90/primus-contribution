// Every built-in provider catalog. Add new providers here.

import type { ProviderDefinition } from "../define.ts";
import anthropic from "./anthropic.ts";
import openai from "./openai.ts";

// Primus: only the anthropic (Anthropic Messages) and openai (OpenAI Responses) providers are built in.
export const PROVIDERS: readonly ProviderDefinition[] = [anthropic, openai];
