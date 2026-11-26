import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { poolSources, resolveThreadDetailsLimits } from "./ThreadDetailsUsage.logic";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const antigravity = ProviderDriverKind.make("antigravity");
const hubOrigin = "http://127.0.0.1:8317";
const routedId = ProviderInstanceId.make("antigravity");

function gemini(usedPercent: number, checkedAt: string, fingerprint: string) {
  return {
    checkedAt,
    credentialFingerprint: fingerprint,
    windows: [
      {
        id: "gemini-5h",
        kind: "session" as const,
        label: "Gemini · 5-hour",
        usedPercent,
        windowDurationMins: 300,
        resetsAt: "2026-10-30T13:17:00.000Z",
      },
    ],
  } satisfies ServerProviderUsageLimits;
}

function instance(
  instanceId: ProviderInstanceId,
  usageLimits: ServerProviderUsageLimits,
  endpoint?: string,
): ServerProvider {
  return {
    instanceId,
    driver: antigravity,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", ...(endpoint ? { endpoint } : {}) },
    checkedAt: usageLimits.checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

const hub = (limits: ServerProviderUsageLimits): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("Hub"),
  kind: "cliproxy",
  label: "Hub",
  origin: hubOrigin,
  checkedAt: limits.checkedAt,
  accounts: [{ id: "agy.json", driver: antigravity, usageLimits: limits }],
});

describe("thread details pool for a hub-routed Antigravity instance", () => {
  // The routed instance reads nothing itself; its hub reads the Google account.
  const routed = instance(
    routedId,
    { checkedAt: "2026-10-30T11:59:00.000Z", windows: [], unavailable: { reason: "unsupported" } },
    hubOrigin,
  );
  const hubReading = gemini(80, "2026-10-30T11:50:00.000Z", "fp-google-1");

  it("uses another local login's fresher reading of the same Google account", () => {
    const local = instance(
      ProviderInstanceId.make("antigravity_local"),
      gemini(30, "2026-10-30T11:59:00.000Z", "fp-google-1"),
    );
    const resolved = resolveThreadDetailsLimits(
      routedId,
      "gemini-3.1-pro",
      [routed, local],
      [hub(hubReading)],
      now,
    );
    expect(resolved?.kind).toBe("pool");
    if (resolved?.kind !== "pool") return;
    expect(resolved.windows.map((window) => window.remainingPercent)).toEqual([70]);
    expect(resolved.windows.map(poolSources)).toEqual([{ hubs: [], signedIn: true }]);
  });

  it("keeps only the quotas the thread's model spends from the local reading", () => {
    const argonHub: ServerProviderUsageLimits = {
      checkedAt: "2026-10-30T11:50:00.000Z",
      credentialFingerprint: "fp-google-1",
      windows: [
        { ...gemini(80, "", "").windows[0]!, id: "gemini-argon-5h", label: "Argon" },
        { ...gemini(10, "", "").windows[0]!, id: "gemini-carbon-5h", label: "Carbon" },
      ],
    };
    const local = instance(ProviderInstanceId.make("antigravity_local"), {
      checkedAt: "2026-10-30T11:59:00.000Z",
      credentialFingerprint: "fp-google-1",
      windows: [
        { ...gemini(30, "", "").windows[0]!, id: "gemini-argon-5h", label: "Argon" },
        { ...gemini(50, "", "").windows[0]!, id: "gemini-carbon-5h", label: "Carbon" },
        { ...gemini(60, "", "").windows[0]!, id: "3p-5h", label: "Claude & GPT" },
      ],
    });
    const resolved = resolveThreadDetailsLimits(
      routedId,
      "gemini-4-argon-high",
      [routed, local],
      [hub(argonHub)],
      now,
    );
    if (resolved?.kind !== "pool") throw new Error("expected a pool");
    expect(resolved.windows.map((window) => [window.label, window.remainingPercent])).toEqual([
      ["Argon", 70],
    ]);
  });

  it("keeps the hub reading when the local login is another Google account", () => {
    const other = instance(
      ProviderInstanceId.make("antigravity_local"),
      gemini(30, "2026-10-30T11:59:00.000Z", "fp-google-2"),
    );
    const resolved = resolveThreadDetailsLimits(
      routedId,
      "gemini-3.1-pro",
      [routed, other],
      [hub(hubReading)],
      now,
    );
    if (resolved?.kind !== "pool") throw new Error("expected a pool");
    expect(resolved.windows.map((window) => window.remainingPercent)).toEqual([20]);
    expect(resolved.windows.map(poolSources)).toEqual([{ hubs: ["Hub"], signedIn: false }]);
  });
});
