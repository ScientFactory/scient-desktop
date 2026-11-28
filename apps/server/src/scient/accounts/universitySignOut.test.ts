import { it } from "@effect/vitest";
import {
  AccountId,
  AccountsError,
  EnvironmentId,
  defaultAccountControls,
  type AccountSummary,
  type AccountsSnapshot,
  type UniversitySignOut,
} from "@t3tools/contracts";
import { attemptKeys } from "@t3tools/shared/scientAccountSignIn";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { throughUniversity } from "../papers/universityFetches.ts";
import { AccountsService } from "./AccountsService.ts";
import { fakeAccounts } from "./Accounts.testkit.ts";
import { signOutUniversity } from "./universitySignOut.ts";

const row = (id: string, details: Record<string, unknown>): AccountSummary =>
  ({
    accountId: AccountId.make(id),
    name: "Hebrew University",
    details: { kind: "website", sites: ["huji.ac.il"], ...details },
    secrets: {},
    controls: defaultAccountControls("website"),
    status: "ready",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  }) as AccountSummary;

const closed: string[] = [];
const broker = PreviewAutomationBroker.of({
  connect: () => Effect.succeed(Stream.empty),
  focusHost: () => Effect.void,
  respond: () => Effect.void,
  invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
    Effect.sync(() => {
      if (request.operation === "close" && request.tabId) closed.push(request.tabId);
      return {} as A;
    }),
});

/** A service that records what the sign-out writes, in order, with one sign-out op at a time. */
const world = (rows: ReadonlyArray<AccountSummary>, extra: Partial<AccountsSnapshot> = {}) => {
  const order: string[] = [];
  let open: UniversitySignOut | undefined;
  const fake = fakeAccounts({ accounts: rows });
  const service = {
    ...fake.service,
    snapshot: Effect.sync(() => ({ accounts: rows, ...extra }) as unknown as AccountsSnapshot),
    beginSignOut: (accountIds: ReadonlyArray<AccountId>, targets: UniversitySignOut["pending"]) =>
      Effect.sync(() => {
        open ??= { opId: "op-1", seq: 1, accountIds: [...accountIds], pending: [...targets] };
        order.push(`signed out:${accountIds.join(",")}`);
        return open;
      }),
    profileSignedOut: (profileId: string, site: string) =>
      Effect.sync(() => {
        order.push(`${profileId}:${site}`);
        return 0;
      }),
  };
  const run = (
    accountId: AccountId,
    overrides: Partial<AccountsService["Service"]> = {},
    browser: PreviewAutomationBroker["Service"] = broker,
  ) =>
    signOutUniversity({ accountId }, EnvironmentId.make("env-fixture")).pipe(
      Effect.provideService(AccountsService, { ...service, ...overrides }),
      Effect.provideService(PreviewAutomationBroker, browser),
    );
  return { run, order, fake, service };
};

it.effect("signs each profile out of what its own rows name, the person's choice first", () =>
  Effect.gen(function* () {
    const rows = [
      row("acc_huji_main01", {
        institution: {
          name: "Hebrew University",
          entityId: "https://idp.huji.ac.il/openathens",
          domain: "huji.ac.il",
        },
      }),
      row("acc_huji_work01", {
        profileId: "work",
        proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}",
      }),
    ];
    const { run, order } = world(rows);
    const result = yield* run(rows[1]!.accountId);
    // OpenAthens is Main's row's session; the work profile's library link isn't OpenAthens.
    expect(result).toEqual({
      opId: "op-1",
      sites: [
        { profileId: "default", site: "huji.ac.il" },
        { profileId: "default", site: "openathens.net" },
        { profileId: "work", site: "huji.ac.il" },
      ],
    });
    expect(order).toEqual([
      "signed out:acc_huji_main01,acc_huji_work01",
      "default:huji.ac.il",
      "default:openathens.net",
      "work:huji.ac.il",
    ]);
  }),
);

