import {
  DEFAULT_BROWSER_PROFILE_ID,
  AccountId,
  BrowserProfileId,
  AccountsError,
  EnvironmentId,
  PreviewAutomationTimeoutError,
  PreviewTabId,
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
import { BackgroundPolicy } from "../../../background/BackgroundPolicy.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { fakeAccounts } from "../Accounts.testkit.ts";
import { authorizationDecision } from "../AccountDecisions.ts";
import { CODE_COMING } from "../signInCodes.ts";
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
/** A paper the user asked for, or one an agent's conversation asked for. */
const paper = (asker: "user" | "agent"): SignInCaller => ({
  kind: "paper",
  scope: { ...scope, unattended: true },
  requester: asker === "user" ? {} : { threadId: scope.threadId },
});

/**
 * Accounts that keep each attempt's outcome on its row, and a browser whose sign-in page refuses
 * every password, or waits on `gate` before its first page.
 */
const world = (
  rows: Array<AccountSummary>,
  gate?: { readonly reached: Deferred.Deferred<void>; readonly open: Deferred.Deferred<void> },
  /** Browser operations that fail while listed, as a tab the person holds refuses them. */
  refused: Set<string> = new Set(),
  /** Each row's own saved password; one shared password otherwise. */
  passwords?: Readonly<Record<string, string>>,
  /** The profile of the tab the engine signs in, whatever the row's. */
  tabProfile = "default",
  /** The sign-in page as the site shows it. */
  shown: () => Record<string, unknown> = signInPage,
) => {
  const opened: string[] = [];
  const operations: string[] = [];
  const cleared: Array<ReadonlyArray<string>> = [];
  const resolved: string[] = [];
  const fake = fakeAccounts({ accounts: rows, values: { password: "synthetic-password" } });
  const service = AccountsService.of({
    ...fake.service,
    snapshot: Effect.sync(
      () => ({ accounts: rows, agentAccess: true }) as unknown as AccountsSnapshot,
    ),
    resolveSecrets: (accountId, fields) =>
      Effect.sync(() => void resolved.push(accountId)).pipe(
        Effect.andThen(
          passwords?.[accountId]
            ? Effect.succeed({ password: Redacted.make(passwords[accountId]) })
            : fake.service.resolveSecrets(accountId, fields),
        ),
      ),
    // At the moment of use, from each row's controls as they are now.
    authorizeUse: (decided, target) =>
      Effect.suspend(() => {
        const account = rows.find(
          (candidate) => target.type === "account" && candidate.accountId === target.accountId,
        );
        return account &&
          authorizationDecision(true, account.controls, decided).decision === "allowed"
          ? Effect.void
          : Effect.fail(new AccountsError({ reason: "denied", message: "Synthetic denial." }));
      }),
    // Decided from each row's controls as they are now, as the real service does.
    authorize: (decided, target, action) =>
      Effect.sync(() => {
        fake.calls.push(`authorize:${target.type}:${action}`);
        const account = rows.find(
          (candidate) => target.type === "account" && candidate.accountId === target.accountId,
        );
        return account &&
          authorizationDecision(true, account.controls, decided).decision === "allowed"
          ? ({ decision: "allowed" } as const)
          : ({ decision: "denied", reason: "declined" } as const);
      }),
    recordUse: (entry) =>
      Effect.sync(() => {
        const index = rows.findIndex(
          (account) =>
            entry.target.type === "account" && account.accountId === entry.target.accountId,
        );
        // Settled by version inside the write, as the real service does.
        if (
          index !== -1 &&
          entry.signInOutcome &&
          (entry.version === undefined || rows[index]!.updatedAt === entry.version)
        )
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
    invoke: <A>(request: { readonly operation: string; readonly input?: unknown }) =>
      Effect.gen(function* () {
        operations.push(request.operation);
        if (request.operation === "accountClearCookies")
          cleared.push((request.input as { readonly urls: ReadonlyArray<string> }).urls);
        if (refused.has(request.operation))
          return yield* new PreviewAutomationTimeoutError({
            operation: "close",
            environmentId: EnvironmentId.make("env-fixture"),
            threadId: scope.threadId,
            clientId: "server-browser",
            connectionId: "fixture-connection",
            requestId: "fixture-request",
            timeoutMs: 1_000,
          });
        if (request.operation === "open") {
          opened.push(request.operation);
          if (gate) {
            yield* Deferred.succeed(gate.reached, undefined);
            yield* Deferred.await(gate.open);
          }
        }
        if (request.operation === "evaluate") return { ...shown(), url } as A;
        return {
          tabId: "tab-fixture",
          tabs: [{ tabId: "tab-fixture", url, profileId: tabProfile, ownedByCaller: true }],
        } as A;
      }),
  });
  const run = (
    signIn: AccountSummary | { readonly find: string },
    caller: SignInCaller,
    accounts = service,
  ) =>
    guardedSignIn({ page: { tabId: "tab-fixture" }, signIn, caller }).pipe(
      Effect.provideService(AccountsService, accounts),
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
  return { run, opened, operations, cleared, resolved, service, calls: fake.calls, fake };
};

it.effect("duplicate rows are one sign-in: concurrent calls run the engine once", () =>
  Effect.gen(function* () {
    const rows = [
      row("first"),
      row("second", {
        details: { kind: "website", sites: ["example.com"], username: "Fixture-User" },
      }),
    ];
    const gate = { reached: yield* Deferred.make<void>(), open: yield* Deferred.make<void>() };
    const { run, opened } = world(rows, gate);
    const first = yield* run(rows[0]!, check).pipe(Effect.forkChild);
    yield* Deferred.await(gate.reached);
    const second = yield* run(rows[1]!, paper("user")).pipe(Effect.forkChild);
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
    expect((yield* run(rows[1]!, paper("user"))).outcome).toBe("failed");
    expect(opened).toEqual([]);
  }),
);

it.effect("holds until a user action, and no time lifts it", () =>
  Effect.gen(function* () {
    const rows = [row("held", at("needs-you"))];
    const { run, opened } = world(rows);
    yield* TestClock.adjust("30 days");
    for (const caller of [page, paper("user")])
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
    expect((yield* run(rows[0], paper("user"))).outcome).toBe("password-rejected");
    expect((yield* run(rows[0], paper("user"))).outcome).toBe("failed");
    // Check is a press: it tries once more.
    expect((yield* run(rows[0], check)).outcome).toBe("password-rejected");
    expect(opened).toHaveLength(2);
  }),
);

it.effect("never signs back in by itself after the person signed out; their press does", () =>
  Effect.gen(function* () {
    const rows = [row("out", { signIn: { state: "signed-out", at: iso(0), by: "action" } })];
    const { run, opened } = world(rows);
    for (const caller of [page, check, paper("user"), { kind: "connector" } as const])
      expect(yield* run(rows[0]!, caller)).toMatchObject({
        outcome: "needs-user",
        message: expect.stringContaining("signed out on purpose"),
      });
    expect(opened).toEqual([]);
    yield* run(rows[0]!, { kind: "person" });
    expect(opened).not.toEqual([]);
  }),
);

it.effect("never ends the person's own session on a one-session site; asks them once", () =>
  Effect.gen(function* () {
    const rows = [
      row("one", {
        details: {
          kind: "website",
          sites: ["example.com"],
          username: "Fixture-User",
          oneSession: true,
        },
        signIn: { state: "signed-out", at: iso(0) },
      }),
    ];
    const { run, opened, fake } = world(rows);
    for (const caller of [{ kind: "connector" } as const, { kind: "renewal" } as const])
      expect(yield* run(rows[0]!, caller)).toMatchObject({
        outcome: "needs-user",
        message: expect.stringContaining("keeps one session"),
      });
    expect(opened).toEqual([]);
    expect([...fake.needs.keys()]).toEqual([`sign-in:${rows[0]!.accountId}`]);
    // The person's own sign-in goes ahead.
    yield* run(rows[0]!, { kind: "person" });
    expect(opened).not.toEqual([]);
  }),
);

it.effect("says a code is coming before a sign-in it starts by itself may send one", () =>
  Effect.gen(function* () {
    const rows = [row("gov", { signIn: { state: "signed-out", at: iso(0) } })];
    const { run, operations, service } = world(rows);
    const watched = AccountsService.of({
      ...service,
      setNeedsYou: (need) => Effect.sync(() => void operations.push(`needs:${need.detail}`)),
      clearNeedsYou: (needId) => Effect.sync(() => void operations.push(`cleared:${needId}`)),
    });
    // Someone is at a window: upkeep of a row that may send a code goes on, after the notice.
    const present = { snapshot: Effect.succeed({ activeForegroundLeaseCount: 1 }) };
    yield* run(rows[0]!, { kind: "renewal" }, watched).pipe(
      Effect.provideService(BackgroundPolicy, present as unknown as BackgroundPolicy["Service"]),
    );
    const announced = operations.indexOf(`needs:${CODE_COMING}`);
    // regression: gov.il texted a code nobody expected, from a renewal the person never saw.
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(announced).toBeLessThan(operations.indexOf("accountType"));
    // The site refused the password: the notice goes, nothing is coming after all.
    expect(operations.at(-1)).toBe(`cleared:sign-in:${rows[0]!.accountId}`);
    // Code-free before, but nobody at a window: a site may start texting, so it still says so.
    const fresh = [row("gov", { signIn: { state: "signed-out", at: iso(0) } })];
    const away = world(fresh);
    yield* away.run(
      fresh[0]!,
      { kind: "connector" },
      AccountsService.of({
        ...away.service,
        signInFactors: Effect.succeed({ [fresh[0]!.accountId]: "none" }),
        setNeedsYou: (need) => Effect.sync(() => void away.operations.push(`needs:${need.detail}`)),
      }),
    );
    expect(away.operations).toContain(`needs:${CODE_COMING}`);
    // A pinned task's look keeps that rule; upkeep signs the same quiet row in silently.
    for (const [caller, says] of [
      [{ kind: "renewal", task: "task:hours" }, true],
      [{ kind: "renewal" }, false],
    ] as const) {
      const quiet = [row("gov", { signIn: { state: "signed-out", at: iso(0) } })];
      const pinned = world(quiet);
      yield* pinned.run(
        quiet[0]!,
        caller,
        AccountsService.of({
          ...pinned.service,
          signInFactors: Effect.succeed({ [quiet[0]!.accountId]: "none" }),
          setNeedsYou: (need) =>
            Effect.sync(() => void pinned.operations.push(`needs:${need.detail}`)),
        }),
      );
      expect(pinned.operations.includes(`needs:${CODE_COMING}`)).toBe(says);
    }
    // A notice that can't be published means nothing is typed.
    const again = [row("gov", { signIn: { state: "signed-out", at: iso(0) } })];
    const unpublished = world(again);
    expect(
      yield* unpublished.run(
        again[0]!,
        { kind: "connector" },
        AccountsService.of({
          ...unpublished.service,
          setNeedsYou: () =>
            Effect.fail(new AccountsError({ reason: "unavailable", message: "Synthetic." })),
        }),
      ),
    ).toMatchObject({ outcome: "failed" });
    expect(unpublished.operations).not.toContain("accountType");
  }),
);

it.effect("never signs back in by itself where the person signed out on purpose", () =>
  Effect.gen(function* () {
    const rows = [row("signed-out")];
    const { run, opened, service } = world(rows);
    const signedOut = AccountsService.of({
      ...service,
      // Recorded by Accounts' Sign out, apart from what other computers are sent.
      signedOut: Effect.succeed([{ profileId: DEFAULT_BROWSER_PROFILE_ID, site: "example.com" }]),
    });
    for (const caller of [page, paper("user")])
      expect((yield* run(rows[0]!, caller, signedOut)).outcome).toBe("failed");
    expect(opened).toEqual([]);
    // The person's own press signs in.
    expect((yield* run(rows[0]!, check, signedOut)).outcome).toBe("password-rejected");
  }),
);

it.effect("a refusal of a password changed meanwhile is never held against the new one", () =>
  Effect.gen(function* () {
    const rows = [row("changing")];
    const { run, service } = world(rows);
    const changing = AccountsService.of({
      ...service,
      // The person saves a new password while Scient is typing the old one.
      resolveSecrets: (accountId, fields) =>
        service.resolveSecrets(accountId, fields).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              rows[0] = { ...rows[0]!, updatedAt: "2026-02-01T00:00:00.000Z" };
            }),
          ),
        ),
    });
    expect((yield* run(rows[0]!, check, changing)).outcome).toBe("password-rejected");
    expect(rows[0]!.signIn).toBeUndefined();
  }),
);

