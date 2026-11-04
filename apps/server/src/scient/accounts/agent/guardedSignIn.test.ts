import {
  AccountId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  defaultAccountControls,
  type AccountSummary,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { fakeAccounts } from "../Accounts.testkit.ts";
import { guardedSignIn, type SignInCaller } from "./guardedSignIn.ts";

const scope = {
  threadId: ThreadId.make("thread-fixture"),
  projectId: undefined,
  unattended: false,
};
const url = "https://example.com/login";
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const row = (id: string, patch: Partial<AccountSummary> = {}): AccountSummary => ({
  accountId: AccountId.make(`acc_fixture_${id}`),
  name: "Fixture",
  details: { kind: "website", sites: ["example.com"], username: "Fixture-User" },
  secrets: { password: { source: { type: "scient" } } },
  controls: defaultAccountControls("website"),
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});
const university = (id: string, entityId: string): AccountSummary =>
  row(id, {
    details: {
      kind: "website",
      sites: ["huji.ac.il", "https://idp.cc.huji.ac.il"],
      institution: { name: `University ${id}`, entityId, domain: "huji.ac.il" },
    },
  });
const at = (state: NonNullable<AccountSummary["signIn"]>["state"], when = 0) => ({
  signIn: { state, at: iso(when) },
});
const check: SignInCaller = { kind: "check" };
const page: SignInCaller = { kind: "page", scope };
const paper = (accounts: "all" | ReadonlyArray<AccountId>): SignInCaller => ({
  kind: "paper",
  scope: { ...scope, unattended: true },
  requester: { accounts },
});

/**
 * Accounts that keep each attempt's outcome on its row, and a browser whose sign-in page refuses
 * every password, or waits on `gate` before its first page.
 */
const world = (
  rows: Array<AccountSummary>,
  gate?: { readonly reached: Deferred.Deferred<void>; readonly open: Deferred.Deferred<void> },
) => {
  const opened: string[] = [];
  const resolved: string[] = [];
  const fake = fakeAccounts({ accounts: rows, values: { password: "synthetic-password" } });
  const service = AccountsService.of({
    ...fake.service,
    snapshot: Effect.sync(
      () => ({ accounts: rows, agentAccess: true }) as unknown as AccountsSnapshot,
    ),
    resolveSecrets: (accountId, fields) =>
      Effect.sync(() => void resolved.push(accountId)).pipe(
        Effect.andThen(fake.service.resolveSecrets(accountId, fields)),
      ),
    recordUse: (entry) =>
      Effect.sync(() => {
        const index = rows.findIndex(
          (account) =>
            entry.target.type === "account" && account.accountId === entry.target.accountId,
        );
        if (index !== -1 && entry.signInOutcome)
          rows[index] = {
            ...rows[index]!,
            signIn: {
              state: entry.signInOutcome === "needs-user" ? "needs-you" : entry.signInOutcome,
              at: iso(1_000),
              by: "action",
            },
          };
      }),
  });
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: { readonly operation: string }) =>
      Effect.gen(function* () {
        if (request.operation === "open") {
          opened.push(request.operation);
          if (gate) {
            yield* Deferred.succeed(gate.reached, undefined);
            yield* Deferred.await(gate.open);
          }
        }
        if (request.operation === "evaluate")
          return {
            origin: "https://example.com",
            url,
            username: "#user",
            password: "#password",
            otp: null,
            submit: "button",
            challenge: null,
            signedIn: false,
          } as A;
        return {
          tabId: "tab-fixture",
          tabs: [{ tabId: "tab-fixture", url, profileId: "default", ownedByCaller: true }],
        } as A;
      }),
  });
  const run = (signIn: AccountSummary | { readonly find: string }, caller: SignInCaller) =>
    guardedSignIn({ page: { tabId: "tab-fixture" }, signIn, caller }).pipe(
      Effect.provideService(AccountsService, service),
      Effect.provideService(PreviewAutomationBroker, broker),
      Effect.provideService(AgentInvocationContext, {
        ...scope,
        environmentId: EnvironmentId.make("env-fixture"),
        providerSessionId: "session-fixture",
        providerInstanceId: ProviderInstanceId.make("scient"),
        capabilities: new Set(["preview", "accounts"] as const),
        issuedAt: 0,
      }),
    );
  return { run, opened, resolved, calls: fake.calls };
};

it.effect("duplicate rows are one sign-in: concurrent calls run the engine once", () =>
  Effect.gen(function* () {
    const rows = [
      row("first"),
      row("second", {
        details: { kind: "website", sites: ["example.com"], username: "fixture-user" },
      }),
    ];
    const gate = { reached: yield* Deferred.make<void>(), open: yield* Deferred.make<void>() };
    const { run, opened } = world(rows, gate);
    const first = yield* run(rows[0]!, check).pipe(Effect.forkChild);
    yield* Deferred.await(gate.reached);
    const second = yield* run(rows[1]!, paper("all")).pipe(Effect.forkChild);
    yield* Deferred.succeed(gate.open, undefined);
    expect((yield* Fiber.join(first)).outcome).toBe("password-rejected");
    // Waited for the first, then found its refusal on the shared site and identity.
    expect(yield* Fiber.join(second)).toMatchObject({
      outcome: "failed",
      message: expect.stringContaining("didn't go through"),
    });
    expect(opened).toHaveLength(1);
  }),
);