it.effect("keeps another university's OpenAthens session in the same profile", () =>
  Effect.gen(function* () {
    const huji = row("acc_huji_main01", {
      institution: {
        name: "Hebrew University",
        entityId: "https://idp.huji.ac.il/openathens",
        domain: "huji.ac.il",
      },
    });
    const tau = {
      ...row("acc_tau_main001", {
        sites: ["tau.ac.il"],
        proxyUrl: "https://go.openathens.net/redirector/tau.ac.il?url={url}",
      }),
      name: "Tel Aviv University",
    };
    const result = yield* world([huji, tau]).run(huji.accountId);
    expect(result).toEqual({ opId: "op-1", sites: [{ profileId: "default", site: "huji.ac.il" }] });
  }),
);

it.effect("keeps a vendor's host out by host, for this computer, the others and Main", () =>
  Effect.gen(function* () {
    const rows = [
      row("acc_vendor_row01", { proxyUrl: "https://proxy.library-vendor.com/login?url={url}" }),
    ];
    const { run, order } = world(rows);
    const result = yield* run(rows[0]!.accountId);
    expect(result.sites.map(({ site }) => site)).toEqual([
      "proxy.library-vendor.com",
      "huji.ac.il",
    ]);
    expect(order.slice(1)).toEqual(["default:proxy.library-vendor.com", "default:huji.ac.il"]);
  }),
);

