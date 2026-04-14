import type { LLMProvider } from "./index.js";

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly model: string;
  private baseUrl: string;

  constructor(host = "http://localhost:11434", model = "llama3.2:3b") {
    this.baseUrl = host.replace(/\/$/, "");
    this.model = model;
  }

  async generate(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { message?: { content?: string } };
    const text = data.message?.content;

    if (!text) {
      throw new Error("Empty response from Ollama");
    }
    return text;
  }
}
