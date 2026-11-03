import { describe, expect, it } from "vite-plus/test";
import {
  compareManagedRuntimeReleases,
  compareManagedRuntimeVersions,
  isManagedRuntimeUpdate,
  isValidManagedRuntimeSupersedes,
  MAX_CURSOR_SUPERSEDES,
  parseManagedCursorVersion,
} from "./managedRuntimeVersion.ts";

const a = "2026.10.01-14929f9";
const b = "2026.10.01-e373342";

describe("qualified Cursor release order", () => {
  it("keeps vendor hash order unknown and uses only an explicit qualified relation", () => {
    expect(compareManagedRuntimeVersions({ provider: "cursor", current: a, candidate: b })).toBe(
      "unknown",
    );
    expect(
      compareManagedRuntimeReleases({
        provider: "cursor",
        current: { version: a },
        candidate: { version: b, supersedes: [a] },
      }),
    ).toBe("newer");
    expect(
      compareManagedRuntimeReleases({
        provider: "cursor",
        current: { version: b, supersedes: [a] },
        candidate: { version: a },
      }),
    ).toBe("older");
    expect(
      compareManagedRuntimeReleases({
        provider: "cursor",
        current: { version: a, supersedes: [b] },
        candidate: { version: b, supersedes: [a] },
      }),
    ).toBe("unknown");
  });

  it.each(
    [
      [a],
      ["2026.09.30-abcdef1"],
      [b, b],
      ["2026.02.31-abcdef1"],
      [null],
      "invalid",
      Array.from(
        { length: MAX_CURSOR_SUPERSEDES + 1 },
        (_, i) => `2026.10.01-${i.toString(16).padStart(7, "0")}`,
      ),
    ].map((supersedes) => ({ supersedes })),
  )("rejects invalid ancestry %j", ({ supersedes }) => {
    expect(isValidManagedRuntimeSupersedes("cursor", a, supersedes)).toBe(false);
  });

  it("does not let ordering metadata change another provider or an ordinary date comparison", () => {
    expect(isValidManagedRuntimeSupersedes("codex", "1.0.0", ["0.9.0"])).toBe(false);
    expect(
      compareManagedRuntimeReleases({
        provider: "codex",
        current: { version: "1.1.0" },
        candidate: { version: "1.0.0", supersedes: ["1.1.0"] },
      }),
    ).toBe("older");
    expect(
      compareManagedRuntimeReleases({
        provider: "cursor",
        current: { version: b },
        candidate: { version: "2026.09.30-abcdef1", supersedes: [b] },
      }),
    ).toBe("older");
    expect(parseManagedCursorVersion(`Cursor Agent ${b}\n`)).toBe(b);
    expect(parseManagedCursorVersion("2026.02.31-abcdef1")).toBeUndefined();
  });

  it("preserves antisymmetry and skipped-release order over all bounded same-day transitions", () => {
    const releases = Array.from({ length: MAX_CURSOR_SUPERSEDES + 1 }, (_, i) => {
      const version = `2026.10.01-${i.toString(16).padStart(7, "0")}`;
      return {
        version,
        supersedes: Array.from(
          { length: i },
          (_, j) => `2026.10.01-${j.toString(16).padStart(7, "0")}`,
        ),
      };
    });
    for (let i = 0; i < releases.length; i++) {
      expect(
        isValidManagedRuntimeSupersedes("cursor", releases[i]!.version, releases[i]!.supersedes),
      ).toBe(true);
      for (let j = 0; j < releases.length; j++) {
        expect(
          compareManagedRuntimeReleases({
            provider: "cursor",
            current: releases[i]!,
            candidate: releases[j]!,
          }),
        ).toBe(j === i ? "equal" : j > i ? "newer" : "older");
      }
    }
  });
});

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
