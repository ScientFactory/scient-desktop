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
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { fakeAccounts } from "../Accounts.testkit.ts";
import { guardedSignIn, keepTyped, type SignInCaller } from "./guardedSignIn.ts";

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
const signInPage = (origin = "https://example.com") => ({
  origin,
  username: "#user",
  password: "#password",
  otp: null,
  submit: "button",
  challenge: null,
  signedIn: false,
});

/** The services a sign-in runs with: Accounts, the fake browser, and a user's run. */
const withFixture = <A, E>(
  effect: Effect.Effect<A, E, AccountsService | PreviewAutomationBroker | AgentInvocationContext>,
  service: AccountsService["Service"],
  broker: PreviewAutomationBroker["Service"],
) =>
  effect.pipe(
    Effect.provideService(AccountsService, service),
    Effect.provideService(PreviewAutomationBroker, broker),
    Effect.provideService(AgentInvocationContext, {
      ...scope,
      environmentId: EnvironmentId.make("env-fixture"),
      providerSessionId: "user-run:thread-fixture",
      providerInstanceId: ProviderInstanceId.make("scient"),
      capabilities: new Set(["preview", "accounts"] as const),
      issuedAt: 0,
    }),
  );

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
        if (request.operation === "evaluate") return { ...signInPage(), url } as A;
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

/** A site that asks for a code after the password; the person may answer it in the tab. */
const codeSite = (rows: Array<AccountSummary>) => {
  const site = { phase: "login" as "login" | "code" | "done", gone: false, passwords: 0, opens: 0 };
  const fake = fakeAccounts({ accounts: rows, values: { password: "synthetic-password" } });
  const service = AccountsService.of({
    ...fake.service,
    snapshot: Effect.sync(
      () => ({ accounts: rows, agentAccess: true }) as unknown as AccountsSnapshot,
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
    invoke: <A>(request: { readonly operation: string; readonly input: unknown }) =>
      Effect.sync(() => {
        const input = (request.input ?? {}) as Record<string, unknown>;
        if (request.operation === "open" && input.url) site.opens++;
        if (request.operation === "accountType" && input.selector === "#password") site.passwords++;
        if (request.operation === "click" && site.phase === "login") site.phase = "code";
        if (request.operation === "evaluate")
          return {
            origin: "https://example.com",
            username: site.phase === "login" ? "#user" : null,
            password: site.phase === "login" ? "#password" : null,
            otp: site.phase === "code" ? "#code" : null,
            submit: "button",
            challenge: null,
            signedIn: site.phase === "done",
          } as A;
        return {
          tabId: "tab-fixture",
          tabs: site.gone
            ? []
            : [{ tabId: "tab-fixture", url, profileId: "default", ownedByCaller: true }],
        } as A;
      }),
  });
  const run = (signIn: AccountSummary, caller: SignInCaller) =>
    guardedSignIn({ signIn, caller }).pipe((effect) => withFixture(effect, service, broker));
  return { run, site, attempts: fake.attempts };
};

it.effect("a paper stopped at a code waits there; the press resumes it, one password in all", () =>
  Effect.gen(function* () {
    const rows = [row("code")];
    const { run, site, attempts } = codeSite(rows);
    expect(yield* run(rows[0]!, paper("all"))).toMatchObject({
      outcome: "needs-user",
      pending: true,
    });
    expect([...attempts.values()]).toMatchObject([{ tabId: "tab-fixture", state: "pending" }]);
    // Nothing automatic tries again while it waits.
    expect((yield* run(rows[0]!, paper("all"))).outcome).toBe("failed");
    // The person answers the code in the kept tab.
    site.phase = "done";
    expect((yield* run(rows[0]!, { kind: "person" })).outcome).toBe("signed-in");
    expect(site.passwords).toBe(1);
    expect(site.opens).toBe(0);
    expect(attempts.size).toBe(0);
  }),
);

it.effect("with the kept tab gone, the press is one fresh attempt", () =>
  Effect.gen(function* () {
    const rows = [row("gone")];
    const { run, site } = codeSite(rows);
    yield* run(rows[0]!, paper("all"));
    site.gone = true;
    site.phase = "login";
    expect(yield* run(rows[0]!, { kind: "person" })).toMatchObject({ outcome: "needs-user" });
    expect(site.passwords).toBe(2);
    // A new page for the fresh attempt; the first one stayed on the tab it was given.
    expect(site.opens).toBe(1);
  }),
);

/** A person signing in to their university: its page asks for a password, then hands back. */
const universityVisit = (rows: Array<AccountSummary>, checkSees: string) => {
  const seen = { phase: "idp" as "idp" | "back", closed: [] as string[], saved: [] as unknown[] };
  const fake = fakeAccounts({ accounts: rows });
  const write = (accountId: string, state: "signed-in" | "signed-out" | "needs-you") => {
    const index = rows.findIndex((account) => account.accountId === accountId);
    if (index !== -1) rows[index] = { ...rows[index]!, signIn: { state, at: iso(2_000) } };
  };
  const service = AccountsService.of({
    ...fake.service,
    snapshot: Effect.sync(
      () => ({ accounts: rows, agentAccess: true }) as unknown as AccountsSnapshot,
    ),
    save: (input) =>
      Effect.sync(() => {
        seen.saved.push(input.details);
        return { accountId: input.accountId! };
      }),
    recordCheck: (accountId, check) =>
      Effect.sync(() => write(accountId, check.state as "signed-in" | "signed-out")),
    recordUse: (entry) =>
      Effect.sync(() => {
        if (entry.target.type === "account" && entry.signInOutcome)
          write(
            entry.target.accountId,
            entry.signInOutcome === "signed-in" ? "signed-in" : "needs-you",
          );
      }),
  });
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: {
      readonly operation: string;
      readonly input: unknown;
      readonly tabId?: string;
    }) =>
      Effect.sync(() => {
        const input = (request.input ?? {}) as Record<string, unknown>;
        if (request.operation === "close" && request.tabId) seen.closed.push(request.tabId);
        // The person signs in between two looks.
        if (request.operation === "accountWaitForLoad" && input.settleMs === 400)
          seen.phase = "back";
        if (request.operation === "evaluate")
          return (
            String(input.expression).includes("finalUrl")
              ? { finalUrl: checkSees, title: "", passwordField: false, deniedText: false }
              : seen.phase === "idp"
                ? signInPage("https://idp.example.edu")
                : {
                    origin: "https://www.nature.com",
                    url: "https://www.nature.com/",
                    username: null,
                    password: null,
                    otp: null,
                    submit: null,
                    challenge: null,
                    signedIn: false,
                  }
          ) as A;
        if (request.operation === "accountCookies") return [] as A;
        return { tabId: "tab-person", tabs: [] } as A;
      }),
  });
  let continued = false;
  const run = guardedSignIn({
    signIn: rows[0]!,
    caller: {
      kind: "person",
      afterSignIn: Effect.sync(() => {
        continued = true;
      }),
    },
  }).pipe((effect) => withFixture(effect, service, broker));
  return { run, seen, continued: () => continued };
};

