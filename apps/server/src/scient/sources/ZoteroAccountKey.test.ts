import { describe, expect, it } from "@effect/vitest";
import {
  AccountId,
  AccountsError,
  ProjectId,
  defaultAccountControls,
  type AccountControls,
  type AccountSummary,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { ServerSettingsService } from "../../serverSettings.ts";
import { readZoteroApiKey, zoteroAccountFor } from "./ZoteroAccountKey.ts";

const project = ProjectId.make("project-a");

function apiKeyAccount(
  id: string,
  options: {
    readonly sites?: ReadonlyArray<string>;
    readonly envName?: string;
    readonly controls?: Partial<AccountControls>;
    readonly updatedAt?: string;
  } = {},
): AccountSummary {
  return {
    accountId: AccountId.make(`acc_${id.padEnd(8, "0")}`),
    name: id.padEnd(8, "0"),
    details: {
      kind: "api-key",
      sites: [...(options.sites ?? ["zotero.org"])],
      auth: { type: "header", name: "Zotero-API-Key" },
      ...(options.envName ? { envName: options.envName } : {}),
    },
    secrets: { token: { source: { type: "scient" } } },
    controls: { ...defaultAccountControls("api-key"), ...options.controls },
    status: "ready",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-11-01T00:00:00.000Z",
  } as AccountSummary;
}

const snapshot = (accounts: ReadonlyArray<AccountSummary>, agentAccess = true) =>
  ({ agentAccess, accounts }) as unknown as AccountsSnapshot;

describe("Zotero key from Accounts", () => {
  it.effect("finds the key by its site or its ZOTERO_API_KEY variable, newest first", () =>
    Effect.gen(function* () {
      const accounts = [
        apiKeyAccount("old", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        apiKeyAccount("variable", {
          sites: [],
          envName: "ZOTERO_API_KEY",
          updatedAt: "2026-06-01T00:00:00.000Z",
        }),
        apiKeyAccount("other", {
          sites: ["semanticscholar.org"],
          updatedAt: "2026-12-01T00:00:00.000Z",
        }),
      ];

      expect((yield* zoteroAccountFor(snapshot(accounts), { actor: "user" }))?.name).toBe(
        "variable",
      );
    }),
  );

  it.effect("keeps the person's chosen key: a newer one never switches it, nor does Off", () =>
    Effect.gen(function* () {
      const personal = apiKeyAccount("personal", {
        controls: { access: "off" },
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const work = apiKeyAccount("work", { updatedAt: "2026-12-01T00:00:00.000Z" });
      const settings = ServerSettingsService.layerTest({
        scientSources: { registryContactEmail: "", keys: { zotero: personal.accountId } },
      });
      const chosen = (use: Parameters<typeof zoteroAccountFor>[1]) =>
        zoteroAccountFor(snapshot([personal, work]), use).pipe(Effect.provide(settings));

      expect((yield* chosen({ actor: "user" }))?.name).toBe("personal");
      // Off still governs agents, and they never switch to another key.
      expect(yield* chosen({ actor: "agent", projectId: project })).toBeUndefined();
    }),
  );

  it.effect("keeps today's pick as the choice the first time a key is used", () =>
    Effect.gen(function* () {
      const off = apiKeyAccount("off", {
        controls: { access: "off" },
        updatedAt: "2026-12-01T00:00:00.000Z",
      });
      const older = apiKeyAccount("older", { updatedAt: "2026-01-01T00:00:00.000Z" });
      const keys = yield* Effect.gen(function* () {
        const picked = yield* zoteroAccountFor(snapshot([off, older]), { actor: "user" });
        expect(picked?.name).toBe("older000");
        return (yield* (yield* ServerSettingsService).getSettings).scientSources.keys;
      }).pipe(Effect.provide(ServerSettingsService.layerTest()));
      expect(keys).toEqual({ zotero: older.accountId });
    }),
  );

  it.effect("keeps a choice the person made while the first pick was being stored", () =>
    Effect.gen(function* () {
      const work = apiKeyAccount("work");
      const chosen = AccountId.make("acc_chosen00");
      const keys = yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const before = yield* settings.getSettings;
        // The choice lands after the lookup read the settings, before it stores its pick.
        yield* settings.updateSettings({ scientSources: { keys: { zotero: chosen } } });
        yield* zoteroAccountFor(snapshot([work]), { actor: "user" }).pipe(
          Effect.provideService(ServerSettingsService, {
            ...settings,
            getSettings: Effect.succeed(before),
          }),
        );
        return (yield* settings.getSettings).scientSources.keys;
      }).pipe(Effect.provide(ServerSettingsService.layerTest()));
      expect(keys).toEqual({ zotero: chosen });
    }),
  );

  it.effect("never switches the Library to another key when its chosen key is gone", () =>
    Effect.gen(function* () {
      const work = apiKeyAccount("work");
      const settings = ServerSettingsService.layerTest({
        scientSources: {
          registryContactEmail: "",
          keys: { zotero: AccountId.make("acc_removed0") },
        },
      });
      expect(
        yield* zoteroAccountFor(snapshot([work]), { actor: "user" }).pipe(Effect.provide(settings)),
      ).toBeUndefined();
    }),
  );

  it.effect("gives a project's agent the newest key it may use the first time", () =>
    Effect.gen(function* () {
      const elsewhere = apiKeyAccount("elsewhere", {
        controls: { scope: { type: "projects", projectIds: [ProjectId.make("project-b")] } },
        updatedAt: "2026-12-01T00:00:00.000Z",
      });
      const ours = apiKeyAccount("ours", { updatedAt: "2026-01-01T00:00:00.000Z" });
      const picked = yield* zoteroAccountFor(snapshot([elsewhere, ours]), {
        actor: "agent",
        projectId: project,
      }).pipe(Effect.provide(ServerSettingsService.layerTest()));
      expect(picked?.name).toBe("ours0000");
    }),
  );

  it.effect(
    "follows the agent switch and project scope for agents, with Ask counting as allowed",
    () =>
      Effect.gen(function* () {
        const asked = apiKeyAccount("ask", { controls: { access: "ask" } });
        const elsewhere = apiKeyAccount("elsewhere", {
          controls: { scope: { type: "projects", projectIds: [ProjectId.make("project-b")] } },
        });
        const agent = { actor: "agent", projectId: project } as const;

        expect((yield* zoteroAccountFor(snapshot([asked]), agent))?.name).toBe("ask00000");
        expect(yield* zoteroAccountFor(snapshot([asked], false), agent)).toBeUndefined();
        expect(yield* zoteroAccountFor(snapshot([elsewhere]), agent)).toBeUndefined();
        expect((yield* zoteroAccountFor(snapshot([elsewhere]), { actor: "user" }))?.name).toBe(
          "elsewhere",
        );
      }),
  );

  it.effect("records the use once per stretch of work, without the key value", () =>
    Effect.gen(function* () {
      const used: unknown[] = [];
      const key = yield* readZoteroApiKey(
        {
          snapshot: Effect.succeed(snapshot([apiKeyAccount("zotero")])),
          resolveSecrets: () => Effect.succeed({ token: Redacted.make("secret-zotero-key") }),
          recordUse: (entry) => Effect.sync(() => void used.push(entry)),
          authorizeUse: () => Effect.void,
        },
        { actor: "user" },
      );

      const again = yield* readZoteroApiKey(
        {
          snapshot: Effect.succeed(snapshot([apiKeyAccount("zotero")])),
          resolveSecrets: () => Effect.succeed({ token: Redacted.make("secret-zotero-key") }),
          recordUse: (entry) => Effect.sync(() => void used.push(entry)),
          authorizeUse: () => Effect.void,
        },
        { actor: "user" },
      );

      expect(Option.map(key, Redacted.value)).toEqual(Option.some("secret-zotero-key"));
      expect(Option.isSome(again)).toBe(true);
      expect(JSON.stringify(used)).not.toContain("secret-zotero-key");
      expect(used).toEqual([expect.objectContaining({ action: "request" })]);
    }),
  );

  it.effect("gives an agent no key that the use-time gate refuses after the read", () =>
    Effect.gen(function* () {
      const key = yield* readZoteroApiKey(
        {
          snapshot: Effect.succeed(snapshot([apiKeyAccount("zotero")])),
          resolveSecrets: () => Effect.succeed({ token: Redacted.make("secret-zotero-key") }),
          recordUse: () => Effect.void,
          authorizeUse: () =>
            Effect.fail(new AccountsError({ reason: "denied", message: "Access changed." })),
        },
        { actor: "agent", projectId: project },
      );
      expect(Option.isNone(key)).toBe(true);
    }),
  );

  it.effect("gives an agent no key replaced while it was read", () =>
    Effect.gen(function* () {
      const row = apiKeyAccount("zotero");
      let version = row.updatedAt;
      const key = yield* readZoteroApiKey(
        {
          snapshot: Effect.succeed(snapshot([row])),
          // A new key is saved as the old one is read.
          resolveSecrets: () =>
            Effect.sync(() => {
              version = "2026-11-02T00:00:00.000Z";
              return { token: Redacted.make("secret-zotero-key") };
            }),
          recordUse: () => Effect.void,
          authorizeUse: (_scope, _target, use) =>
            use?.since !== undefined && use.since.updatedAt !== version
              ? Effect.fail(new AccountsError({ reason: "denied", message: "Access changed." }))
              : Effect.void,
        },
        { actor: "agent", projectId: project },
      );
      expect(Option.isNone(key)).toBe(true);
    }),
  );
});
