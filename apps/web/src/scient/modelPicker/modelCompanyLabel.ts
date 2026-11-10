import type { ProviderDriverKind } from "@t3tools/contracts";

const COMPANY_BY_SOURCE: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  "openai-codex": "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "google-antigravity": "Google",
  "google-gemini-cli": "Google",
  "google-vertex": "Google",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub",
  "amazon-bedrock": "Amazon",
  xai: "xAI",
  groq: "Groq",
  mistral: "Mistral",
  cerebras: "Cerebras",
  deepseek: "DeepSeek",
};

export function modelCompanyLabel(input: {
  subProvider?: string | undefined;
  driverKind: ProviderDriverKind;
  providerDisplayName: string;
}): string {
  const source = input.subProvider?.trim();
  if (source) {
    const key = source.toLowerCase();
    return Object.hasOwn(COMPANY_BY_SOURCE, key) ? COMPANY_BY_SOURCE[key]! : source;
  }
  switch (input.driverKind) {
    case "codex":
      return "OpenAI";
    case "claudeAgent":
      return "Anthropic";
    case "antigravity":
      return "Google";
    default:
      return input.providerDisplayName;
  }
}
