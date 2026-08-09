import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderConnectionOperation,
  ProviderConnectionSubmitAuthorizationCodeInput,
} from "./providerLifecycle.ts";

const decodeAuthorizationCode = Schema.decodeUnknownSync(
  ProviderConnectionSubmitAuthorizationCodeInput,
);
const decodeConnectionOperation = Schema.decodeUnknownSync(ProviderConnectionOperation);

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
    });

    expect(decoded.authorizationUrlKind).toBe("manual_fallback");
  });
});
