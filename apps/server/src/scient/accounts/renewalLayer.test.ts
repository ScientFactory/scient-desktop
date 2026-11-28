import { it } from "@effect/vitest";
import {
  AccountId,
  AccountsError,
  EnvironmentId,
  PreviewAutomationExecutionError,
  PreviewAutomationNoAvailableHostError,
  type AccountSummary,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { fakeAccounts } from "./Accounts.testkit.ts";
import { AccountsService } from "./AccountsService.ts";
import { accountRenewalLayer } from "./renewal.ts";
import type { SignInFactor } from "./signInCodes.ts";

const SITE = "https://example.com";

/**
 * The renewal layer as the server runs it, over a page that asks for the password until Scient
 * signs in. `second`: then a code the saved key answers (`totp`) or the site says it texted
 * (`sms`); `key`: a key is saved; `codes`: each row's last second step, as Accounts keeps it.
 */
const world = Effect.fn("renewalWorld")(function* (options: {
  readonly defaultProfile: string;
  readonly second?: "totp" | "sms";
  readonly key?: boolean;
  readonly codes?: Record<string, SignInFactor>;
  /** Needs you can't publish the notice that explains a surprise code. */
  readonly noticeFails?: boolean;
  /** The site refuses the saved key's code: its box wasn't the key's. */
  readonly refuseKey?: boolean;
  /** The code page names an authenticator app. */
  readonly appWording?: boolean;
  /** The code page mentions a phone or a mail, without saying a code was sent. */
  readonly deliveryWords?: boolean;
  /** Reads of the page after the password submit that still find the submitted page. */
  readonly staleReads?: number;
  /** Accounts' store needs the person to open it (a keychain prompt) until `openStore`. */
  readonly closed?: boolean;
}) {
  const keyed = options.key === true || options.second === "totp";
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  let row: AccountSummary = {
    accountId: AccountId.make("acc_gov00001"),
    name: "gov.il",
    details: { kind: "website", sites: ["example.com"], username: "dana" },
    secrets: {
      password: { source: { type: "scient" } },
      ...(keyed ? { totp: { source: { type: "scient" } } } : {}),
    },
    controls: {
      access: "allowed",
      permission: "full",
      visibility: "hidden",
      scope: { type: "all-projects" },
    },
    status: "ready",
    signIn: {
      state: "signed-in",
      at: DateTime.formatIso(DateTime.makeUnsafe(now - 2 * 86_400_000)),
    },
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const renewedAt: Record<string, string> = {};
  /** Kept as Accounts keeps it, so a new layer (a restart) reads it back. */
  const deferred = new Set<string>();
  /** Opens that fail with a browser error (not the site's), before the next works. */
  let failingOpens = 0;
  /** Opens the network fails (DNS, TLS, refused): the browser answers, the site is unreachable. */
  let unreachableOpens = 0;
  let openFailed = yield* Deferred.make<void>();
  const people = { active: false };
  const operations: string[] = [];
  const opened: string[] = [];
  let turnDone = yield* Deferred.make<void>();
  /** Submits so far: the password, then the code when the site asks for one. */
  let submits = 0;
  let stale = 0;
  const signedIn = () =>
    options.refuseKey !== true && submits >= (options.second === undefined ? 1 : 2);
  const codes: Record<string, SignInFactor> = { ...options.codes };
  /** What Needs you said, in order; `cleared` when it settled. */
  const notices: string[] = [];
  /** How each sign-in ended, in its own words. */
  const uses: string[] = [];
  /** The notices kept for the phone, as Accounts keeps them. */
  const kept: Array<{ text: string; settled?: string }> = [];
  const settings = { renewAutomatically: true };
  const fake = fakeAccounts({
    accounts: [row],
    values: {
      password: "synthetic-password",
      ...(keyed ? { totp: "JBSWY3DPEHPK3PXP" } : {}),
    },
  });
  const recorded = (state: NonNullable<AccountSummary["signIn"]>["state"]) =>
    Effect.flatMap(DateTime.now, (at) =>
      Effect.sync(() => void (row = { ...row, signIn: { state, at: DateTime.formatIso(at) } })),
    );
  const store = { open: options.closed !== true, snapshots: 0 };
  const storeOpened = yield* Deferred.make<void>();
  /** Set once a turn waits for the store to open. */
  const waiting = yield* Deferred.make<void>();
  const accounts = AccountsService.of({
    ...fake.service,
    openWithoutPrompt: Effect.sync(() => store.open),
    changes: Stream.fromEffect(
      Deferred.succeed(waiting, undefined).pipe(
        Effect.andThen(Deferred.await(storeOpened)),
        Effect.as({ accounts: [row] } as never),
      ),
    ),
    snapshot: Effect.sync(() => {
      store.snapshots += 1;
      return { accounts: [row], agentAccess: true } as never;
    }),
    recordCheck: (_id, check) => recorded(check.state),
    recordUse: (entry, message) =>
      Effect.sync(() => void uses.push(message ?? entry.outcome ?? "")).pipe(
        Effect.andThen(
          entry.signInOutcome === "signed-in"
            ? recorded("signed-in")
            : entry.signInOutcome === "needs-user"
              ? recorded("needs-you")
              : Effect.void,
        ),
      ),
    renewedAt: Effect.succeed(renewedAt),
    signInFactors: Effect.sync(() => ({ ...codes })),
    noteSignInFactor: (accountId, factor) => Effect.sync(() => void (codes[accountId] = factor)),
    setNeedsYou: (need) =>
      options.noticeFails === true && need.detail?.startsWith("That code is Scient") === true
        ? Effect.fail(new AccountsError({ reason: "unavailable", message: "Synthetic: locked." }))
        : Effect.sync(() => void notices.push(need.detail ?? "")),
    clearNeedsYou: () => Effect.sync(() => void notices.push("cleared")),
    renewAutomatically: Effect.sync(() => settings.renewAutomatically),
    addCodeNotice: (notice) =>
      Effect.sync(() => {
        operations.push("notice");
        return String(kept.push({ text: notice.text }) - 1);
      }),
    settleCodeNotice: (noticeId, settled) =>
      Effect.sync(() => void (kept[Number(noticeId)]!.settled = settled)),
    deferredRenewals: Effect.sync(() => [...deferred]),
    setRenewalDeferred: (accountId, on) =>
      Effect.sync(() => void (on ? deferred.add(accountId) : deferred.delete(accountId))),
    renewed: (accountId, at) =>
      Effect.sync(() => void (renewedAt[accountId] = at)).pipe(
        Effect.andThen(Effect.suspend(() => Deferred.succeed(turnDone, undefined))),
      ),
  });
  const status: PreviewAutomationStatus = {
    available: true,
    visible: false,
    tabId: "tab-renewal",
    url: SITE,
    title: null,
    loading: false,
    defaultProfileId: options.defaultProfile as never,
    tabs: [{ tabId: "tab-renewal", url: SITE, profileId: "default" as never, ownedByCaller: true }],
  };
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      request.operation === "open" && unreachableOpens > 0
        ? Effect.suspend(() => {
            unreachableOpens -= 1;
            return Effect.fail(
              new PreviewAutomationExecutionError({
                operation: "open",
                environmentId: EnvironmentId.make("env-here"),
                threadId: "scient-accounts-renewal" as never,
                clientId: "server-browser",
                connectionId: "fixture-connection" as never,
                requestId: "fixture-request",
                timeoutMs: 15_000,
                remoteTag: "PreviewAutomationExecutionError",
                remoteMessageLength: 40,
                remoteDetailKind: "object",
                cause: {
                  _tag: "PreviewAutomationExecutionError",
                  message: "net::ERR_NAME_NOT_RESOLVED",
                  detail: { failureClass: "navigation_network" },
                },
                reason: "net::ERR_NAME_NOT_RESOLVED",
              }),
            );
          })
        : request.operation === "open" && failingOpens > 0
          ? Effect.suspend(() => {
              failingOpens -= 1;
              return Deferred.succeed(openFailed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    new PreviewAutomationNoAvailableHostError({
                      operation: "open",
                      environmentId: EnvironmentId.make("env-here"),
                      threadId: "scient-accounts-renewal" as never,
                    } as never),
                  ),
                ),
              );
            })
          : Effect.sync(() => {
              const input = request.input as {
                expression?: string;
                profileId?: string;
                loadMs?: number;
              };
              operations.push(
                request.operation === "accountWaitForLoad" && input.loadMs !== undefined
                  ? "quickLook"
                  : request.operation,
              );
              if (request.operation === "open" && input.profileId !== undefined)
                opened.push(input.profileId);
              if (request.operation === "press" || request.operation === "click") submits += 1;
              if (request.operation === "accountCookies") return [] as A;
              if (request.operation !== "evaluate") return status as A;
              // The page as submitted, still on screen for a while after the submit.
              if (
                submits === 1 &&
                !input.expression?.includes("finalUrl") &&
                stale < (options.staleReads ?? 0)
              ) {
                stale += 1;
                return {
                  origin: SITE,
                  username: "#user",
                  password: "#password",
                  otp: null,
                  submit: "button",
                  challenge: null,
                  signedIn: false,
                  document: 0,
                } as A;
              }
              return (
                input.expression?.includes("finalUrl")
                  ? { finalUrl: SITE, title: "", passwordField: submits === 0, deniedText: false }
                  : {
                      origin: SITE,
                      username: submits > 0 ? null : "#user",
                      password: submits > 0 ? null : "#password",
                      otp: submits > 0 && !signedIn() ? "#otp" : null,
                      ...(options.second === "sms" && submits > 0 && !signedIn()
                        ? { otpSent: "text" }
                        : {}),
                      ...(options.appWording === true && submits > 0 && !signedIn()
                        ? { otpApp: true }
                        : {}),
                      ...(options.deliveryWords === true && submits > 0 && !signedIn()
                        ? { otpDelivery: true }
                        : {}),
                      submit: signedIn() ? null : "button",
                      challenge: null,
                      signedIn: signedIn(),
                      document: submits,
                    }
              ) as A;
            }),
  });
  const layer = accountRenewalLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AccountsService, accounts),
        Layer.succeed(PreviewAutomationBroker, broker),
        Layer.succeed(ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-here")),
        } as unknown as ServerEnvironment["Service"]),
        Layer.mock(BackgroundPolicy)({
          snapshot: Effect.sync(
            () => ({ activeForegroundLeaseCount: people.active ? 1 : 0 }) as never,
          ),
        }),
      ),
    ),
  );
  /** Ten minutes on: one renewal turn, to its end. */
  const turn = Effect.gen(function* () {
    turnDone = yield* Deferred.make<void>();
    yield* TestClock.adjust("10 minutes");
    yield* Deferred.await(turnDone);
  });
  /** Ten minutes on, to a turn whose browser fails before it looks. */
  const failedTurn = Effect.gen(function* () {
    openFailed = yield* Deferred.make<void>();
    yield* TestClock.adjust("10 minutes");
    yield* Deferred.await(openFailed);
  });
  const failNextOpen = () => void (failingOpens = 1);
  const unreachNextOpen = () => void (unreachableOpens = 1);
  /** The person's first use opens the store, which publishes a change. */
  const openStore = Effect.sync(() => void (store.open = true)).pipe(
    Effect.andThen(Deferred.succeed(storeOpened, undefined)),
  );
  return {
    layer,
    turn,
    failedTurn,
    failNextOpen,
    unreachNextOpen,
    people,
    codes,
    notices,
    uses,
    kept,
    settings,
    operations,
    opened,
    deferred,
    row: () => row,
    store,
    waiting,
    openStore,
    turnEnded: Effect.suspend(() => Deferred.await(turnDone)),
  };
});

