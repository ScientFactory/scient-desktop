import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderConnectionDisconnectInput,
  ProviderConnectionOperation,
  ProviderConnectionStartInput,
  ProviderConnectionSubmitAuthorizationCodeInput,
  ProviderConnectionSummary,
  ProviderRuntimeSummary,
  publishedProviderConnectionOperation,
} from "./providerLifecycle.ts";

const decodeAuthorizationCode = Schema.decodeUnknownSync(
  ProviderConnectionSubmitAuthorizationCodeInput,
);
const decodeConnectionOperation = Schema.decodeUnknownSync(ProviderConnectionOperation);
const decodeRuntimeSummary = Schema.decodeUnknownSync(ProviderRuntimeSummary);
const decodeTypedRuntimeSummary = Schema.decodeSync(ProviderRuntimeSummary);
const encodeRuntimeSummary = Schema.encodeSync(ProviderRuntimeSummary);

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

  it("accepts a bounded OAuth redirect URL without widening provider-side validation", () => {
    const callbackUrl = `http://127.0.0.1:51234/?code=${"x".repeat(9_000)}`;
    expect(
      decodeAuthorizationCode({
        instanceId: "antigravity",
        operationId: "connection-1",
        authorizationCode: callbackUrl,
      }).authorizationCode,
    ).toBe(callbackUrl);
    expect(() =>
      decodeAuthorizationCode({
        instanceId: "antigravity",
        operationId: "connection-1",
        authorizationCode: "x".repeat(16_385),
      }),
    ).toThrow();
  });
});

describe("ProviderConnectionOperation", () => {
  it("accepts Droid's provider-opened browser state without an invented URL", () => {
    const decoded = decodeConnectionOperation({
      operationId: "droid-connection-1",
      method: "droid_device_pairing",
      status: "waiting_for_browser",
      startedAt: "2026-08-23T08:00:00.000Z",
      finishedAt: null,
      message: "Finish signing in securely in your browser.",
    });

    expect(decoded.method).toBe("droid_device_pairing");
    expect(decoded).not.toHaveProperty("authorizationUrl");
    expect(decoded).not.toHaveProperty("userCode");
  });

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
      authorizationResponseKind: "callback_url",
    });

    expect(decoded.authorizationUrlKind).toBe("manual_fallback");
    expect(decoded.acceptsAuthorizationCode).toBe(true);
    expect(decoded.authorizationResponseKind).toBe("callback_url");
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
    expect(decodeRuntimeSummary(summary)).not.toHaveProperty("availableManagedVersion");
    expect(
      decodeRuntimeSummary({ ...summary, availableManagedVersion: "0.156.1" })
        .availableManagedVersion,
    ).toBe("0.156.1");
  });

  it.each(
    (["binary", "npx", "uvx"] as const).map((distribution) => ({
      caseTitle: `round-trips ${distribution} registry ownership without credentials or invented historical installers`,
      distribution,
    })),
  )("$caseTitle", ({ distribution }) => {
    const installation = {
      agentId: "example-agent",
      distribution,
      version: "1.2.3",
      installRoot: `/owned/example/${distribution}`,
      executablePath: `/owned/example/${distribution}/agent`,
      ...(distribution === "binary"
        ? {}
        : {
            installer: "/tools/package-manager",
            packageSpec: "example@1.2.3",
            packageVersion: "1.2.3",
          }),
    };
    const decoded = decodeRuntimeSummary({
      ...summary,
      source: "registry",
      actions: ["remove"],
      installation: { ...installation, credential: "must-not-cross-the-wire" },
    });
    expect(decoded.installation).toEqual(installation);
    expect(decodeTypedRuntimeSummary(encodeRuntimeSummary(decoded))).toEqual(decoded);
    if (distribution === "binary") expect(decoded.installation).not.toHaveProperty("installer");
    expect(() =>
      decodeRuntimeSummary({
        ...summary,
        source: "registry",
        installation: { ...installation, installer: "" },
      }),
    ).toThrow();
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

describe("provider sign-in lists", () => {
  const decodeSummary = Schema.decodeUnknownSync(ProviderConnectionSummary);
  const decodeStart = Schema.decodeUnknownSync(ProviderConnectionStartInput);
  const decodeDisconnect = Schema.decodeUnknownSync(ProviderConnectionDisconnectInput);
  const account = {
    id: "openai-codex",
    name: "ChatGPT Plus/Pro",
    kind: "account",
    connected: false,
    canDisconnect: false,
  };

  it("keeps the list optional for providers with a single account and for older servers", () => {
    const summary = decodeSummary({
      methods: ["codex_browser"],
      canDisconnect: false,
      operation: null,
    });
    expect("accounts" in summary).toBe(false);
    expect("accountOperation" in summary).toBe(false);
    expect(publishedProviderConnectionOperation(summary)).toBeNull();
  });

  it("carries a provider's own sign-in list and the account an operation is for", () => {
    const summary = decodeSummary({
      methods: [],
      canDisconnect: false,
      accounts: [account, { ...account, id: "llama.cpp", name: "llama.cpp", kind: "key" }],
      operation: null,
      accountOperation: {
        operationId: "connect-1",
        method: "scient_agent_account",
        status: "waiting_for_device_code",
        startedAt: "2026-10-02T00:00:00.000Z",
        finishedAt: null,
        message: "Enter the code in the provider's secure sign-in page.",
        account: "openai-codex",
        instructions: "Enter code: A2L1-00QJC",
        userCode: "A2L1-00QJC",
      },
    });
    expect(summary.accounts?.map((entry) => entry.id)).toEqual(["openai-codex", "llama.cpp"]);
    expect(summary.operation).toBeNull();
    expect(summary.accountOperation?.account).toBe("openai-codex");
    expect(summary.accountOperation?.instructions).toBe("Enter code: A2L1-00QJC");
    expect(publishedProviderConnectionOperation(summary)).toBe(summary.accountOperation);
  });

  it("names the account in a sign-in and a sign-out", () => {
    expect(
      decodeStart({ instanceId: "scient", method: "scient_agent_account", account: "openai-codex" })
        .account,
    ).toBe("openai-codex");
    expect(decodeDisconnect({ instanceId: "scient", account: "openai-codex" }).account).toBe(
      "openai-codex",
    );
    expect("account" in decodeDisconnect({ instanceId: "codex" })).toBe(false);
  });

  it("rejects an account id that is not a plain provider id", () => {
    for (const id of ["has space", "semi;colon", "../up", "x".repeat(129)]) {
      expect(() =>
        decodeStart({ instanceId: "scient", method: "scient_agent_account", account: id }),
      ).toThrow();
      expect(() =>
        decodeSummary({
          methods: [],
          canDisconnect: false,
          operation: null,
          accounts: [{ ...account, id }],
        }),
      ).toThrow();
    }
  });
});
