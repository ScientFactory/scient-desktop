import { describe, expect, it } from "@effect/vitest";
import {
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { newlyRequestedCodexSubscriptionSharing } from "./codexSubscriptionSharingPolicy.ts";

describe("deferred Codex subscription sharing", () => {
  const id = ProviderInstanceId.make("personal");
  const managed = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [id]: { driver: ProviderDriverKind.make("codex"), config: { setupMode: "managed" } },
    },
  };
  it("preserves the upstream mode in decoding without changing the native default", () => {
    const decode = Schema.decodeUnknownSync(CodexSettings);
    expect(decode({}).setupMode).toBeUndefined();
    expect(decode({ setupMode: "existing" }).setupMode).toBe("existing");
    expect(decode({ setupMode: "managed" }).setupMode).toBe("managed");
  });
  it("blocks new default and named instance activation", () => {
    expect(newlyRequestedCodexSubscriptionSharing(DEFAULT_SERVER_SETTINGS, managed)).toBe(id);
    const managedDefault = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { setupMode: "managed" },
        },
      },
    };
    expect(newlyRequestedCodexSubscriptionSharing(DEFAULT_SERVER_SETTINGS, managedDefault)).toBe(
      ProviderInstanceId.make("codex"),
    );
  });
  it("allows unrelated updates, native configuration, and recovery from a saved unsupported mode", () => {
    expect(
      newlyRequestedCodexSubscriptionSharing(managed, {
        ...managed,
        providerInstances: {
          [id]: {
            driver: ProviderDriverKind.make("codex"),
            config: { setupMode: "managed" },
            displayName: "Personal",
          },
        },
      }),
    ).toBeUndefined();
    expect(
      newlyRequestedCodexSubscriptionSharing(managed, DEFAULT_SERVER_SETTINGS),
    ).toBeUndefined();
    expect(
      newlyRequestedCodexSubscriptionSharing(DEFAULT_SERVER_SETTINGS, DEFAULT_SERVER_SETTINGS),
    ).toBeUndefined();
  });
});
