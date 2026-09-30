import { describe, expect, it } from "@effect/vitest";
import {
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  newlyRequestedCodexSubscriptionSharing,
  rejectCodexSubscriptionSharing,
} from "./codexSubscriptionSharingPolicy.ts";

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
  it("blocks new instance and legacy-settings activation", () => {
    expect(newlyRequestedCodexSubscriptionSharing(DEFAULT_SERVER_SETTINGS, managed)).toBe(id);
    expect(
      newlyRequestedCodexSubscriptionSharing(DEFAULT_SERVER_SETTINGS, {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, setupMode: "managed" },
        },
      }),
    ).toBe("codex");
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
  for (const operation of [
    "import",
    "export",
    "handoff",
    "callback",
    "install",
    "cancel-install",
    "remove-install",
    "observe-install",
  ]) {
    it.effect(`rejects ${operation} before any side effect`, () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(rejectCodexSubscriptionSharing(id, operation));
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  }
});
