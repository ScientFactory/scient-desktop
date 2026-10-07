import { describe, expect, it } from "vite-plus/test";
import { NodeId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { hasProviderActivity } from "./ProviderActivity.ts";

const codex = ProviderDriverKind.make("codex");
const omp = ProviderDriverKind.make("omp");
const first = ProviderInstanceId.make("codex-first");
const second = ProviderInstanceId.make("codex-second");
const other = ProviderInstanceId.make("omp-instance");
const idle = {
  provider: codex,
  driverByInstance: new Map([
    [first, codex],
    [second, codex],
    [other, omp],
  ]),
  runs: [],
  sessions: [],
  threads: [],
} satisfies Parameters<typeof hasProviderActivity>[0];

describe("V2 provider runtime activity", () => {
  it("guards both instances of a driver without blocking another driver", () => {
    expect(
      hasProviderActivity({ ...idle, runs: [{ providerInstanceId: second, status: "running" }] }),
    ).toBe(true);
    expect(
      hasProviderActivity({ ...idle, runs: [{ providerInstanceId: other, status: "running" }] }),
    ).toBe(false);
  });

  it("guards preparing, starting, and waiting work before a native session exists", () => {
    for (const status of ["preparing", "starting", "waiting"] as const) {
      expect(hasProviderActivity({ ...idle, runs: [{ providerInstanceId: first, status }] })).toBe(
        true,
      );
    }
  });

  it("allows idle sessions and terminal runs", () => {
    for (const status of [
      "queued",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "rolled_back",
    ] as const) {
      expect(
        hasProviderActivity({
          ...idle,
          runs: [{ providerInstanceId: first, status }],
          sessions: [{ driver: codex, status: "ready" }],
        }),
      ).toBe(false);
    }
  });

  it("guards a native starting session even without a run", () => {
    expect(
      hasProviderActivity({ ...idle, sessions: [{ driver: codex, status: "starting" }] }),
    ).toBe(true);
  });

  it("guards background work owned by an older provider thread after the selected instance changes", () => {
    expect(
      hasProviderActivity({
        ...idle,
        runs: [{ providerInstanceId: other, status: "completed" }],
        threads: [
          {
            driver: codex,
            status: "idle",
            pendingBackgroundTasks: [{ kind: "subagent", taskId: NodeId.make("child") }],
          },
        ],
      }),
    ).toBe(true);
  });

  it("treats an unavailable instance with unsettled work as busy", () => {
    expect(
      hasProviderActivity({
        ...idle,
        runs: [{ providerInstanceId: ProviderInstanceId.make("removed"), status: "running" }],
      }),
    ).toBe(true);
  });
});
