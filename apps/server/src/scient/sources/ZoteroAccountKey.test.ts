import { describe, expect, it } from "@effect/vitest";
import {
  AccountId,
  ProjectId,
  defaultAccountControls,
  type AccountControls,
  type AccountSummary,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

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
  it("finds the key by its site or its ZOTERO_API_KEY variable, newest first", () => {
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

    expect(zoteroAccountFor(snapshot(accounts), { actor: "user" })?.name).toBe("variable");
  });

  it("never uses a key that is Off, even for the user", () => {
    const accounts = [apiKeyAccount("off", { controls: { access: "off" } })];

    expect(zoteroAccountFor(snapshot(accounts), { actor: "user" })).toBeUndefined();
  });

  it("follows the agent switch and project scope for agents, with Ask counting as allowed", () => {
    const asked = apiKeyAccount("ask", { controls: { access: "ask" } });
    const elsewhere = apiKeyAccount("elsewhere", {
      controls: { scope: { type: "projects", projectIds: [ProjectId.make("project-b")] } },
    });

    expect(zoteroAccountFor(snapshot([asked]), { actor: "agent", projectId: project })?.name).toBe(
      "ask00000",
    );
    expect(
      zoteroAccountFor(snapshot([asked], false), { actor: "agent", projectId: project }),
    ).toBeUndefined();
    expect(
      zoteroAccountFor(snapshot([elsewhere]), { actor: "agent", projectId: project }),
    ).toBeUndefined();
    expect(zoteroAccountFor(snapshot([elsewhere]), { actor: "user" })?.name).toBe("elsewhere");
  });

  it.effect("records the use once per stretch of work, without the key value", () =>
    Effect.gen(function* () {
      const used: unknown[] = [];
      const key = yield* readZoteroApiKey(
        {
          snapshot: Effect.succeed(snapshot([apiKeyAccount("zotero")])),
          resolveSecrets: () => Effect.succeed({ token: Redacted.make("secret-zotero-key") }),
          recordUse: (entry) => Effect.sync(() => void used.push(entry)),
        },
        { actor: "user" },
      );

      const again = yield* readZoteroApiKey(
        {
          snapshot: Effect.succeed(snapshot([apiKeyAccount("zotero")])),
          resolveSecrets: () => Effect.succeed({ token: Redacted.make("secret-zotero-key") }),
          recordUse: (entry) => Effect.sync(() => void used.push(entry)),
        },
        { actor: "user" },
      );

      expect(Option.map(key, Redacted.value)).toEqual(Option.some("secret-zotero-key"));
      expect(Option.isSome(again)).toBe(true);
      expect(JSON.stringify(used)).not.toContain("secret-zotero-key");
      expect(used).toEqual([expect.objectContaining({ action: "request" })]);
    }),
  );
});