it.effect("signs in only once someone is at a window, in the row's own profile", () =>
  Effect.gen(function* () {
    const renewal = yield* world({ defaultProfile: "home" });
    yield* Effect.gen(function* () {
      yield* Layer.build(renewal.layer);
      // Nobody at any window: it looks, finds the session ended, and types nothing.
      yield* renewal.turn;
      expect(renewal.row().signIn?.state).toBe("signed-out");
      expect(renewal.operations).not.toContain("accountType");
      // Someone comes back: the row that only got a look goes first, and signs in now.
      renewal.people.active = true;
      yield* renewal.turn;
      expect(renewal.operations).toContain("accountType");
      expect(renewal.row().signIn?.state).toBe("signed-in");
    }).pipe(Effect.scoped);
  }),
);

it.effect(
  "renews nothing while Accounts would need the person to open it, then goes on at once",
  () =>
    Effect.gen(function* () {
      const renewal = yield* world({ defaultProfile: "home", closed: true });
      renewal.people.active = true;
      yield* Effect.gen(function* () {
        yield* Layer.build(renewal.layer);
        yield* TestClock.adjust("10 minutes");
        const first = yield* Effect.raceFirst(
          Deferred.await(renewal.waiting).pipe(Effect.as("waited" as const)),
          renewal.turnEnded.pipe(Effect.as("renewed" as const)),
        );
        // regression: the turn read Accounts, so a hidden start asked for the keychain.
        expect(first).toBe("waited");
        expect(renewal.store.snapshots).toBe(0);
        expect(renewal.operations).toEqual([]);
        // The person's first use opens it: the waiting turn renews, with no other turn's wait.
        yield* renewal.openStore;
        yield* renewal.turnEnded;
        expect(renewal.store.snapshots).toBeGreaterThan(0);
        expect(renewal.operations).toContain("open");
      }).pipe(Effect.scoped);
    }),
);

