import { describe, expect, it } from "vite-plus/test";
import {
  compareManagedRuntimeReleases,
  compareManagedRuntimeVersions,
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
