import { describe, expect, it } from "vite-plus/test";

import { compareManagedRuntimeVersions, isManagedRuntimeUpdate } from "./managedRuntimeVersion.ts";

describe("managed runtime version policy", () => {
  it("offers only provably newer semantic versions", () => {
    expect(
      compareManagedRuntimeVersions({
        provider: "codex",
        current: "0.149.1",
        candidate: "0.150.0",
      }),
    ).toBe("newer");
    expect(
      compareManagedRuntimeVersions({ provider: "grok", current: "1.0.5", candidate: "1.0.4" }),
    ).toBe("older");
    expect(
      compareManagedRuntimeVersions({
        provider: "droid",
        current: "0.203.0",
        candidate: "0.203.0",
      }),
    ).toBe("equal");
  });

  it("fails closed for malformed semantic versions", () => {
    expect(
      compareManagedRuntimeVersions({
        provider: "claudeAgent",
        current: "2.1.245",
        candidate: "latest",
      }),
    ).toBe("unknown");
    expect(
      isManagedRuntimeUpdate({ provider: "claudeAgent", current: null, candidate: "2.1.246" }),
    ).toBe(false);
  });

  it("orders Cursor releases by date and rejects same-date hash guesses", () => {
    expect(
      compareManagedRuntimeVersions({
        provider: "cursor",
        current: "2026.08.11-e8db854",
        candidate: "2026.08.12-a123456",
      }),
    ).toBe("newer");
    expect(
      compareManagedRuntimeVersions({
        provider: "cursor",
        current: "2026.08.11-e8db854",
        candidate: "2026.08.11-a123456",
      }),
    ).toBe("unknown");
    expect(
      compareManagedRuntimeVersions({
        provider: "cursor",
        current: "2026.08.11-e8db854",
        candidate: "2026.99.99-a123456",
      }),
    ).toBe("unknown");
  });
});