const connected = () => [
  row("university", {
    secrets: {},
    details: {
      kind: "website",
      sites: ["example.edu"],
      institution: {
        name: "Example University",
        entityId: "https://idp.example.edu/shibboleth",
        domain: "example.edu",
      },
    },
  }),
];

it.effect("a university sign-in counts once a check reaches the journal, then tidies up", () =>
  Effect.gen(function* () {
    const rows = connected();
    const visit = universityVisit(rows, "https://www.nature.com/");
    expect((yield* visit.run).outcome).toBe("signed-in");
    expect(rows[0]!.signIn?.state).toBe("signed-in");
    // The page that asked for the password is learned; the tab it handed back to closes.
    expect(visit.seen.saved).toEqual([
      expect.objectContaining({ sites: ["example.edu", "https://idp.example.edu"] }),
    ]);
    expect(visit.seen.closed).toContain("tab-person");
    expect(visit.continued()).toBe(true);
  }),
);

it.effect("a link back that the check can't confirm is no sign-in", () =>
  Effect.gen(function* () {
    const rows = connected();
    const visit = universityVisit(rows, "https://idp.example.edu/login");
    expect(yield* visit.run).toMatchObject({
      outcome: "needs-user",
      message: "Couldn't confirm the sign-in.",
    });
    expect(visit.continued()).toBe(false);
    expect(visit.seen.saved).toEqual([]);
  }),
);

const signedInPage = { ...signInPage(), username: null, password: null, signedIn: true };
const publicPage = { ...signInPage(), username: null, password: null, submit: null };

/**
 * A person signing in on a site with nothing saved: each look shows the next page, and `typed`
 * says what the desktop captured before which look.
 */
