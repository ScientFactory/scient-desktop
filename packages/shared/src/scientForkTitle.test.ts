import { describe, expect, it } from "vite-plus/test";

import { deriveForkTitle } from "./scientForkTitle.ts";

const ORIGIN = { id: "thread-origin", title: "Origin conversation" };

function derive(input: {
  readonly origin?: { readonly id: string; readonly title: string };
  readonly originHasForkLineage?: boolean;
  readonly projectThreads?: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}): string {
  return deriveForkTitle({
    origin: input.origin ?? ORIGIN,
    originHasForkLineage: input.originHasForkLineage ?? false,
    projectThreads: input.projectThreads ?? [ORIGIN],
  });
}

describe("deriveForkTitle", () => {
  it("numbers the first fork of a plain thread", () => {
    expect(derive({})).toBe("Origin conversation (2)");
  });

  it("skips suffixes already taken by sibling threads", () => {
    expect(
      derive({
        projectThreads: [
          ORIGIN,
          { id: "fork-a", title: "Origin conversation (2)" },
          { id: "fork-b", title: "Origin conversation (3)" },
        ],
      }),
    ).toBe("Origin conversation (4)");
  });

  it("fills the first free suffix gap", () => {
    expect(
      derive({
        projectThreads: [ORIGIN, { id: "fork-a", title: "Origin conversation (3)" }],
      }),
    ).toBe("Origin conversation (2)");
  });

  it("preserves meaningful numeric parentheticals in source titles", () => {
    expect(
      derive({
        origin: { id: "study", title: "Study (2024)" },
        projectThreads: [{ id: "study", title: "Study (2024)" }],
      }),
    ).toBe("Study (2024) (2)");
  });

  it("preserves a meaningful suffix on a renamed fork", () => {
    expect(
      derive({
        origin: { id: "fork-a", title: "Experiment (2024)" },
        originHasForkLineage: true,
        projectThreads: [ORIGIN, { id: "fork-a", title: "Experiment (2024)" }],
      }),
    ).toBe("Experiment (2024) (2)");
  });

  it("increments generated numbering when reforking", () => {
    expect(
      derive({
        origin: { id: "fork-a", title: "Origin conversation (2)" },
        originHasForkLineage: true,
        projectThreads: [ORIGIN, { id: "fork-a", title: "Origin conversation (2)" }],
      }),
    ).toBe("Origin conversation (3)");
  });

  it("keeps a numeric suffix when the origin is not a verified fork", () => {
    expect(
      derive({
        origin: { id: "fork-a", title: "Origin conversation (2)" },
        projectThreads: [ORIGIN, { id: "fork-a", title: "Origin conversation (2)" }],
      }),
    ).toBe("Origin conversation (2) (2)");
  });

  it("keeps a numeric suffix when the unsuffixed sibling is absent", () => {
    expect(
      derive({
        origin: { id: "fork-a", title: "Origin conversation (2)" },
        originHasForkLineage: true,
        projectThreads: [{ id: "fork-a", title: "Origin conversation (2)" }],
      }),
    ).toBe("Origin conversation (2) (2)");
  });

  it("uses a generic base for a blank origin title", () => {
    expect(
      derive({
        origin: { id: "blank", title: "   " },
        projectThreads: [{ id: "blank", title: "   " }],
      }),
    ).toBe("Fork (2)");
  });

  it("uses a deterministic id suffix when every number is taken", () => {
    const origin = { id: "thread-12345678", title: "Fork" };
    const projectThreads = [
      origin,
      ...Array.from({ length: 9_999 }, (_, index) => ({
        id: `taken-${index + 2}`,
        title: `Fork (${index + 2})`,
      })),
    ];
    expect(derive({ origin, projectThreads })).toBe("Fork (12345678)");
  });
});