it.effect("stops a paper's page load through the university before it records anything", () =>
  Effect.gen(function* () {
    const rows = [
      row("acc_huji_load001", { proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}" }),
    ];
    const { run, order } = world(rows);
    const loading = yield* throughUniversity(
      rows[0]!.accountId,
      Effect.never.pipe(
        Effect.onInterrupt(() => Effect.sync(() => void order.push("load stopped"))),
      ),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* run(rows[0]!.accountId);
    expect(yield* Fiber.join(loading)).toEqual(Option.none());
    expect(order.slice(0, 2)).toEqual(["signed out:acc_huji_load001", "load stopped"]);
  }),
);

it.effect("ends a sign-in paused at a code, closing its tab, so Sign out stays the person's", () =>
  Effect.gen(function* () {
    const rows = [
      row("acc_huji_code001", { proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}" }),
    ];
    const { run, fake } = world(rows);
    const attempts = yield* fake.service.signInAttempts;
    attempts.pending.set("key", {
      attemptId: "attempt-paused",
      accountId: rows[0]!.accountId,
      invocation: {} as never,
      tabId: "tab-code" as never,
      submissions: [],
    });
    closed.length = 0;
    yield* run(rows[0]!.accountId);
    expect(attempts.pending.size).toBe(0);
    expect(closed).toEqual(["tab-code"]);
  }),
);

it.effect("a sign-out that couldn't be recorded sends nothing to clear", () =>
  Effect.gen(function* () {
    const rows = [
      row("acc_huji_fail001", { proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}" }),
    ];
    const { run, order } = world(rows);
    const failed = yield* run(rows[0]!.accountId, {
      beginSignOut: () =>
        Effect.fail(new AccountsError({ reason: "unavailable", message: "Disk full." })),
    }).pipe(Effect.flip);
    expect(failed.message).toBe("Disk full.");
    expect(order).toEqual([]);
  }),
);

it.effect("waits for a sign-in in flight and ends the person's, so none lands after it", () =>
  Effect.gen(function* () {
    const rows = [
      row("acc_huji_flight1", { proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}" }),
    ];
    const { run, order, fake } = world(rows, {
      handoffs: [{ handoffId: "handoff-person", accountId: rows[0]!.accountId }] as never,
    });
    const attempts = yield* fake.service.signInAttempts;
    const cancelled = yield* Deferred.make<void>();
    // A background sign-in under way on the same site and identity.
    const gate = yield* Deferred.make<void>();
    const running = yield* attempts
      .exclusive(
        attemptKeys(rows)(rows[0]!),
        Deferred.await(gate).pipe(
          Effect.andThen(Effect.sync(() => void order.push("attempt ended"))),
        ),
      )
      .pipe(Effect.forkChild);
    const signingOut = yield* run(rows[0]!.accountId, {
      cancelHandoff: (handoffId: string) =>
        Effect.sync(() => void order.push(`cancel:${handoffId}`)).pipe(
          Effect.andThen(Deferred.succeed(cancelled, undefined)),
          Effect.asVoid,
        ),
    }).pipe(Effect.forkChild);
    yield* Deferred.await(cancelled);
    // However long the attempt takes, the sign-out isn't recorded before it ends.
    for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
    expect(order).toEqual(["cancel:handoff-person"]);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(running);
    yield* Fiber.join(signingOut);
    expect(order.slice(0, 3)).toEqual([
      "cancel:handoff-person",
      "attempt ended",
      "signed out:acc_huji_flight1",
    ]);
  }),
);

it.effect("also waits on a sign-in page the university learned while it waited", () =>
  Effect.gen(function* () {
    const before = row("acc_huji_learn01", {
      proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}",
    });
    const learned = {
      ...before,
      details: { ...before.details, sites: ["huji.ac.il", "https://idp.huji.ac.il"] },
    } as AccountSummary;
    const { order, fake, service } = world([before]);
    let reads = 0;
    const attempts = yield* fake.service.signInAttempts;
    const gate = yield* Deferred.make<void>();
    // A sign-in on the page the university learned in the meantime.
    const running = yield* attempts
      .exclusive(
        attemptKeys([learned])(learned),
        Deferred.await(gate).pipe(
          Effect.andThen(Effect.sync(() => void order.push("attempt ended"))),
        ),
      )
      .pipe(Effect.forkChild);
    const signingOut = yield* signOutUniversity(
      { accountId: before.accountId },
      EnvironmentId.make("env-fixture"),
    ).pipe(
      Effect.provideService(AccountsService, {
        ...service,
        snapshot: Effect.sync(
          () => ({ accounts: [reads++ === 0 ? before : learned] }) as unknown as AccountsSnapshot,
        ),
      }),
      Effect.provideService(PreviewAutomationBroker, broker),
      Effect.forkChild,
    );
    for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
    expect(order).toEqual([]);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(running);
    yield* Fiber.join(signingOut);
    expect(order[0]).toBe("attempt ended");
  }),
);

it.effect(
  "closes Scient's own tabs on the university's sites in that profile before clearing",
  () =>
    Effect.gen(function* () {
      const rows = [
        row("acc_huji_tabs001", { proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}" }),
      ];
      const { run } = world(rows);
      const shut: string[] = [];
      // A paper's page and a quiet look, each in its own thread, and one tab on another site.
      const tabs: Record<string, ReadonlyArray<Record<string, unknown>>> = {
        "scient-paper-get": [
          { tabId: "tab-paper", url: "https://idp.huji.ac.il/login", profileId: "default" },
          { tabId: "tab-other", url: "https://example.com/", profileId: "default" },
        ],
        "scient-accounts-check": [
          { tabId: "tab-look", url: "https://ezproxy.huji.ac.il/login", profileId: "default" },
          { tabId: "tab-work", url: "https://ezproxy.huji.ac.il/login", profileId: "work" },
        ],
      };
      const browser = PreviewAutomationBroker.of({
        ...broker,
        invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
          Effect.sync(() => {
            if (request.operation === "close" && request.tabId) shut.push(request.tabId);
            return { tabs: tabs[request.scope.threadId] ?? [] } as A;
          }),
      });
      yield* run(rows[0]!.accountId, {}, browser);
      expect(shut).toEqual(["tab-paper", "tab-look"]);
    }),
);

it.effect("ends a sign-in that paused at a code while Sign out waited for its lock", () =>
  Effect.gen(function* () {
    const rows = [
      row("acc_huji_pause01", { proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}" }),
    ];
    const { run, fake } = world(rows);
    const attempts = yield* fake.service.signInAttempts;
    const gate = yield* Deferred.make<void>();
    // A sign-in under way stops at a code just as it lets go of its lock.
    const running = yield* attempts
      .exclusive(
        attemptKeys(rows)(rows[0]!),
        Deferred.await(gate).pipe(
          Effect.andThen(
            Effect.sync(() =>
              attempts.pending.set("paused", {
                attemptId: "attempt-paused-late",
                accountId: rows[0]!.accountId,
                invocation: {} as never,
                tabId: "tab-late-code" as never,
                submissions: [],
              }),
            ),
          ),
        ),
      )
      .pipe(Effect.forkChild);
    closed.length = 0;
    const signingOut = yield* run(rows[0]!.accountId).pipe(Effect.forkChild);
    for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(running);
    yield* Fiber.join(signingOut);
    expect(attempts.pending.size).toBe(0);
    expect(closed).toEqual(["tab-late-code"]);
  }),
);