const typedVisit = (
  pages: ReadonlyArray<object>,
  typed: Readonly<Record<number, string>>,
  caller: SignInCaller = { kind: "person" },
  typedOn = "https://example.com",
) => {
  const rows = [row("typed", { secrets: {} })];
  const fake = fakeAccounts({ accounts: rows });
  const kept: string[] = [];
  const removed: string[] = [];
  let attemptId = "";
  let look = 0;
  const service = AccountsService.of({
    ...fake.service,
    snapshot: Effect.sync(
      () => ({ accounts: rows, agentAccess: true }) as unknown as AccountsSnapshot,
    ),
    keepTyped: (_accountId, candidate) =>
      Effect.sync(() => {
        kept.push(Redacted.value(candidate.password));
        return "kept" as const;
      }),
    recordUse: () => Effect.void,
    remove: (accountId) => Effect.sync(() => void removed.push(accountId)),
    setAttempt: (attempt) =>
      Effect.sync(() => {
        attemptId = attempt.attemptId;
      }).pipe(Effect.andThen(fake.service.setAttempt(attempt))),
  });
  const send = (password: string) =>
    keepTyped({
      attemptId,
      threadId: scope.threadId,
      tabId: "tab-fixture",
      origin: typedOn,
      path: "/login",
      step: "password",
      username: "",
      password,
    }).pipe(Effect.provideService(AccountsService, service));
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: { readonly operation: string; readonly input: unknown }) =>
      Effect.gen(function* () {
        const input = (request.input ?? {}) as Record<string, unknown>;
        if (request.operation === "accountWaitForLoad" && input.settleMs === 400) {
          look++;
          const password = typed[look];
          if (password !== undefined) yield* send(password).pipe(Effect.orDie);
        }
        if (request.operation === "evaluate") return pages[Math.min(look, pages.length - 1)] as A;
        return {
          tabId: "tab-fixture",
          tabs: [{ tabId: "tab-fixture", url, profileId: "default", ownedByCaller: true }],
        } as A;
      }),
  });
  const run = guardedSignIn({ signIn: rows[0]!, caller }).pipe((effect) =>
    withFixture(effect, service, broker),
  );
  return { run, kept, removed, send, attempts: fake.attempts };
};

it.effect("keeps the one password typed on a sign-in page that then hands back", () =>
  Effect.gen(function* () {
    // An identity provider's page takes the password, then hands back to the signed-in site.
    const visit = typedVisit(
      [
        signInPage("https://login.example.com"),
        { ...signedInPage, origin: "https://www.example.com" },
      ],
      { 1: "right-password" },
      { kind: "person" },
      "https://login.example.com",
    );
    expect((yield* visit.run).outcome).toBe("signed-in");
    expect(visit.kept).toEqual(["right-password"]);
    expect(visit.attempts.size).toBe(0);
  }),
);

it.effect("keeps nothing when it can't tell which password worked", () =>
  Effect.gen(function* () {
    // Two passwords: the second may be right, but nothing proves it.
    const twice = typedVisit([signInPage(), signInPage(), signInPage(), signedInPage], {
      1: "wrong-password",
      3: "right-password",
    });
    expect((yield* twice.run).outcome).toBe("signed-in");
    // A wrong password, then another way in, with the form never seen again.
    const elsewhere = typedVisit(
      [signInPage(), signInPage("https://sso.example.org"), signedInPage],
      { 1: "wrong-password" },
    );
    expect((yield* elsewhere.run).outcome).toBe("signed-in");
    // A wrong password, then a public page: no sign-in was proven.
    const unproven = typedVisit([signInPage(), publicPage], { 1: "wrong-password" });
    expect((yield* unproven.run).outcome).toBe("needs-user");
    expect([...twice.kept, ...elsewhere.kept, ...unproven.kept]).toEqual([]);
  }),
);

it.effect("keeps a wrong password a silent sign-in elsewhere can't be told from", () =>
  Effect.gen(function* () {
    // A wrong password, then a sign-in through a provider the browser was already signed in to:
    // no page asked for anything in between, so this looks like the right password. It is kept,
    // and the service keeps it unverified until Scient signs in with it.
    const visit = typedVisit([signInPage(), signedInPage], { 1: "wrong-password" });
    expect((yield* visit.run).outcome).toBe("signed-in");
    expect(visit.kept).toEqual(["wrong-password"]);
  }),
);

it.effect("never keeps a capture that arrives after the sign-in finished", () =>
  Effect.gen(function* () {
    const visit = typedVisit([signInPage(), signedInPage], {});
    expect((yield* visit.run).outcome).toBe("signed-in");
    expect(yield* visit.send("late-password")).toEqual({ kept: false });
    expect(visit.kept).toEqual([]);
  }),
);

it.effect("a row made for a sign-in that never finished goes again", () =>
  Effect.gen(function* () {
    const visit = typedVisit(
      [signInPage(), publicPage],
      {},
      {
        kind: "person",
        discardIfUnfinished: true,
      },
    );
    expect((yield* visit.run).outcome).toBe("needs-user");
    expect(visit.removed).toEqual(["acc_fixture_typed"]);
    const kept = typedVisit([signInPage(), publicPage], {}, { kind: "person" });
    yield* kept.run;
    expect(kept.removed).toEqual([]);
  }),
);