it.effect("keeps a deferred row through a failed turn and a restart, in Main throughout", () =>
  Effect.gen(function* () {
    const renewal = yield* world({ defaultProfile: "home" });
    yield* Effect.gen(function* () {
      yield* Layer.build(renewal.layer);
      // Nobody there: a look, and the row is kept for later.
      yield* renewal.turn;
      expect([...renewal.deferred]).toEqual([renewal.row().accountId]);
      // Someone comes back, but this turn's browser fails before it looks.
      renewal.people.active = true;
      renewal.failNextOpen();
      yield* renewal.failedTurn;
    }).pipe(Effect.scoped);
    // regression: the deferred row was dropped before that look, and a restart forgot it.
    expect([...renewal.deferred]).toEqual([renewal.row().accountId]);
    yield* Effect.gen(function* () {
      yield* Layer.build(renewal.layer);
      yield* renewal.turn;
      expect(renewal.operations).toContain("accountType");
      expect(renewal.deferred.size).toBe(0);
    }).pipe(Effect.scoped);
    // The look with nobody there and the sign-in both used Main, not the browser's default.
    expect(new Set(renewal.opened)).toEqual(new Set(["default"]));
  }),
);

it.effect("keeps a deferred row through a turn that couldn't reach the site", () =>
  Effect.gen(function* () {
    const renewal = yield* world({ defaultProfile: "home" });
    yield* Effect.gen(function* () {
      yield* Layer.build(renewal.layer);
      yield* renewal.turn;
      expect([...renewal.deferred]).toEqual([renewal.row().accountId]);
      // Someone is back, but the network fails the visit: unknown, not a result.
      renewal.people.active = true;
      renewal.unreachNextOpen();
      yield* renewal.turn;
      expect(renewal.row().signIn?.state).toBe("unknown");
      // regression: unknown counted as settled, so the network failure cleared the retry.
      expect([...renewal.deferred]).toEqual([renewal.row().accountId]);
      yield* renewal.turn;
      expect(renewal.operations).toContain("accountType");
      expect(renewal.row().signIn?.state).toBe("signed-in");
      expect(renewal.deferred.size).toBe(0);
    }).pipe(Effect.scoped);
  }),
);