it.effect("a sign-in that finishes after the person signed out records nothing", () =>
  Effect.gen(function* () {
    const rows = [row("racing")];
    const { run, service } = world(rows);
    let reads = 0;
    const racing = AccountsService.of({
      ...service,
      // Not signed out when the attempt starts; signed out by the time it ends.
      signedOut: Effect.sync(() =>
        reads++ < 2 ? [] : [{ profileId: DEFAULT_BROWSER_PROFILE_ID, site: "example.com" }],
      ),
    });
    const before = rows[0]!.signIn;
    const result = yield* run(rows[0]!, paper("user"), racing);
    expect(result.outcome).toBe("failed");
    expect(rows[0]!.signIn).toEqual(before);
  }),
);

it.effect("a sign-out made and undone mid sign-in still ends it, and takes its session along", () =>
  Effect.gen(function* () {
    const rows = [
      row("late", {
        details: {
          kind: "website",
          sites: ["example.com", "https://login.example.com:8443"],
          username: "Fixture-User",
        },
      }),
    ];
    const { run, operations, cleared, service } = world(rows);
    let sequence = 0;
    const late = AccountsService.of({
      ...service,
      // The person signs out once the attempt is under way, then signs in by hand elsewhere: no
      // sign-out stands by the time it ends, but one was made meanwhile.
      signedOut: Effect.succeed([]),
      signOutSequence: Effect.sync(() => sequence),
      signOutsSince: (since) =>
        Effect.sync(() => {
          sequence = 1;
          return since < 1 ? [{ profileId: DEFAULT_BROWSER_PROFILE_ID, site: "example.com" }] : [];
        }),
    });
    const before = rows[0]!.signIn;
    const result = yield* run(rows[0]!, paper("user"), late);
    expect(result.outcome).toBe("failed");
    expect(rows[0]!.signIn).toEqual(before);
    // Nothing was sent after it, and whatever the answer left in the tab's jar went with the tab.
    expect(operations).not.toContain("click");
    // Cleared, cleared again once late answers landed, then closed; status reads only look.
    expect(operations.filter((operation) => operation !== "status").slice(-4)).toEqual([
      "accountClearCookies",
      "accountWaitForLoad",
      "accountClearCookies",
      "close",
    ]);
    // Each saved site once, an origin as it was saved.
    expect(cleared.at(-1)).toEqual(["https://example.com/", "https://login.example.com:8443/"]);
  }),
);

