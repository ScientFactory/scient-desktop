import { describe, expect, it } from "vite-plus/test";

import { resolveComposerWorkingPlaceholder } from "./workingPlaceholder";

const baseInput = {
  isRunning: true,
  isMobileViewport: false,
  followUpBehavior: "queue" as const,
  sendShortcut: "enter" as const,
  prompt: "",
  isMacPlatform: true,
};

describe("resolveComposerWorkingPlaceholder", () => {
  it("returns null when the thread is not running", () => {
    expect(resolveComposerWorkingPlaceholder({ ...baseInput, isRunning: false })).toBeNull();
  });

  it("teaches queue/steer keys for the default Enter submit shortcut", () => {
    expect(resolveComposerWorkingPlaceholder(baseInput)).toBe(
      "Agent is working… Enter to queue, ⌘+Enter to steer",
    );
  });

  it("swaps the advertised actions when follow-up behavior is steer", () => {
    expect(resolveComposerWorkingPlaceholder({ ...baseInput, followUpBehavior: "steer" })).toBe(
      "Agent is working… Enter to steer, ⌘+Enter to queue",
    );
  });

  it("uses the Ctrl label off macOS", () => {
    expect(resolveComposerWorkingPlaceholder({ ...baseInput, isMacPlatform: false })).toBe(
      "Agent is working… Enter to queue, Ctrl+Enter to steer",
    );
  });

  it("advertises modifier-only keys when Enter alone never submits", () => {
    expect(resolveComposerWorkingPlaceholder({ ...baseInput, sendShortcut: "mod-enter" })).toBe(
      "Agent is working… ⌘+Enter to queue, ⇧⌘+Enter to steer",
    );
    expect(
      resolveComposerWorkingPlaceholder({
        ...baseInput,
        sendShortcut: "mod-enter",
        followUpBehavior: "steer",
      }),
    ).toBe("Agent is working… ⌘+Enter to steer, ⇧⌘+Enter to queue");
  });

  it("matches the mod-enter-multiline shortcut for single-line prompts", () => {
    expect(
      resolveComposerWorkingPlaceholder({
        ...baseInput,
        sendShortcut: "mod-enter-multiline",
        prompt: "single line",
      }),
    ).toBe("Agent is working… Enter to queue, ⌘+Enter to steer");
  });

  it("matches the mod-enter-multiline shortcut for multiline prompts", () => {
    expect(
      resolveComposerWorkingPlaceholder({
        ...baseInput,
        sendShortcut: "mod-enter-multiline",
        prompt: "first\nsecond",
      }),
    ).toBe("Agent is working… ⌘+Enter to queue, ⇧⌘+Enter to steer");
  });

  it("falls back to a short status line on mobile where Enter does not submit", () => {
    expect(resolveComposerWorkingPlaceholder({ ...baseInput, isMobileViewport: true })).toBe(
      "Agent is working…",
    );
  });
});