/** The renewal look and sign-in of one due row, in one run of the layer. */
const oneTurn = Effect.fn("oneTurn")(function* (renewal: Effect.Success<ReturnType<typeof world>>) {
  yield* Effect.gen(function* () {
    yield* Layer.build(renewal.layer);
    yield* renewal.turn;
  }).pipe(Effect.scoped);
});

it.effect("signs a code-free row in again with nobody at any window, and tells nobody", () =>
  Effect.gen(function* () {
    const renewal = yield* world({ defaultProfile: "home", codes: { acc_gov00001: "none" } });
    yield* oneTurn(renewal);
    // regression: with nobody there it only looked, so the lapsed sign-in waited for someone.
    expect(renewal.operations).toContain("accountType");
    expect(renewal.row().signIn?.state).toBe("signed-in");
    expect(renewal.notices.filter((notice) => notice !== "cleared")).toEqual([]);
  }),
);

it.effect("signs a row whose only second step is its authenticator key in silently", () =>
  Effect.gen(function* () {
    // A sign-in Scient saw finish with the key alone, at a challenge naming the app.
    const renewal = yield* world({
      defaultProfile: "home",
      second: "totp",
      codes: { acc_gov00001: "totp" },
      appWording: true,
    });
    yield* oneTurn(renewal);
    // regression: a saved key counted for nothing while nobody was there.
    expect(renewal.row().signIn?.state).toBe("signed-in");
    expect(renewal.notices.filter((notice) => notice !== "cleared")).toEqual([]);
    // The key answered the code step: nothing reached the person, and the row stays quiet.
    expect(renewal.codes["acc_gov00001"]).toBe("totp");
  }),
);

