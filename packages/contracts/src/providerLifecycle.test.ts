import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderConnectionOperation,
  ProviderConnectionSubmitAuthorizationCodeInput,
  ProviderRuntimeSummary,
} from "./providerLifecycle.ts";

const decodeAuthorizationCode = Schema.decodeUnknownSync(
  ProviderConnectionSubmitAuthorizationCodeInput,
);
const decodeConnectionOperation = Schema.decodeUnknownSync(ProviderConnectionOperation);
const decodeRuntimeSummary = Schema.decodeUnknownSync(ProviderRuntimeSummary);

describe("ProviderConnectionSubmitAuthorizationCodeInput", () => {
  it("accepts a bounded one-time provider code", () => {
    expect(
      decodeAuthorizationCode({
        instanceId: "claudeAgent",
        operationId: "connection-1",
        authorizationCode: "  provider-code  ",
      }).authorizationCode,
    ).toBe("provider-code");
  });

  it("rejects control characters before the value reaches a provider process", () => {
    expect(() =>
      decodeAuthorizationCode({
        instanceId: "claudeAgent",
        operationId: "connection-1",
        authorizationCode: `provider${String.fromCharCode(10)}code`,
      }),
    ).toThrow();
  });
});

describe("ProviderConnectionOperation", () => {
  it("preserves an explicit provider-owned manual fallback URL", () => {
    const decoded = decodeConnectionOperation({
      operationId: "connection-1",
      method: "claude_subscription",
      status: "waiting_for_browser",
      startedAt: "2026-08-09T08:00:00.000Z",
      finishedAt: null,
      message: "Finish sign in.",
      authorizationUrl: "https://claude.ai/oauth/authorize",
      authorizationUrlKind: "manual_fallback",
      acceptsAuthorizationCode: true,
    });

    expect(decoded.authorizationUrlKind).toBe("manual_fallback");
    expect(decoded.acceptsAuthorizationCode).toBe(true);
  });

  it("keeps authorization-code support optional for older servers and cached operations", () => {
    const decoded = decodeConnectionOperation({
      operationId: "connection-1",
      method: "codex_browser",
      status: "waiting_for_browser",
      startedAt: "2026-08-09T08:00:00.000Z",
      finishedAt: null,
      message: "Finish sign in.",
    });

    expect(decoded).not.toHaveProperty("acceptsAuthorizationCode");
  });
});

describe("ProviderRuntimeSummary", () => {
  const summary = {
    source: "system",
    supportTier: "fully_assisted",
    target: "darwin-arm64",
    actions: ["install"],
    managedVersion: null,
    previousManagedVersion: null,
    operation: null,
    message: "Scient is using the system Codex runtime.",
  } as const;

  it("keeps runtime diagnostics optional for older servers and cached snapshots", () => {
    expect(decodeRuntimeSummary(summary)).not.toHaveProperty("diagnostics");
  });

  it("decodes display-only runtime diagnostics without credential fields", () => {
    expect(
      decodeRuntimeSummary({
        ...summary,
        diagnostics: {
          executable: "/opt/homebrew/bin/codex",
          version: "0.147.0",
          homePath: "/srv/scient/codex-home",
          backend: "macOS native",
          credential: "must-not-cross-the-wire",
        },
      }).diagnostics,
    ).toEqual({
      executable: "/opt/homebrew/bin/codex",
      version: "0.147.0",
      homePath: "/srv/scient/codex-home",
      backend: "macOS native",
    });
    expect(
      decodeRuntimeSummary({
        ...summary,
        diagnostics: {
          executable: "codex",
          version: null,
          homePath: null,
          backend: "macOS native",
          credential: "must-not-cross-the-wire",
        },
      }).diagnostics,
    ).not.toHaveProperty("credential");
  });
});
