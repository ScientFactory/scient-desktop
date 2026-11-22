import { describe, expect, it } from "vite-plus/test";

import { m, type MessageResolver } from "~/i18n/messages";

import { computeLanguageGroupTitle, computeRuntimeText } from "./computeContractCopy";

describe("computeContractCopy", () => {
  it("keeps the contract's English and leaves unknown words as sent", () => {
    expect(computeLanguageGroupTitle("Most used")).toBe("Most used");
    expect(computeLanguageGroupTitle("A new group")).toBe("A new group");
    expect(computeRuntimeText("Not found")).toBe("Not found");
    expect(computeRuntimeText("3.14.6 · Homebrew")).toBe("3.14.6 · Homebrew");
    expect(computeRuntimeText("clang · Xcode tools")).toBe("clang · Xcode tools");
    expect(computeRuntimeText("constructor")).toBe("constructor");
  });

  it("translates the known words of a runtime line one by one", () => {
    const resolve = ((message: string) => `[${m(message)}]`) as MessageResolver;
    expect(computeRuntimeText("Ready", resolve)).toBe("[Ready]");
    expect(computeRuntimeText("3.14.6 · System", resolve)).toBe("3.14.6 · [System]");
    expect(computeRuntimeText("Server-reported failure", resolve)).toBe("Server-reported failure");
    expect(computeLanguageGroupTitle("Mathematics", resolve)).toBe("[Mathematics]");
  });
});