it.effect(
  "gives a row whose key signed in alone before no latitude at a box with no app named",
  () =>
    Effect.gen(function* () {
      // Proven before; this box says nothing of an authenticator.
      const renewal = yield* world({
        defaultProfile: "home",
        second: "totp",
        codes: { acc_gov00001: "totp" },
      });
      yield* oneTurn(renewal);
      // regression: a proven row's key went into a box with no app named. Only the username and
      // password went in.
      expect(renewal.operations.filter((operation) => operation === "accountType")).toHaveLength(2);
      expect(renewal.codes["acc_gov00001"]).toBe("code");
    }),
);

it.effect("explains a code a quiet row's site sends anyway, at once, and marks the row", () =>
  Effect.gen(function* () {
    const renewal = yield* world({
      defaultProfile: "home",
      second: "sms",
      codes: { acc_gov00001: "none" },
    });
    yield* oneTurn(renewal);
    // regression: the texted code came with no word from Scient.
    expect(renewal.notices[0]).toBe("That code is Scient signing in to gov.il");
    // Told from a look right after the submit, before the page's whole load is waited for.
    const afterSubmit = renewal.operations.slice(
      renewal.operations.findIndex((operation) => operation === "click" || operation === "press"),
    );
    // regression: the notice waited for the full load and settle after the submit.
    expect(afterSubmit.indexOf("notice")).toBeGreaterThan(-1);
    expect(afterSubmit.indexOf("notice")).toBeLessThan(afterSubmit.indexOf("accountWaitForLoad"));
    // Not finished alone: it becomes the ordinary Needs you item.
    expect(renewal.notices.at(-1)).toBe("Enter the code");
    // From now on, with nobody there, this row only gets a look.
    expect(renewal.codes["acc_gov00001"]).toBe("code");
  }),
);

it.effect("only looks at a row whose saved key no sign-in has shown to be enough", () =>
  Effect.gen(function* () {
    const renewal = yield* world({ defaultProfile: "home", second: "totp" });
    yield* oneTurn(renewal);
    // regression: a key alone made an untried row quiet, though the site may text a code too.
    expect(renewal.operations).not.toContain("accountType");
    expect(renewal.row().signIn?.state).toBe("signed-out");
  }),
);

it.effect("never types the saved key into a box for a code the site says it texted", () =>
  Effect.gen(function* () {
    const renewal = yield* world({
      defaultProfile: "home",
      second: "sms",
      key: true,
      codes: { acc_gov00001: "totp" },
    });
    yield* oneTurn(renewal);
    // regression: a key present made the texted box the key's: no notice, no lookup, no mark.
    expect(renewal.notices[0]).toBe("That code is Scient signing in to gov.il");
    expect(renewal.notices.at(-1)).toBe("Enter the code");
    expect(renewal.codes["acc_gov00001"]).toBe("code");
  }),
);

it.effect("only looks at a row known to send codes while nobody is at any window", () =>
  Effect.gen(function* () {
    const renewal = yield* world({ defaultProfile: "home", codes: { acc_gov00001: "code" } });
    yield* oneTurn(renewal);
    expect(renewal.operations).not.toContain("accountType");
    expect(renewal.row().signIn?.state).toBe("signed-out");
    expect([...renewal.deferred]).toEqual(["acc_gov00001"]);
  }),
);

it.effect("with Renew sign-ins automatically off, a due code-free row is only looked at", () =>
  Effect.gen(function* () {
    const renewal = yield* world({ defaultProfile: "home", codes: { acc_gov00001: "none" } });
    renewal.settings.renewAutomatically = false;
    renewal.people.active = true;
    yield* oneTurn(renewal);
    expect(renewal.operations).not.toContain("accountType");
    expect(renewal.row().signIn?.state).toBe("signed-out");
    // Nothing waits for later either: it never signs in by itself while off.
    expect(renewal.deferred.size).toBe(0);
  }),
);

