/**
 * Abstract LLM provider interface.
 * Each provider adapts a specific LLM SDK to this common interface.
 */
export interface LLMProvider {
  /** Human-readable provider identifier (matches ProviderName). */
  readonly name: string;
  /** Model id actually in use (resolved default if the caller didn't pick one). */
  readonly model: string;
  /** Generate a response from the LLM */
  generate(systemPrompt: string, userPrompt: string): Promise<string>;
}

export type ProviderName = "anthropic" | "openai" | "google" | "ollama";

/**
 * Create a provider instance.
 * For cloud providers, `credential` is the API key.
 * For ollama, `credential` is the optional host URL.
 */
export async function createProvider(
  name: ProviderName,
  credential?: string,
  model?: string,
): Promise<LLMProvider> {
  switch (name) {
    case "anthropic": {
      const { AnthropicProvider } = await import("./anthropic.js");
      return new AnthropicProvider(credential ?? "", model);
    }
    case "openai": {
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider(credential ?? "", model);
    }
    case "google": {
      const { GoogleProvider } = await import("./google.js");
      return new GoogleProvider(credential ?? "", model);
    }
    case "ollama": {
      const { OllamaProvider } = await import("./ollama.js");
      return new OllamaProvider(credential, model);
    }
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}