it.effect("a late university session keeps another membership's OpenAthens session", () =>
  Effect.gen(function* () {
    const huji = row("huji", {
      details: {
        kind: "website",
        sites: ["huji.ac.il"],
        username: "person@mail.huji.ac.il",
        institution: {
          name: "Hebrew University",
          entityId: "https://idp.huji.ac.il/openathens",
          domain: "huji.ac.il",
        },
      },
    });
    const tau = row("tau", {
      name: "Tel Aviv University",
      details: {
        kind: "website",
        sites: ["tau.ac.il"],
        username: "person@tauex.tau.ac.il",
        proxyUrl: "https://go.openathens.net/redirector/tau.ac.il?url={url}",
      },
    });
    const rows = [huji, tau];
    const { run, cleared, service } = world(rows);
    let sequence = 0;
    const late = AccountsService.of({
      ...service,
      signedOut: Effect.succeed([]),
      signOutSequence: Effect.sync(() => sequence),
      signOutsSince: (since) =>
        Effect.sync(() => {
          sequence = 1;
          return since < 1 ? [{ profileId: DEFAULT_BROWSER_PROFILE_ID, site: "huji.ac.il" }] : [];
        }),
    });
    yield* run(huji, paper("user"), late);
    // As Sign out clears it: the university's own site, and OpenAthens stays for Tel Aviv.
    expect(cleared.at(-1)).toEqual(["https://huji.ac.il/"]);
  }),
);

it.effect(
  "a late session in a reused tab clears by that tab's profile, keeping its OpenAthens",
  () =>
    Effect.gen(function* () {
      const huji = row("huji", {
        details: {
          kind: "website",
          sites: ["huji.ac.il"],
          username: "person@mail.huji.ac.il",
          institution: {
            name: "Hebrew University",
            entityId: "https://idp.huji.ac.il/openathens",
            domain: "huji.ac.il",
          },
        },
      });
      // Tel Aviv's OpenAthens membership is only in the work profile, where the tab is.
      const tau = row("tau", {
        name: "Tel Aviv University",
        details: {
          kind: "website",
          sites: ["tau.ac.il"],
          username: "person@tauex.tau.ac.il",
          profileId: BrowserProfileId.make("work"),
          proxyUrl: "https://go.openathens.net/redirector/tau.ac.il?url={url}",
        },
      });
      const { run, cleared, service } = world([huji, tau], undefined, new Set(), undefined, "work");
      let sequence = 0;
      const late = AccountsService.of({
        ...service,
        signedOut: Effect.succeed([]),
        signOutSequence: Effect.sync(() => sequence),
        signOutsSince: (since) =>
          Effect.sync(() => {
            sequence = 1;
            return since < 1
              ? [{ profileId: BrowserProfileId.make("work"), site: "huji.ac.il" }]
              : [];
          }),
      });
      yield* run(huji, paper("user"), late);
      expect(cleared.at(-1)).toEqual(["https://huji.ac.il/"]);
    }),
);

