import { it } from "@effect/vitest";
import {
  AccountId,
  AccountsError,
  ProjectId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { fakeAccounts } from "./Accounts.testkit.ts";
import { AccountsService } from "./AccountsService.ts";
import { checkKey } from "./keyCheck.ts";

const key = (site: string): AccountSummary => ({
  accountId: AccountId.make("acc_keycheck1"),
  name: "Key",
  details: { kind: "api-key", sites: [site], auth: { type: "bearer" } },
  secrets: { token: { source: { type: "scient" } } },
  controls: defaultAccountControls("api-key"),
  status: "ready",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

/** Checks the key against a service that answers `status`, recording what was asked. */
const checked = (site: string, status: number) =>
  Effect.gen(function* () {
    const fake = fakeAccounts({ accounts: [key(site)], values: { token: "synthetic-key-value" } });
    const asked: Array<{ url: string; authorization: string | null }> = [];
    const transport = {
      fetch: async (url: string | URL, init?: RequestInit) => {
        asked.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response("{}", { status, headers: { "content-type": "application/json" } });
      },
      close: async () => undefined,
    };
    const result = yield* checkKey(AccountId.make("acc_keycheck1"), transport).pipe(
      Effect.provideService(AccountsService, { ...fake.service, test: () => Effect.void }),
    );
    return { result, asked };
  });

it.effect("says a key works only when its service accepts it", () =>
  Effect.gen(function* () {
    const works = yield* checked("https://api.openai.com", 200);
    expect(works.result).toBe("works");
    expect(works.asked).toEqual([
      { url: "https://api.openai.com/v1/models", authorization: "Bearer synthetic-key-value" },
    ]);
    expect((yield* checked("https://api.openai.com", 401)).result).toBe("refused");
    // An answer that says nothing about the key, and a service with no check, only read.
    expect((yield* checked("https://api.openai.com", 503)).result).toBe("readable");
    const unknown = yield* checked("https://models.example.test", 200);
    expect(unknown).toEqual({ result: "readable", asked: [] });
  }),
);

it.effect("sends an agent's Check only while the gate passes the key as it was read", () =>
  Effect.gen(function* () {
    const row = key("https://api.openai.com");
    const fake = fakeAccounts({ accounts: [row], values: { token: "synthetic-key-value" } });
    const asked: Array<string> = [];
    const transport = {
      fetch: async (url: string | URL) => {
        asked.push(String(url));
        return new Response("{}", { status: 200 });
      },
      close: async () => undefined,
    };
    let version = row.updatedAt;
    let access = "allowed";
    const agent = { projectId: ProjectId.make("project-a"), unattended: false };
    const check = (during: () => void) =>
      checkKey(row.accountId, transport, agent).pipe(
        Effect.provideService(
          AccountsService,
          AccountsService.of({
            ...fake.service,
            test: () => Effect.void,
            resolveSecrets: (accountId, fields) =>
              fake.service.resolveSecrets(accountId, fields).pipe(Effect.tap(Effect.sync(during))),
            authorizeUse: (_scope, _target, use) =>
              access !== "allowed" || (use?.since !== undefined && use.since.updatedAt !== version)
                ? Effect.fail(new AccountsError({ reason: "denied", message: "Access changed." }))
                : Effect.void,
          }),
        ),
        Effect.flip,
      );
    // Turned Off, or a new key saved, while the key was read: nothing goes to the service.
    expect((yield* check(() => (access = "off"))).reason).toBe("denied");
    access = "allowed";
    expect((yield* check(() => (version = "2026-11-02T00:00:00.000Z"))).reason).toBe("denied");
    expect(asked).toEqual([]);
  }),
);

it.effect(
  "says the value reads when the service can't be reached, and refuses only by the gate",
  () =>
    Effect.gen(function* () {
      const row = key("https://api.openai.com");
      const fake = fakeAccounts({ accounts: [row], values: { token: "synthetic-key-value" } });
      const unreachable = {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
        close: async () => undefined,
      };
      const service = (gate: "open" | "closed-at-send") => {
        let reads = 0;
        return AccountsService.of({
          ...fake.service,
          test: () => Effect.void,
          authorizeUse: () =>
            gate === "closed-at-send" && reads++ > 0
              ? Effect.fail(new AccountsError({ reason: "denied", message: "Access changed." }))
              : Effect.void,
        });
      };
      // regression: an unreachable service failed the person's Check instead of Value readable.
      expect(
        yield* checkKey(row.accountId, unreachable).pipe(
          Effect.provideService(AccountsService, service("open")),
        ),
      ).toBe("readable");
      const agent = { projectId: ProjectId.make("project-a"), unattended: false };
      expect(
        yield* checkKey(row.accountId, unreachable, agent).pipe(
          Effect.provideService(AccountsService, service("open")),
        ),
      ).toBe("readable");
      // The gate as the request leaves still refuses an agent's Check.
      const ok = {
        fetch: async () => new Response("{}", { status: 200 }),
        close: async () => undefined,
      };
      const denied = yield* checkKey(row.accountId, ok, agent).pipe(
        Effect.provideService(AccountsService, service("closed-at-send")),
        Effect.flip,
      );
      expect(denied.message).toBe("Access changed.");
    }),
);
