import { describe, expect, it } from "vite-plus/test";

import { m, type MessageResolver } from "~/i18n/messages";

import { providerStatusMessageText } from "./providerStatusMessageCopy";

describe("providerStatusMessageText", () => {
  const resolve = ((message: string) => `[${m(message)}]`) as MessageResolver;

  it("translates a status line Scient knows", () => {
    const message =
      "Scient Agent has no models yet. Sign in to a model account, add a custom model in Settings, or start a local model server such as Ollama.";
    expect(providerStatusMessageText(message)).toBe(message);
    expect(providerStatusMessageText(message, resolve)).toBe(`[${message}]`);
  });

  it("leaves any other server text as sent", () => {
    expect(providerStatusMessageText("Codex CLI exited with code 1.", resolve)).toBe(
      "Codex CLI exited with code 1.",
    );
  });
});