it.effect("two universities on one identity provider share one attempt", () =>
  Effect.gen(function* () {
    const rows = [
      { ...university("a", "https://idp.a.example/entity"), ...at("password-rejected") },
      university("b", "https://idp.b.example/entity"),
    ];
    const { run, opened } = world(rows);
    expect((yield* run(rows[1]!, paper("all"))).outcome).toBe("failed");
    expect(opened).toEqual([]);
  }),
);

it.effect("holds until a user action, and no time lifts it", () =>
  Effect.gen(function* () {
    const rows = [row("held", at("needs-you"))];
    const { run, opened } = world(rows);
    yield* TestClock.adjust("30 days");
    for (const caller of [page, paper("all")])
      expect((yield* run(rows[0]!, caller)).outcome).toBe("failed");
    expect(opened).toEqual([]);
    // A changed password is the user's reset; then automatic callers may try once.
    rows[0] = row("held", {
      signIn: {
        state: "unknown",
        at: iso(5_000),
        detail: "Password changed",
        by: "action",
      },
    });
    expect((yield* run(rows[0], paper("all"))).outcome).toBe("password-rejected");
    expect((yield* run(rows[0], paper("all"))).outcome).toBe("failed");
    // Check is a press: it tries once more.
    expect((yield* run(rows[0], check)).outcome).toBe("password-rejected");
    expect(opened).toHaveLength(2);
  }),
);

it.effect("leaves a refused sign-in on record, and reports a limit without retrying", () =>
  Effect.gen(function* () {
    const rows = [
      row("refused", at("password-rejected")),
      row("limited", {
        ...at("limited"),
        details: { kind: "website", sites: ["limited.example"] },
      }),
    ];
    const { run, resolved } = world(rows);
    expect((yield* run(rows[0]!, page)).outcome).toBe("failed");
    expect((yield* run(rows[1]!, check)).outcome).toBe("limited");
    expect(resolved).toEqual([]);
  }),
);

it.effect("an automatic caller won't sign in again right after a sign-in that worked", () =>
  Effect.gen(function* () {
    const rows = [row("worked", at("signed-in"))];
    const { run, resolved } = world(rows);
    expect(yield* run(rows[0]!, page)).toMatchObject({
      outcome: "failed",
      message: expect.stringContaining("moments ago"),
    });
    expect(resolved).toEqual([]);
  }),
);

it.effect("account controls decide every resolve, read again when the attempt starts", () =>
  Effect.gen(function* () {
    const controls = (access: "allowed" | "ask" | "off") => ({
      controls: { ...defaultAccountControls("website"), access },
    });
    const typed = (rows: Array<AccountSummary>, caller: SignInCaller) =>
      Effect.gen(function* () {
        const { run, resolved } = world(rows);
        yield* run(rows[0]!, caller);
        return resolved.length > 0;
      });
    const id = (patch: Partial<AccountSummary>) => [row("controls", patch)];
    // A page signs in only with Allowed; an agent's paper the same.
    expect(yield* typed(id(controls("ask")), page)).toBe(false);
    expect(yield* typed(id(controls("ask")), paper([AccountId.make("acc_fixture_controls")]))).toBe(
      false,
    );
    // The user's own paper and Check use anything that isn't Off.
    expect(yield* typed(id(controls("ask")), paper("all"))).toBe(true);
    expect(yield* typed(id(controls("ask")), check)).toBe(true);
    for (const caller of [page, check, paper("all")])
      expect(yield* typed(id(controls("off")), caller)).toBe(false);
    // An agent is asked through `authorize`, whose Off refuses.
    const { run, calls } = world(id(controls("allowed")));
    yield* run(row("controls"), { kind: "agent", scope });
    expect(calls).toContain("authorize:account:sign-in");
    // Turned Off while another attempt on the site was running: nothing is typed.
    const rows = id(controls("allowed"));
    const gate = { reached: yield* Deferred.make<void>(), open: yield* Deferred.make<void>() };
    const waiting = world(rows, gate);
    const first = yield* waiting.run(rows[0]!, check).pipe(Effect.forkChild);
    yield* Deferred.await(gate.reached);
    const second = yield* waiting.run(rows[0]!, check).pipe(Effect.forkChild);
    rows[0] = { ...rows[0]!, ...controls("off") };
    yield* Deferred.succeed(gate.open, undefined);
    yield* Fiber.join(first);
    expect((yield* Fiber.join(second)).outcome).toBe("needs-user");
    expect(waiting.resolved).toHaveLength(1);
  }),
);

it.effect("find types only a sign-in this profile may use, and asks when several fit", () =>
  Effect.gen(function* () {
    const elsewhere = row("elsewhere", {
      details: { kind: "website", sites: ["example.com"], username: "a", profileId: "work" },
    });
    expect((yield* world([elsewhere]).run({ find: url }, check)).outcome).toBe("password-rejected");
    const other = row("other", {
      details: { kind: "website", sites: ["example.com"], username: "b", profileId: "home" },
    });
    expect((yield* world([elsewhere, other]).run({ find: url }, check)).outcome).toBe("none");
    const here = [
      row("one"),
      row("two", { details: { kind: "website", sites: ["example.com"], username: "c" } }),
    ];
    expect(yield* world(here).run({ find: url }, check)).toMatchObject({ outcome: "choose" });
    // An agent's paper only sees the sign-ins it was given.
    expect((yield* world(here).run({ find: url }, paper([here[0]!.accountId]))).outcome).toBe(
      "password-rejected",
    );
  }),
);