it.effect("a late session that can't be cleared keeps its tab private until it can", () =>
  Effect.gen(function* () {
    const rows = [row("stuck")];
    const refused = new Set(["accountClearCookies"]);
    const { run, operations, service, fake } = world(rows, undefined, refused);
    const late = AccountsService.of({
      ...service,
      signedOut: Effect.succeed([{ profileId: DEFAULT_BROWSER_PROFILE_ID, site: "example.com" }]),
      // Not yet signed out when the attempt is admitted.
      signOutSequence: Effect.succeed(0),
    });
    let admitted = false;
    const racing = AccountsService.of({
      ...late,
      signedOut: Effect.suspend(() => {
        const first = !admitted;
        admitted = true;
        return first ? Effect.succeed([]) : late.signedOut;
      }),
    });
    yield* run(rows[0]!, paper("user"), racing);
    const privateTab = () =>
      [...fake.attempts.values()].some(({ tabId }) => tabId === "tab-fixture");
    expect(privateTab()).toBe(true);
    expect(operations).not.toContain("close");
    // The browser lets go: the session is cleared twice and the tab closed, then released.
    refused.clear();
    yield* TestClock.adjust("2 seconds");
    expect(operations.slice(-4)).toEqual([
      "accountClearCookies",
      "accountWaitForLoad",
      "accountClearCookies",
      "close",
    ]);
    expect(privateTab()).toBe(false);
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
    const { run, resolved, opened } = world(rows);
    expect((yield* run(rows[0]!, page)).outcome).toBe("failed");
    expect((yield* run(rows[1]!, check)).outcome).toBe("limited");
    expect(opened).toEqual([]);
    // The person's own Sign in still opens the page, with nothing saved to type.
    yield* run(rows[1]!, { kind: "person" });
    expect(opened).toHaveLength(1);
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

it.effect("a connector signs in again once its session outlived the short pause", () =>
  Effect.gen(function* () {
    const rows = [row("worked", at("signed-in"))];
    const { run, resolved } = world(rows);
    const connector: SignInCaller = { kind: "connector" };
    // Ended right after signing in: something keeps ending it.
    expect(yield* run(rows[0]!, connector)).toMatchObject({
      message: expect.stringContaining("moments ago"),
    });
    expect(resolved).toEqual([]);
    // A session that lasted a few minutes ended normally; the page caller still waits longer.
    yield* TestClock.adjust("3 minutes");
    expect(yield* run(rows[0]!, page)).toMatchObject({
      message: expect.stringContaining("moments ago"),
    });
    const renewed = yield* run(rows[0]!, connector);
    expect("message" in renewed ? renewed.message : "").not.toContain("moments ago");
    expect(resolved).not.toEqual([]);
  }),
);

it.effect("a refused password falls back once to a copy whose password differs, once a day", () =>
  Effect.gen(function* () {
    const copy = (id: string, profileId: string) =>
      row(id, {
        details: { kind: "website", sites: ["example.com"], username: "Fixture-User", profileId },
      });
    const rows = [copy("lab", "profile-lab"), copy("home", "profile-home"), copy("third", "x")];
    const [lab, home, third] = rows.map((account) => account.accountId);
    const { run } = world(rows, undefined, new Set(), {
      [lab!]: "synthetic-one",
      [home!]: "synthetic-two",
      [third!]: "synthetic-three",
    });
    // The page refuses every password: the lab copy, then the home copy's different one.
    expect(yield* run(rows[0]!, check)).toMatchObject({
      outcome: "password-rejected",
      accountId: home,
    });
    // A second press the same day gets no second fallback, though the third copy differs too.
    expect(yield* run(rows[0]!, check)).toMatchObject({ accountId: lab });
  }),
);

it.effect("account controls decide every resolve, read again when the attempt starts", () =>
  Effect.gen(function* () {
    const controls = (access: "allowed" | "ask" | "off") => ({
      controls: { ...defaultAccountControls("website"), access },
    });
    const typed = (rows: Array<AccountSummary>, caller: SignInCaller) =>
      Effect.gen(function* () {
        const { run, operations } = world(rows);
        yield* run(rows[0]!, caller);
        return operations.includes("accountType");
      });
    const id = (patch: Partial<AccountSummary>) => [row("controls", patch)];
    // A page signs in only with Allowed; an agent's paper the same.
    expect(yield* typed(id(controls("ask")), page)).toBe(false);
    expect(yield* typed(id(controls("ask")), paper("agent"))).toBe(false);
    expect(yield* typed(id(controls("allowed")), paper("agent"))).toBe(true);
    // The user's own paper and Check use any saved sign-in: Off governs agents only.
    for (const access of ["ask", "off"] as const)
      for (const caller of [check, paper("user")])
        expect(yield* typed(id(controls(access)), caller)).toBe(true);
    expect(yield* typed(id(controls("off")), page)).toBe(false);
    // An agent is asked through `authorize`, whose Off refuses.
    const { run, calls } = world(id(controls("allowed")));
    yield* run(row("controls"), { kind: "agent", scope });
    expect(calls).toContain("authorize:account:sign-in");
    // Turned Off while another attempt on the site was running: nothing is typed.
    const rows = id(controls("allowed"));
    const gate = { reached: yield* Deferred.make<void>(), open: yield* Deferred.make<void>() };
    const waiting = world(rows, gate);
    const first = yield* waiting.run(rows[0]!, paper("agent")).pipe(Effect.forkChild);
    yield* Deferred.await(gate.reached);
    const second = yield* waiting.run(rows[0]!, paper("agent")).pipe(Effect.forkChild);
    rows[0] = { ...rows[0]!, ...controls("off") };
    yield* Deferred.succeed(gate.open, undefined);
    yield* Fiber.join(first);
    expect((yield* Fiber.join(second)).outcome).not.toBe("signed-in");
    expect(waiting.resolved).toHaveLength(1);
    // An agent's Add sign-in and a linked connector, turned Off once admitted: nothing is typed.
    const callers: ReadonlyArray<SignInCaller> = [
      { kind: "person", agent: scope },
      { kind: "connector" },
    ];
    for (const caller of callers) {
      const added = id(controls("allowed"));
      const held = { reached: yield* Deferred.make<void>(), open: yield* Deferred.make<void>() };
      const adding = world(added, held);
      const signingIn = yield* adding.run(added[0]!, caller).pipe(Effect.forkChild);
      yield* Deferred.await(held.reached);
      added[0] = { ...added[0]!, ...controls("off") };
      yield* Deferred.succeed(held.open, undefined);
      yield* Fiber.join(signingIn);
      expect(adding.operations).not.toContain("accountType");
    }
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
    // An agent's paper never types into a sign-in that is Off.
    here[1] = { ...here[1]!, controls: { ...here[1]!.controls, access: "off" } };
    expect((yield* world(here).run({ find: url }, paper("agent"))).outcome).toBe(
      "password-rejected",
    );
  }),
);

/** A site that asks for a code after the password; the person may answer it in the tab. */
const codeSite = (rows: Array<AccountSummary>) => {
  const site = {
    phase: "login" as "login" | "code" | "done",
    gone: false,
    passwords: 0,
    opens: 0,
    closed: [] as string[],
    /** The browser refuses to close the tab, as under the person's control. */
    closeRefused: false,
    /** The tab goes as the site moves to its code step, before the sign-in can keep it. */
    goesAtCode: false,
    /** The tab goes, and its close is told, while the sign-in registers keeping it. */
    goesWhileKept: false,
  };
  const fake = fakeAccounts({ accounts: rows, values: { password: "synthetic-password" } });
  const service = AccountsService.of({
    ...fake.service,
    snapshot: Effect.sync(
      () => ({ accounts: rows, agentAccess: true }) as unknown as AccountsSnapshot,
    ),
    // The close handler's work (`settleKeptOnClose`), run where it may land: before the write.
    setAttempt: (attempt) =>
      (site.goesWhileKept && attempt.state === "pending"
        ? fake.service.signInAttempts.pipe(
            Effect.flatMap(({ pending }) => {
              site.gone = true;
              const closing = [...pending].filter(([, kept]) => kept.tabId === attempt.tabId);
              for (const [key] of closing) pending.delete(key);
              return Effect.forEach(
                closing,
                ([, kept]) => fake.service.removeAttempt(kept.attemptId),
                {
                  discard: true,
                },
              );
            }),
          )
        : Effect.void
      ).pipe(Effect.andThen(fake.service.setAttempt(attempt))),
    recordUse: (entry) =>
      Effect.sync(() => {
        const index = rows.findIndex(
          (account) =>
            entry.target.type === "account" && account.accountId === entry.target.accountId,
        );
        // Settled by version inside the write, as the real service does.
        if (
          index !== -1 &&
          entry.signInOutcome &&
          (entry.version === undefined || rows[index]!.updatedAt === entry.version)
        )
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
    invoke: <A>(request: {
      readonly operation: string;
      readonly input: unknown;
      readonly tabId?: string;
    }) =>
      request.operation === "close" && site.closeRefused
        ? Effect.sync(() => void site.closed.push("refused")).pipe(
            Effect.andThen(
              Effect.fail(
                new PreviewAutomationTimeoutError({
                  operation: "close",
                  environmentId: EnvironmentId.make("env-fixture"),
                  threadId: scope.threadId,
                  clientId: "server-browser",
                  connectionId: "fixture-connection",
                  requestId: "fixture-request",
                  timeoutMs: 1_000,
                }),
              ),
            ),
          )
        : Effect.sync(() => {
            const input = (request.input ?? {}) as Record<string, unknown>;
            // A new page opens in a tab of its own.
            if (request.operation === "open" && input.url) {
              site.opens++;
              site.gone = false;
            }
            if (request.operation === "close") {
              site.closed.push("closed");
              if ((request.tabId ?? "tab-fixture") === "tab-fixture") site.gone = true;
            }
            if (request.operation === "accountType" && input.selector === "#password")
              site.passwords++;
            if (request.operation === "click" && site.phase === "login") {
              site.phase = "code";
              if (site.goesAtCode) site.gone = true;
            }
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
            // As the browser answers for a tab it no longer has.
            return (
              site.gone
                ? { available: false, tabId: null }
                : {
                    tabId: "tab-fixture",
                    tabs: [
                      { tabId: "tab-fixture", url, profileId: "default", ownedByCaller: true },
                    ],
                  }
            ) as A;
          }),
  });
  const run = (signIn: AccountSummary, caller: SignInCaller) =>
    guardedSignIn({ signIn, caller }).pipe((effect) => withFixture(effect, service, broker));
  return {
    run,
    site,
    attempts: fake.attempts,
    needs: fake.needs,
    store: fake.service.signInAttempts,
  };
};

it.effect("a paper stopped at a code waits there; the press resumes it, one password in all", () =>
  Effect.gen(function* () {
    const rows = [row("code")];
    const { run, site, attempts, needs } = codeSite(rows);
    expect(yield* run(rows[0]!, paper("user"))).toMatchObject({
      outcome: "needs-user",
      pending: true,
    });
    // Nobody was there: the person is asked once, naming the step, until a sign-in clears it.
    expect([...needs.values()]).toMatchObject([
      { needId: `sign-in:${rows[0]!.accountId}`, detail: "Enter the code" },
    ]);
    // In its tab's profile, whose sessions stay there while it waits.
    expect([...attempts.values()]).toMatchObject([
      { tabId: "tab-fixture", state: "pending", profileId: "default" },
    ]);
    // Nothing automatic tries again while it waits.
    expect((yield* run(rows[0]!, paper("user"))).outcome).toBe("failed");
    // The person answers the code in the kept tab.
    site.phase = "done";
    expect((yield* run(rows[0]!, { kind: "person" })).outcome).toBe("signed-in");
    expect(site.passwords).toBe(1);
    expect(site.opens).toBe(0);
    expect(attempts.size).toBe(0);
    expect(needs.size).toBe(0);
  }),
);

it.effect("leaves a kept attempt whose code the site may still have to the person", () =>
  Effect.gen(function* () {
    const rows = [
      row("with-site"),
      row("newcomer", {
        details: { kind: "website", sites: ["example.com"], username: "Another-User" },
      }),
    ];
    const { run, site, store, attempts } = codeSite(rows);
    yield* run(rows[0]!, paper("user"));
    const { pending } = yield* store;
    const [key, kept] = [...pending][0]!;
    pending.set(key, {
      ...kept,
      submissions: [
        ...kept.submissions,
        { origin: "https://example.com", fields: ["otp"], otpPeriod: undefined, unanswered: true },
      ],
    });
    // Past the row's own hold, as an attended agent or a newer record would be.
    rows[0] = { ...rows[0]!, signIn: undefined };
    // regression: a new attempt by itself ended the kept one, closing its tab under the code; an
    // agent in the attempt's own thread resumed it, and its failure uncovered the tab.
    for (const caller of [{ kind: "renewal" } as const, check, { kind: "agent", scope } as const]) {
      const result = yield* run(rows[0]!, caller);
      // Still covered, so closed to agents.
      expect([...attempts.values()]).toMatchObject([{ tabId: "tab-fixture", state: "pending" }]);
      expect(result).toMatchObject({
        outcome: "needs-user",
        message: "Finish signing in on the site's page.",
      });
    }
    expect(site.closed).toEqual([]);
    expect(pending.get(key)?.tabId).toBe("tab-fixture");
    // The oldest of a full set, it is kept when another attempt makes room: the next one goes.
    for (const other of ["a", "b", "c"])
      pending.set(`other:${other}`, {
        ...kept,
        attemptId: `attempt:${other}`,
        tabId: PreviewTabId.make(`tab-${other}`),
      });
    site.phase = "login";
    expect(yield* run(rows[1]!, paper("user"))).toMatchObject({ pending: true });
    expect(pending.has(key)).toBe(true);
    expect(pending.has("other:a")).toBe(false);
    expect(site.closed).toEqual(["closed"]);
  }),
);

/** A code-site sign-in kept for the person, its code marked as maybe still with the site. */
const keptWithSite = (id: string) =>
  Effect.gen(function* () {
    const rows = [row(id)];
    const fixture = codeSite(rows);
    yield* fixture.run(rows[0]!, paper("user"));
    const { pending } = yield* fixture.store;
    const [key, kept] = [...pending][0]!;
    pending.set(key, {
      ...kept,
      submissions: [
        ...kept.submissions,
        { origin: "https://example.com", fields: ["otp"], otpPeriod: undefined, unanswered: true },
      ],
    });
    // Past the row's own hold, as an attended agent or a newer record would be.
    rows[0] = { ...rows[0]!, signIn: undefined };
    return { ...fixture, rows, pending, key, kept };
  });

it.effect("ends a kept attempt whose tab closed, so a renewal or connector goes on", () =>
  Effect.gen(function* () {
    for (const caller of [{ kind: "renewal" } as const, { kind: "connector" } as const]) {
      const { run, rows, site, attempts, pending, key, kept } = yield* keptWithSite(
        `closed-${caller.kind}`,
      );
      // regression: the record outlived its tab, so the login waited on a page nobody could see.
      site.gone = true;
      const result = yield* run(rows[0]!, caller);
      expect(result).not.toMatchObject({ message: "Finish signing in on the site's page." });
      expect(pending.get(key)?.attemptId).not.toBe(kept.attemptId);
      expect([...attempts.keys()]).not.toContain(kept.attemptId);
    }
  }),
);

it.effect("ends any kept attempt past the person's hand-off, closing its tab", () =>
  Effect.gen(function* () {
    const { site, attempts, pending, key } = yield* keptWithSite("aged").pipe(
      Effect.tap(({ pending, key, kept }) =>
        // As kept: the timer is the attempt's own.
        Effect.sync(() => pending.set(key, kept)),
      ),
    );
    yield* TestClock.adjust("14 minutes");
    expect(pending.has(key)).toBe(true);
    // regression: a kept attempt had no end but its tab, and could hold the login for good.
    yield* TestClock.adjust("1 minute");
    expect(pending.has(key)).toBe(false);
    expect(site.closed).toEqual(["closed"]);
    expect(attempts.size).toBe(0);
  }),
);

it.effect("never keeps an attempt whose tab closed before it was kept", () =>
  Effect.gen(function* () {
    for (const goes of ["goesAtCode", "goesWhileKept"] as const) {
      const rows = [row(`closing-${goes}`)];
      const { run, site, store, attempts } = codeSite(rows);
      site[goes] = true;
      // regression: a close before the keep, or told while it registered, left a kept record
      // that held the login and the profile until it aged out.
      expect(yield* run(rows[0]!, paper("user"))).not.toMatchObject({ pending: true });
      expect((yield* store).pending.size).toBe(0);
      // Nothing registered: a profile change finds no sign-in under way.
      expect(attempts.size).toBe(0);
      site[goes] = false;
      rows[0] = { ...rows[0]!, signIn: undefined };
      expect(yield* run(rows[0]!, { kind: "renewal" })).not.toMatchObject({
        message: "Finish signing in on the site's page.",
      });
    }
  }),
);

it.effect("keeps a kept attempt's cover past its age while its tab won't close", () =>
  Effect.gen(function* () {
    const { site, attempts, pending, key } = yield* keptWithSite("held").pipe(
      Effect.tap(({ pending, key, kept }) => Effect.sync(() => pending.set(key, kept))),
    );
    site.closeRefused = true;
    // regression: expiry dropped the record before the close, which the browser then refused,
    // so the tab, code and all, was open to agents.
    yield* TestClock.adjust("15 minutes");
    expect(site.closed).toEqual(["refused"]);
    expect(pending.has(key)).toBe(true);
    expect([...attempts.values()]).toMatchObject([{ tabId: "tab-fixture", state: "pending" }]);
  }),
);

it.effect("with the kept tab gone, the press is one fresh attempt", () =>
  Effect.gen(function* () {
    const rows = [row("gone")];
    const { run, site } = codeSite(rows);
    yield* run(rows[0]!, paper("user"));
    site.gone = true;
    site.phase = "login";
    expect(yield* run(rows[0]!, { kind: "person" })).toMatchObject({ outcome: "needs-user" });
    expect(site.passwords).toBe(2);
    // A new page for the fresh attempt; the first one stayed on the tab it was given.
    expect(site.opens).toBe(1);
  }),
);

/** A person signing in to their university: its page asks for a password, then hands back. */
const universityVisit = (
  rows: Array<AccountSummary>,
  checkSees: string,
  startAt: "idp" | "back" = "idp",
) => {
  const seen = {
    phase: startAt,
    closed: [] as string[],
    saved: [] as unknown[],
    /** Whether the person tab's attempt was still registered when the tab closed. */
    attemptWhenClosed: [] as boolean[],
    /** The profile each hidden check opened in. */
    checkedIn: [] as unknown[],
  };
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
        if (request.operation === "close" && request.tabId) {
          seen.closed.push(request.tabId);
          if (request.tabId === "tab-person")
            seen.attemptWhenClosed.push(
              [...fake.attempts.values()].some(({ tabId }) => tabId === "tab-person"),
            );
        }
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
        // The hidden check opens a tab of its own.
        if (request.operation === "open" && input.open === false) {
          seen.checkedIn.push(input.profileId);
          return { tabId: "tab-check", tabs: [] } as A;
        }
        const shown =
          seen.phase === "idp" ? "https://idp.example.edu/login" : "https://www.nature.com/";
        // The browser's default for new tabs is Work; the sign-in's tab opened in Main.
        return {
          tabId: "tab-person",
          defaultProfileId: "work",
          tabs: [{ tabId: "tab-person", url: shown, profileId: "default" }],
        } as A;
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
    // The publisher that asked is no place to leave the person; it stays covered until it closes.
    expect(visit.seen.closed).toContain("tab-person");
    expect(visit.seen.attemptWhenClosed).toEqual([true]);
  }),
);

it.effect("a fresh check that meets the login wall only looks, so the sign-in still ends", () =>
  Effect.gen(function* () {
    const rows = [
      row("library", {
        details: {
          kind: "website",
          sites: ["example.edu"],
          proxyUrl: "https://login.ezproxy.example.edu/login?url={url}",
        },
      }),
    ];
    // A saved password and a check that lands on the sign-in page: no second sign-in inside this one.
    const visit = universityVisit(rows, "https://login.ezproxy.example.edu/login", "back");
    expect(yield* visit.run).toMatchObject({ outcome: "needs-user" });
    expect(visit.seen.closed).toContain("tab-person");
  }),
);

it.effect("a library link already signed in counts once a fresh check comes back through it", () =>
  Effect.gen(function* () {
    const rows = [
      row("library", {
        secrets: {},
        details: {
          kind: "website",
          sites: ["example.edu"],
          proxyUrl: "https://login.ezproxy.example.edu/login?url={url}",
        },
      }),
    ];
    const visit = universityVisit(rows, "https://www-nature-com.ezproxy.example.edu/", "back");
    expect((yield* visit.run).outcome).toBe("signed-in");
    expect(visit.continued()).toBe(true);
    // It names no profile: the check looks where the sign-in opened, not the browser's default.
    expect(visit.seen.checkedIn).toEqual(["default"]);
  }),
);

const signedInPage = { ...signInPage(), username: null, password: null, signedIn: true };
const publicPage = { ...signInPage(), username: null, password: null, submit: null };

/**
 * A person signing in: each look shows the next page, and `typed` says what the desktop captured
 * before which look. `saved` gives the row a saved password Scient types.
 */
const typedVisit = (
  pages: ReadonlyArray<object>,
  typed: Readonly<Record<number, string | ReadonlyArray<string>>>,
  caller: SignInCaller = { kind: "person" },
  typedOn = "https://example.com",
  saved = false,
) => {
  const rows = [row("typed", saved ? {} : { secrets: {} })];
  const fake = fakeAccounts({
    accounts: rows,
    ...(saved ? { values: { password: "synthetic-password" } } : {}),
  });
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
    remove: (accountId) =>
      Effect.sync(() => {
        removed.push(accountId);
        return { removalId: "synthetic-removal" };
      }),
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
        // A look ends on the person's own wait, or, with a saved password, on Scient's submit.
        const scientTyped = saved && request.operation === "click";
        if (scientTyped || (request.operation === "accountWaitForLoad" && input.settleMs === 400)) {
          look++;
          for (const password of [typed[look] ?? []].flat())
            yield* send(password).pipe(Effect.orDie);
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

it.effect("keeps the password while a look sees its own page still waiting for the answer", () =>
  Effect.gen(function* () {
    // The person submits on the first page load; a look meanwhile sees that same load's form, and
    // the next page is signed in. A new load bringing the form back would have been an ask.
    const visit = typedVisit(
      [
        { ...signInPage(), document: 1 },
        { ...signInPage(), document: 1 },
        { ...signedInPage, document: 2 },
      ],
      { 1: "right-password" },
    );
    expect((yield* visit.run).outcome).toBe("signed-in");
    expect(visit.kept).toEqual(["right-password"]);
    const askedAgain = typedVisit(
      [
        { ...signInPage(), document: 1 },
        { ...signInPage(), document: 2 },
        { ...signedInPage, document: 3 },
      ],
      { 1: "wrong-password" },
    );
    expect((yield* askedAgain.run).outcome).toBe("signed-in");
    expect(askedAgain.kept).toEqual([]);
    // The same load says it refused the password: that submission didn't sign in.
    const refused = typedVisit(
      [
        { ...signInPage(), document: 1 },
        { ...signInPage(), document: 1, refused: true },
        { ...signedInPage, document: 2 },
      ],
      { 1: "wrong-password" },
    );
    expect((yield* refused.run).outcome).toBe("signed-in");
    expect(refused.kept).toEqual([]);
    // The banner was there before the person's retry, from Scient's own refused attempt: the
    // same load still showing it while the retry is answered says nothing of the retry.
    const retried = typedVisit(
      [
        { ...signInPage(), document: 1, refused: true },
        { ...signInPage(), document: 1, refused: true },
        { ...signInPage(), document: 1, refused: true },
        { ...signedInPage, document: 2 },
      ],
      { 2: "right-password" },
    );
    expect((yield* retried.run).outcome).toBe("signed-in");
    expect(retried.kept).toEqual(["right-password"]);
    // The old banner goes while the retry is answered, then a refusal shows again: that one is the
    // retry's.
    const refusedAgain = typedVisit(
      [
        { ...signInPage(), document: 1, refused: true },
        { ...signInPage(), document: 1, refused: true },
        { ...signInPage(), document: 1 },
        { ...signInPage(), document: 1, refused: true },
        { ...signedInPage, document: 2 },
      ],
      { 2: "wrong-password" },
    );
    expect((yield* refusedAgain.run).outcome).toBe("signed-in");
    expect(refusedAgain.kept).toEqual([]);
  }),
);

it.effect("keeps the person's own password typed on the page where Scient typed a wrong one", () =>
  Effect.gen(function* () {
    // Scient types the saved password, and its capture comes back: no person's. The person types
    // the right one on the same page, and it signs in.
    const visit = typedVisit(
      [signInPage(), signedInPage],
      { 1: ["synthetic-password", "right-password"] },
      { kind: "person" },
      "https://example.com",
      true,
    );
    expect((yield* visit.run).outcome).toBe("signed-in");
    expect(visit.kept).toEqual(["right-password"]);
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

it.effect("with Renew sign-ins automatically off, only the person's own click signs in", () =>
  Effect.gen(function* () {
    const off = (rows: Array<AccountSummary>, service: AccountsService["Service"]) =>
      AccountsService.of({ ...service, renewAutomatically: Effect.succeed(false) });
    // A connector's recovery: Scient's own, in the background.
    const connector = [row("portal", at("signed-out"))];
    const recovery = world(connector);
    const refused = yield* recovery.run(
      connector[0]!,
      { kind: "connector" },
      off(connector, recovery.service),
    );
    // regression: an expired connector signed in by itself with the switch off.
    expect(refused).toMatchObject({
      outcome: "failed",
      message: "Renew sign-ins automatically is off, so Scient didn't sign in to Fixture.",
    });
    expect(recovery.operations).not.toContain("accountType");
    // A scheduled task the person made doesn't sign in either: it waits for them in Needs you.
    for (const caller of [
      { kind: "agent", scope: { ...scope, unattended: true, scheduledTaskId: "task:hours" } },
      { kind: "renewal", task: "task:hours" },
    ] as const) {
      const rows = [row("portal", at("signed-out"))];
      const asked = world(rows);
      const needs: string[] = [];
      const result = yield* asked.run(
        rows[0]!,
        caller,
        AccountsService.of({
          ...off(rows, asked.service),
          setNeedsYou: (need) => Effect.sync(() => void needs.push(need.detail ?? "")),
        }),
      );
      // regression: a task the person created signed in by itself with the switch off.
      expect(result.outcome).toBe("failed");
      expect(asked.operations).not.toContain("accountType");
      expect(needs).toEqual(["Waiting for you to sign in"]);
    }
    // The person's own press still signs in.
    const rows = [row("portal", at("signed-out"))];
    const pressed = world(rows);
    yield* pressed.run(rows[0]!, check, off(rows, pressed.service));
    expect(pressed.operations).toContain("accountType");
    // Turned off while a sign-in is under way: nothing more is typed or sent.
    const midway = [row("portal", at("signed-out"))];
    const late = world(midway);
    let reads = 0;
    const stopped = yield* late.run(
      midway[0]!,
      { kind: "connector" },
      AccountsService.of({
        ...late.service,
        renewAutomatically: Effect.sync(() => reads++ === 0),
      }),
    );
    // regression: the switch was read once, at the start.
    expect(stopped.outcome === "needs-user" && stopped.message).toBe(
      "Renew sign-ins automatically is off, so Scient didn't sign in to Fixture.",
    );
    expect(late.operations).not.toContain("accountType");
  }),
);

it.effect("stops upkeep of a row that may send a code once nobody is there, before it sends", () =>
  Effect.gen(function* () {
    const rows = [row("gov", at("signed-out"))];
    const { run, operations, service } = world(rows);
    let looks = 0;
    // Someone is at a window when the sign-in starts, and gone by the time it would type.
    const policy = {
      snapshot: Effect.sync(() => ({ activeForegroundLeaseCount: looks++ === 0 ? 1 : 0 })),
    };
    const result = yield* run(
      rows[0]!,
      { kind: "renewal" },
      AccountsService.of({
        ...service,
        signInFactors: Effect.succeed({ [rows[0]!.accountId]: "code" }),
      }),
    ).pipe(
      Effect.provideService(BackgroundPolicy, policy as unknown as BackgroundPolicy["Service"]),
    );
    // regression: presence was read only at the start, so the code went to nobody.
    expect(result.outcome === "needs-user" && result.message).toBe(
      "Nobody is at Scient now, so it stopped signing in to Fixture: a code may come.",
    );
    // Typed while someone was there, never submitted: the site sends nothing.
    expect(operations).not.toContain("press");
    expect(operations).not.toContain("click");
  }),
);

it.effect("asks again at the last moment before the submit, after the use was authorized", () =>
  Effect.gen(function* () {
    const rows = [row("portal", at("signed-out"))];
    const { run, operations, service } = world(rows);
    let uses = 0;
    let off = false;
    const result = yield* run(
      rows[0]!,
      { kind: "connector" },
      AccountsService.of({
        ...service,
        // The second use check is the one right before the submit; the switch goes off there.
        authorizeUse: (scope, target, use) =>
          service
            .authorizeUse(scope, target, use)
            .pipe(Effect.tap(() => Effect.sync(() => void (++uses === 2 && (off = true))))),
        renewAutomatically: Effect.sync(() => !off),
      }),
    );
    // regression: the switch was asked before that wait, so the submit went out anyway.
    expect(result.outcome === "needs-user" && result.message).toBe(
      "Renew sign-ins automatically is off, so Scient didn't sign in to Fixture.",
    );
    expect(operations).not.toContain("click");
    expect(operations).not.toContain("press");
  }),
);

it.effect("with the switch off, no agent's request counts as the person's own", () =>
  Effect.gen(function* () {
    const off = (service: AccountsService["Service"]) =>
      AccountsService.of({ ...service, renewAutomatically: Effect.succeed(false) });
    const switchedOff = "Renew sign-ins automatically is off, so Scient didn't sign in to Fixture.";
    // regression: an agent in a chat counted as someone there, and an agent's task as the person's.
    for (const caller of [
      { kind: "agent", scope },
      { kind: "agent", scope: { ...scope, unattended: true, scheduledTaskId: "task:agent" } },
    ] as const) {
      const rows = [row("portal", at("signed-out"))];
      const asked = world(rows);
      const result = yield* asked.run(rows[0]!, caller, off(asked.service));
      expect(result).toMatchObject({ outcome: "failed", message: switchedOff });
      expect(asked.operations).not.toContain("accountType");
    }
    // An agent's add still shows the person the sign-in, but types nothing saved by itself. The
    // site asks for the username first, which alone can make it send a code.
    const rows = [row("portal", at("signed-out"))];
    const added = world(rows, undefined, undefined, undefined, undefined, () => ({
      ...signInPage(),
      password: null,
    }));
    yield* added.run(rows[0]!, { kind: "person", agent: scope }, off(added.service));
    // regression: the add typed the allowed saved password with no click from the person.
    expect(added.resolved).toEqual([]);
    // regression: it still typed the username and submitted, which can make a site send a code.
    expect(added.operations).not.toContain("accountType");
    expect(added.operations).not.toContain("click");
    expect(added.operations).not.toContain("press");
  }),
);
