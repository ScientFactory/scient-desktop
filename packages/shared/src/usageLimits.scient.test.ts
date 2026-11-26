import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { exhaustedUsageWindow, providersReadingAccounts } from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const checkedAt = "2026-09-03T11:59:00.000Z";
const antigravity = ProviderDriverKind.make("antigravity");

function quota(id: string, usedPercent: number) {
  return {
    id,
    kind: "session" as const,
    label: id,
    usedPercent,
    windowDurationMins: 300,
    resetsAt: "2026-09-03T14:00:00.000Z",
  };
}

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: antigravity,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const withWindows = (windows: ReturnType<typeof quota>[]) =>
  provider({ usageLimits: { checkedAt, windows } });

describe("Antigravity Gemini quotas", () => {
  const perFamily = withWindows([
    quota("gemini-5h", 20),
    quota("gemini-argon-5h", 10),
    quota("gemini-carbon-5h", 100),
  ]);

  it("a spent Carbon quota holds back only Carbon models", () => {
    expect(exhaustedUsageWindow(perFamily, now, "gemini-4-argon-high")).toBeUndefined();
    expect(exhaustedUsageWindow(perFamily, now, "gemini-3.1-pro")).toBeUndefined();
    expect(exhaustedUsageWindow(perFamily, now, "gemini-4-carbon")?.id).toBe("gemini-carbon-5h");
  });

  it("a spent default Gemini quota leaves Argon and Carbon models alone", () => {
    const spentDefault = withWindows([
      quota("gemini-5h", 100),
      quota("gemini-argon-5h", 10),
      quota("gemini-carbon-5h", 10),
    ]);
    expect(exhaustedUsageWindow(spentDefault, now, "gemini-4-argon-high")).toBeUndefined();
    expect(exhaustedUsageWindow(spentDefault, now, "gemini-3.1-pro")?.id).toBe("gemini-5h");
  });

  it("an older account's one Gemini quota still holds back every Gemini model", () => {
    const aggregate = withWindows([quota("gemini-quota", 100)]);
    expect(exhaustedUsageWindow(aggregate, now, "gemini-4-argon-high")?.id).toBe("gemini-quota");
    expect(exhaustedUsageWindow(aggregate, now, "gemini-4-carbon")?.id).toBe("gemini-quota");
  });

  it("Gemini quotas never hold back Claude or GPT models", () => {
    expect(exhaustedUsageWindow(perFamily, now, "claude-opus-5-5")).toBeUndefined();
  });
});

describe("providersReadingAccounts", () => {
  const hubAccount = (limits: Partial<ServerProviderUsageLimits>, email?: string) =>
    ({
      id: "agy.json",
      driver: antigravity,
      ...(email ? { email } : {}),
      usageLimits: { checkedAt, windows: [], ...limits },
    }) satisfies UsageLimitSourceAccount;
  const local = (instance: string, limits: Partial<ServerProviderUsageLimits>, email?: string) =>
    provider({
      instanceId: ProviderInstanceId.make(instance),
      auth: { status: "authenticated", ...(email ? { email } : {}) },
      usageLimits: { checkedAt, windows: [], ...limits },
    });

  it("matches a local login to a hub account by its Google credential fingerprint", () => {
    const same = local("agy-local", { credentialFingerprint: "fp-1" });
    const other = local("agy-other", { credentialFingerprint: "fp-2" });
    expect(
      providersReadingAccounts([same, other], [hubAccount({ credentialFingerprint: "fp-1" })]).map(
        (entry) => entry.instanceId,
      ),
    ).toEqual([same.instanceId]);
  });

  it("still matches by e-mail, ignoring case", () => {
    const same = local("agy-local", {}, "Researcher@Example.org");
    expect(
      providersReadingAccounts([same], [hubAccount({}, "researcher@example.org")]).map(
        (entry) => entry.instanceId,
      ),
    ).toEqual([same.instanceId]);
  });

  it("matches nothing when neither side names the account", () => {
    expect(providersReadingAccounts([local("agy-local", {})], [hubAccount({})])).toEqual([]);
  });
});