it.effect("stops signing in when the notice for a surprise code can't be published", () =>
  Effect.gen(function* () {
    const renewal = yield* world({
      defaultProfile: "home",
      second: "sms",
      codes: { acc_gov00001: "none" },
      noticeFails: true,
    });
    yield* oneTurn(renewal);
    // regression: the failure was ignored, and Scient went on to look for and type the code.
    expect(renewal.uses.at(-1)).toBe(
      "Scient couldn't tell you a code was coming, so it stopped signing in.",
    );
    expect(renewal.notices).not.toContain("Enter the code");
    expect(renewal.codes["acc_gov00001"]).toBe("code");
  }),
);

it.effect("a saved key that signs in alone proves the row; one the site refuses marks it", () =>
  Effect.gen(function* () {
    // Someone is at a window, so the untried row signs in, after the up-front notice.
    const proven = yield* world({ defaultProfile: "home", second: "totp", appWording: true });
    proven.people.active = true;
    yield* oneTurn(proven);
    expect(proven.row().signIn?.state).toBe("signed-in");
    expect(proven.codes["acc_gov00001"]).toBe("totp");
    const refused = yield* world({
      defaultProfile: "home",
      second: "totp",
      refuseKey: true,
      appWording: true,
    });
    refused.people.active = true;
    yield* oneTurn(refused);
    // regression: a refused key left the row unmarked, so it could still renew quietly later.
    expect(refused.codes["acc_gov00001"]).toBe("code");
  }),
);

it.effect("hands off a code box the key isn't known to answer, typing no generated code", () =>
  Effect.gen(function* () {
    // Proven quiet with no second step, then a box appears that the key may or may not answer.
    const renewal = yield* world({
      defaultProfile: "home",
      second: "totp",
      codes: { acc_gov00001: "none" },
    });
    yield* oneTurn(renewal);
    expect(renewal.notices[0]).toBe("That code is Scient signing in to gov.il");
    // regression: the generated code went into a box that could be a texted one. Only the
    // password page's username and password were typed.
    expect(renewal.operations.filter((operation) => operation === "accountType")).toHaveLength(2);
    // Nobody was there: it waits for them, and the row may send a code from now on.
    expect([...renewal.deferred]).toEqual(["acc_gov00001"]);
    expect(renewal.codes["acc_gov00001"]).toBe("code");
    expect(renewal.kept).toEqual([
      { text: "gov.il: That code is Scient signing in to gov.il", settled: "not-signed-in" },
    ]);
  }),
);

it.effect("gives a proven key no box that mentions a phone or a mail", () =>
  Effect.gen(function* () {
    const renewal = yield* world({
      defaultProfile: "home",
      second: "totp",
      deliveryWords: true,
      codes: { acc_gov00001: "totp" },
    });
    yield* oneTurn(renewal);
    // regression: a past key sign-in let the key into a box that may be a texted one.
    expect(renewal.operations.filter((operation) => operation === "accountType")).toHaveLength(2);
    expect(renewal.codes["acc_gov00001"]).toBe("code");
  }),
);

it.effect("keeps reading the page after a submit until a code step shows, then tells it", () =>
  Effect.gen(function* () {
    const renewal = yield* world({
      defaultProfile: "home",
      second: "sms",
      codes: { acc_gov00001: "none" },
      staleReads: 2,
    });
    yield* oneTurn(renewal);
    const afterSubmit = renewal.operations.slice(
      renewal.operations.findIndex((operation) => operation === "click" || operation === "press"),
    );
    // regression: the first look found the submitted page's fields and stopped looking, so the
    // notice waited for the full load.
    expect(afterSubmit.indexOf("notice")).toBeGreaterThan(-1);
    expect(afterSubmit.indexOf("notice")).toBeLessThan(afterSubmit.indexOf("accountWaitForLoad"));
    expect(afterSubmit.filter((operation) => operation === "quickLook").length).toBe(3);
  }),
);

it.effect(
  "hands off an authenticator's box when the page also speaks of a phone, a text or a mail",
  () =>
    Effect.gen(function* () {
      const renewal = yield* world({
        defaultProfile: "home",
        second: "totp",
        appWording: true,
        deliveryWords: true,
        codes: { acc_gov00001: "totp" },
      });
      yield* oneTurn(renewal);
      // regression: authenticator wording let the key in although the page mentioned a phone.
      expect(renewal.operations.filter((operation) => operation === "accountType")).toHaveLength(2);
      expect(renewal.codes["acc_gov00001"]).toBe("code");
    }),
);
