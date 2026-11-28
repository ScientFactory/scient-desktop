import * as Redacted from "effect/Redacted";
import {
  AccountId,
  AccountsError,
  BACKUP_CODE_ID,
  BrowserProfileId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  defaultBrowserProfileRecord,
  type AccountHandoff,
  type AccountSummary,
  PreviewAutomationTimeoutError,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { fakeAccounts } from "../Accounts.testkit.ts";
import type { CodeCandidate } from "./messageCodes.ts";
import { signIn } from "./engine.ts";

const profileId = BrowserProfileId.make("default");
const scope = {
  threadId: ThreadId.make("thread-fixture"),
  projectId: ProjectId.make("project-fixture"),
  unattended: false,
};
const account: AccountSummary = {
  accountId: AccountId.make("acc_fixture1"),
  name: "Fixture",
  details: { kind: "website", sites: ["example.com"], username: "fixture-user" },
  secrets: { password: { source: { type: "scient" } } },
  controls: {
    access: "allowed",
    permission: "full",
    visibility: "hidden",
    scope: { type: "all-projects" },
  },
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const status: PreviewAutomationStatus = {
  available: true,
  visible: false,
  tabId: "tab-fixture",
  url: "https://example.com",
  title: null,
  loading: false,
  defaultProfileId: profileId,
  profiles: [{ id: profileId, name: "Default" }],
  tabs: [{ tabId: "tab-fixture", url: "https://example.com", profileId, ownedByCaller: true }],
};

const run = (
  options: Parameters<typeof signIn>[4],
  accepted: string,
  origin: () => string = () => "https://example.com",
  session = scope,
  onKit: (kit: ReturnType<typeof fakeAccounts>) => void = () => undefined,
  shown: (
    typed: ReadonlyArray<string>,
    /** The page as the sign-in reads it, not another script run on it. */
    detecting: boolean,
    /** Submits so far: a site moves on when the code is sent, not as it is typed. */
    submits: number,
  ) => {
    readonly limited?: boolean;
    readonly otp?: string | null;
    readonly otpApp?: boolean;
    readonly otpDelivery?: boolean;
    readonly origin?: string;
    readonly document?: number;
    readonly otpBox?: string;
    readonly otpField?: string;
    readonly submitInstance?: string;
    readonly signedIn?: boolean;
    readonly username?: string | null;
    readonly password?: string | null;
  } = () => ({}),
  /** Clears of a typed field that fail before one works (Infinity: none does), and closes. */
  trouble: {
    clearFails?: number;
    closeFails?: boolean;
    typeFails?: boolean;
    /** The accounts world refuses to send a typed key: the page changed at the send. */
    sendRefused?: boolean;
    /** The send ends with the site maybe still having the key: a request unanswered, or silence. */
    sendPending?: "in flight" | "silent";
  } = {},
  /** The row's saved values, its authenticator key included. */
  values: Parameters<typeof signIn>[2] = {},
  signInAccount: AccountSummary = account,
) => {
  const typed: string[] = [];
  /** Every accountType request as sent. */
  const typedInputs: Array<Record<string, unknown>> = [];
  const pressed: string[] = [];
  /** The deadline each send from the accounts world was given, and what it was asked. */
  const sendDeadlines: Array<number | undefined> = [];
  const sendInputs: Array<Record<string, unknown>> = [];
  const closed: string[] = [];
  /** What waited for the person while a clear kept failing. */
  const heldBy: string[] = [];
  let kit: ReturnType<typeof fakeAccounts> | undefined;
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.suspend(() => {
        if (request.operation === "close") closed.push(String(request.tabId));
        const refused =
          (request.operation === "close" && trouble.closeFails === true) ||
          (request.operation === "accountType" &&
            (request.input as { text: string }).text === "" &&
            (trouble.clearFails ?? 0) > 0) ||
          (request.operation === "accountType" && trouble.typeFails === true) ||
          ((request.operation === "click" || request.operation === "press") &&
            trouble.sendRefused === true &&
            (request.input as { world?: string }).world === "accounts");
        if (request.operation === "accountType" && refused)
          trouble.clearFails = (trouble.clearFails ?? 0) - 1;
        if (refused) {
          heldBy.push(...[...kit!.handoffs.values()].map(({ kind }) => kind));
          return Effect.fail(
            new PreviewAutomationTimeoutError({
              operation: request.operation,
              environmentId: EnvironmentId.make("env-fixture"),
              threadId: scope.threadId,
              clientId: "server-browser",
              connectionId: "fixture-connection",
              requestId: "fixture-request",
              timeoutMs: 1_000,
            }),
          );
        }
        return Effect.sync(() => {
          if (request.operation === "accountType") {
            typed.push((request.input as { text: string }).text);
            typedInputs.push(request.input as Record<string, unknown>);
          }
          if (request.operation === "click" || request.operation === "press")
            pressed.push(request.operation);
          const worldSend =
            (request.operation === "click" || request.operation === "press") &&
            (request.input as { world?: string }).world === "accounts";
          if (worldSend) {
            sendDeadlines.push(request.timeoutMs);
            sendInputs.push(request.input as Record<string, unknown>);
          }
          if (worldSend && trouble.sendPending !== undefined)
            return { unanswered: trouble.sendPending } as A;
          const signedIn = typed.includes(accepted);
          return (
            request.operation === "evaluate"
              ? {
                  origin: origin(),
                  username: null,
                  password: null,
                  otp: signedIn ? null : "#otp",
                  submit: "button",
                  challenge: null,
                  signedIn,
                  ...shown(
                    typed,
                    (request.input as { world?: string }).world === "accounts",
                    pressed.length,
                  ),
                }
              : status
          ) as A;
        });
      }),
  });
  const fake = fakeAccounts({ profiles: [defaultBrowserProfileRecord(profileId)] });
  kit = fake;
  onKit(fake);
  return signIn(session, signInAccount, values, undefined, options).pipe(
    Effect.provideService(AccountsService, fake.service),
    Effect.provideService(PreviewAutomationBroker, broker),
    Effect.provideService(AgentInvocationContext, {
      ...scope,
      environmentId: EnvironmentId.make("env-fixture"),
      providerSessionId: "session-fixture",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview", "accounts"] as const),
      issuedAt: 0,
    }),
    Effect.map((result) => ({
      result,
      typed,
      typedInputs,
      pressed,
      sendDeadlines,
      sendInputs,
      closed,
      heldBy,
      handoffs: fake.handoffs,
    })),
  );
};

it.effect("a code from the private card goes into the page and finishes the sign-in", () =>
  Effect.gen(function* () {
    const { result, typed, handoffs } = yield* run(
      { askCode: () => Effect.succeed("654321"), codes: nothingFound },
      "654321",
    );
    expect(result.outcome).toBe("signed-in");
    expect(typed).toEqual(["654321"]);
    expect(handoffs.size).toBe(0);
  }),
);

const candidate = (code: string): CodeCandidate => ({
  key: `messages:${code}`,
  code,
  source: "messages",
  at: Date.UTC(2026, 10, 26),
  sender: "32665",
  toAccount: undefined,
});
const nothingFound = {
  enabled: Effect.succeed(true),
  look: () => Effect.succeed({ automatic: undefined, offered: [] }),
  used: () => Effect.void,
};
/** One certain code a look finds by itself, as `chooseCode` leaves it. */
const sure = (code: string) => ({ automatic: candidate(code), offered: [candidate(code)] });
const unsure = (...codes: ReadonlyArray<string>) => ({
  automatic: undefined,
  offered: codes.map(candidate),
});
/** Each look gives the next of `looks`, then the last one again. */
const finding = (
  ...looks: ReadonlyArray<{
    readonly automatic: CodeCandidate | undefined;
    readonly offered: ReadonlyArray<CodeCandidate>;
  }>
) => {
  const used: string[] = [];
  let at = 0;
  return {
    used,
    codes: {
      enabled: Effect.succeed(true),
      look: () => Effect.sync(() => looks[Math.min(at++, looks.length - 1)]!),
      used: (found: CodeCandidate) => Effect.sync(() => void used.push(found.key)),
    },
  };
};

it.effect("a certain code found in Messages or Mail goes in with nobody, even unattended", () =>
  Effect.gen(function* () {
    const found = finding(sure("111222"));
    let codeSteps = 0;
    const { result, typed } = yield* run(
      { codes: found.codes, onCodeStep: () => Effect.sync(() => ((codeSteps += 1), true)) },
      "111222",
      undefined,
      { ...scope, unattended: true },
    );
    expect(result.outcome).toBe("signed-in");
    expect(typed).toEqual(["111222"]);
    expect(found.used).toEqual(["messages:111222"]);
    // Read from Messages, it was still texted to the person: the next renewal says so first.
    expect(codeSteps).toBeGreaterThan(0);
  }),
);

it.effect("one automatic code per challenge: after a refusal the next found code waits", () =>
  Effect.gen(function* () {
    const found = finding(sure("999999"), sure("111222"));
    const { result, typed } = yield* run({ codes: found.codes }, "111222", undefined, {
      ...scope,
      unattended: true,
    });
    // The refused code is cleared before anyone gets the tab back; the next one is only offered.
    expect(typed).toEqual(["999999", ""]);
    expect(result.outcome).toBe("needs-user");
  }),
);

it.effect("a code spent before a resume is not spent again on the same challenge", () =>
  Effect.gen(function* () {
    // Spent on this attempt's field before it was kept; the resume carries a later submit time,
    // and the site may have emptied the field meanwhile.
    const found = finding(sure("111222"));
    const { result, typed } = yield* run(
      {
        codes: found.codes,
        attemptId: "attempt-fixture",
        resume: {
          submittedAt: Date.UTC(2026, 10, 26, 12),
          submissions: [
            { origin: "https://example.com", fields: ["password"], otpPeriod: undefined },
            {
              origin: "https://example.com",
              fields: ["otp"],
              otpPeriod: undefined,
              found: true,
              challenge: "attempt-fixture|https://example.com|#otp",
            },
          ],
        },
      },
      "111222",
      undefined,
      { ...scope, unattended: true },
    );
    expect(typed).toEqual([]);
    expect(result.outcome).toBe("needs-user");
  }),
);

it.effect("a new challenge's code is the one fallback, and the login's budget can refuse it", () =>
  Effect.gen(function* () {
    // The refused code brings a fresh code field: a new challenge, so a new automatic code.
    const askAgain = (typed: ReadonlyArray<string>) =>
      typed.includes("999999") ? { otp: "#otp-again" } : {};
    const attempt = (budget: boolean) =>
      run(
        {
          codes: finding(sure("999999"), sure("111222")).codes,
          fallback: () => Effect.succeed(budget),
        },
        "111222",
        undefined,
        { ...scope, unattended: true },
        undefined,
        askAgain,
      );
    const allowed = yield* attempt(true);
    expect(allowed.result.outcome).toBe("signed-in");
    expect(allowed.typed).toEqual(["999999", "111222"]);
    const refused = yield* attempt(false);
    expect(refused.typed.filter(Boolean)).toEqual(["999999"]);
  }),
);

it.effect("a limit that appears before the code goes in stops the sign-in", () =>
  Effect.gen(function* () {
    // The site starts limiting between the look that found the code and its typing.
    let limiting = false;
    const { result, typed } = yield* run(
      {
        codes: {
          enabled: Effect.succeed(true),
          look: () =>
            Effect.sync(() => {
              limiting = true;
              return sure("111222");
            }),
          used: () => Effect.void,
        },
      },
      "111222",
      undefined,
      { ...scope, unattended: true },
      undefined,
      () => (limiting ? { limited: true } : {}),
    );
    expect(typed).toEqual([]);
    expect(result.outcome).toBe("limited");
  }),
);

it.effect("two codes wait for the person's Insert, and only the chosen one goes in", () =>
  Effect.gen(function* () {
    const fake = { chosen: undefined as undefined | ((id: string) => void) };
    const offered = unsure("111111", "222222");
    let looks = 0;
    let handoffs: Map<string, AccountHandoff> | undefined;
    const { result, typed } = yield* run(
      {
        codes: {
          enabled: Effect.succeed(true),
          look: () =>
            Effect.sync(() => {
              // By the second look the card shows both; the person picks the second.
              const card = handoffs && [...handoffs.values()][0];
              if (looks++ === 1 && card?.codes) fake.chosen?.(card.codes[1]!.codeId);
              return offered;
            }),
          used: () => Effect.void,
        },
      },
      "222222",
      undefined,
      scope,
      (kit) => {
        handoffs = kit.handoffs;
        fake.chosen = (codeId) => void kit.chosen.set([...kit.handoffs.keys()][0]!, codeId);
      },
    );
    expect(offered.automatic).toBeUndefined();
    expect(result.outcome).toBe("signed-in");
    expect(typed).toEqual(["222222"]);
  }),
);

it.effect("a backup code goes in only on the person's tap, the next one, taken off the list", () =>
  Effect.gen(function* () {
    let looks = 0;
    let taken = 0;
    let tap: (() => void) | undefined;
    let takenBeforeTap = -1;
    let shown: AccountHandoff | undefined;
    const { result, typed } = yield* run(
      {
        codes: {
          ...nothingFound,
          look: () =>
            Effect.sync(() => {
              if (looks++ === 2) tap?.();
              return { automatic: undefined, offered: [] };
            }),
        },
        backupCode: Effect.sync(() => (taken++ === 0 ? Redacted.make("BK12-3456") : undefined)),
      },
      "BK12-3456",
      undefined,
      scope,
      (kit) => {
        tap = () => {
          shown = [...kit.handoffs.values()][0];
          takenBeforeTap = taken;
          kit.chosen.set([...kit.handoffs.keys()][0]!, BACKUP_CODE_ID);
        };
      },
      undefined,
      undefined,
      undefined,
      {
        ...account,
        secrets: { ...account.secrets, recovery: { source: { type: "scient" }, left: 3 } },
      },
    );
    expect(shown?.backupCodes).toBe(true);
    // Two looks went by with the code step showing: none was taken without the tap.
    expect(takenBeforeTap).toBe(0);
    expect(result.outcome).toBe("signed-in");
    expect(typed).toEqual(["BK12-3456"]);
    expect(taken).toBe(1);
  }),
);

it.effect("a click on an offer that a newer look no longer lists still wins", () =>
  Effect.gen(function* () {
    let looks = 0;
    let choose: (() => void) | undefined;
    const { result, typed } = yield* run(
      {
        codes: {
          enabled: Effect.succeed(true),
          look: () =>
            Effect.sync(() => {
              // The person clicks the first offer while the next look finds a certain code.
              if (looks++ === 0) return unsure("111111");
              choose?.();
              return sure("222222");
            }),
          used: () => Effect.void,
        },
      },
      "111111",
      undefined,
      scope,
      (kit) => {
        choose = () => {
          const [handoff] = kit.handoffs.values();
          if (handoff?.codes?.[0]) kit.chosen.set(handoff.handoffId, handoff.codes[0].codeId);
        };
      },
    );
    expect(typed).toEqual(["111111"]);
    expect(result.outcome).toBe("signed-in");
  }),
);

it.effect("with nobody to answer and no certain code, it stops at the code and keeps the tab", () =>
  Effect.gen(function* () {
    const { result, typed } = yield* run({ codes: nothingFound }, "111222", undefined, {
      ...scope,
      unattended: true,
    });
    expect(result).toMatchObject({ outcome: "needs-user", pending: {} });
    expect(typed).toEqual([]);
  }),
);

it.effect("a code the site refuses is reported, not retried", () =>
  Effect.gen(function* () {
    const { result, typed } = yield* run(
      { askCode: () => Effect.succeed("000000"), codes: nothingFound },
      "654321",
    );
    // A code someone typed says nothing about a saved 2FA key: no lasting hold.
    expect(result.outcome).toBe("failed");
    expect(typed.filter((text) => text === "000000")).toHaveLength(1);
  }),
);

it.effect("a code asked for on one site never goes to another the tab moved to", () =>
  Effect.gen(function* () {
    let moved = false;
    const { result, typed } = yield* run(
      {
        askCode: () =>
          Effect.sync(() => {
            moved = true;
            return "654321";
          }),
        codes: nothingFound,
      },
      "never",
      () => (moved ? "https://elsewhere.example.com" : "https://example.com"),
    );
    expect(typed).toEqual([]);
    expect(result.outcome).toBe("needs-user");
  }),
);

it.effect("a code an agent's sign-in waits for is not typed once the account changed", () =>
  Effect.gen(function* () {
    const { result, typed } = yield* run(
      {
        askCode: () => Effect.succeed("654321"),
        // Turned Off while the person found the code.
        beforeType: () =>
          Effect.fail(new AccountsError({ reason: "denied", message: "Turned Off." })),
      },
      "654321",
    );
    expect(typed).toEqual([]);
    expect(result).toMatchObject({ outcome: "failed", message: "Turned Off." });
  }),
);

it.effect("a code typed for an agent's sign-in is cleared unsent once the account changed", () =>
  Effect.gen(function* () {
    let checks = 0;
    const { result, typed, pressed } = yield* run(
      {
        askCode: () => Effect.succeed("654321"),
        // Allowed when the code goes in, turned Off before the submit.
        beforeType: () =>
          checks++ === 0
            ? Effect.void
            : Effect.fail(new AccountsError({ reason: "denied", message: "Turned Off." })),
      },
      "never",
    );
    expect(pressed).toEqual([]);
    // Cleared at once, before the sign-in gives up.
    expect(typed.slice(0, 2)).toEqual(["654321", ""]);
    expect(result).toMatchObject({ outcome: "failed", message: "Turned Off." });
  }),
);

it.effect("a limit that appears once the code is typed stops it before the submit", () =>
  Effect.gen(function* () {
    const found = finding(sure("111222"));
    const { result, pressed, typed } = yield* run(
      { codes: found.codes },
      "never",
      undefined,
      { ...scope, unattended: true },
      undefined,
      (entered) => (entered.length ? { limited: true } : {}),
    );
    expect(pressed).toEqual([]);
    expect(result.outcome).toBe("limited");
    // And the code it typed is gone from the field again.
    expect(typed).toEqual(["111222", ""]);
  }),
);

it.effect("a found code goes only into the code field it was found for", () =>
  Effect.gen(function* () {
    let looks = 0;
    const { typed } = yield* run(
      {
        codes: {
          enabled: Effect.succeed(true),
          // Found certain once, for the challenge on screen then; nothing after.
          look: () => Effect.sync(() => (looks++ === 0 ? sure("111222") : unsure())),
          used: () => Effect.void,
        },
      },
      "111222",
      undefined,
      { ...scope, unattended: true },
      undefined,
      // The page swapped its challenge for another after the code was found.
      () => (looks > 0 ? { otp: "#other-otp" } : {}),
    );
    expect(typed).toEqual([]);
  }),
);

it.effect("a code is never thought requested by a click that sent nothing", () =>
  Effect.gen(function* () {
    const asked: Array<number | undefined> = [];
    yield* run(
      {
        codes: {
          enabled: Effect.succeed(true),
          look: (look) =>
            Effect.sync(() => {
              asked.push(look.requestedAt);
              return unsure();
            }),
          used: () => Effect.void,
        },
      },
      "never",
      undefined,
      { ...scope, unattended: true },
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((requestedAt) => requestedAt === undefined)).toBe(true);
  }),
);

it.effect("a code found just before the person turned codes off doesn't go in", () =>
  Effect.gen(function* () {
    let on = true;
    const { typed } = yield* run(
      {
        codes: {
          enabled: Effect.sync(() => on),
          look: () =>
            Effect.sync(() => {
              on = false;
              return sure("111222");
            }),
          used: () => Effect.void,
        },
      },
      "111222",
      undefined,
      { ...scope, unattended: true },
    );
    expect(typed).toEqual([]);
  }),
);

it.effect("an Insert waiting while the person turns codes off doesn't go in", () =>
  Effect.gen(function* () {
    let on = true;
    let looksSinceClick = -1;
    let choose: ((codeId: string) => void) | undefined;
    let handoffs: Map<string, AccountHandoff> | undefined;
    const { typed } = yield* run(
      {
        codes: {
          enabled: Effect.sync(() => on),
          look: () =>
            Effect.sync(() => {
              const card = handoffs && [...handoffs.values()][0];
              if (looksSinceClick < 0 && card?.codes) {
                choose?.(card.codes[0]!.codeId);
                looksSinceClick = 0;
              }
              return unsure("111111", "222222");
            }),
          used: () => Effect.void,
        },
      },
      "111111",
      undefined,
      scope,
      (kit) => {
        handoffs = kit.handoffs;
        choose = (codeId) => void kit.chosen.set([...kit.handoffs.keys()][0]!, codeId);
      },
      // Off lands during the look at the page right before the chosen code would go in.
      () => {
        if (looksSinceClick >= 0 && ++looksSinceClick === 2) on = false;
        return {};
      },
    );
    expect(typed).toEqual([]);
  }),
);

it.effect(
  "a typed code that won't clear keeps its tab private and the person's until it's gone",
  () =>
    Effect.gen(function* () {
      // The person holds the tab: neither clearing nor closing works.
      const trouble = { clearFails: Number.POSITIVE_INFINITY, closeFails: true };
      let kit: ReturnType<typeof fakeAccounts> | undefined;
      const held = yield* run(
        { codes: finding(sure("999999"), unsure()).codes },
        "111222",
        undefined,
        { ...scope, unattended: true },
        (fake) => void (kit = fake),
        undefined,
        trouble,
      );
      const privateTab = () =>
        [...kit!.attempts.values()].some(({ tabId }) => tabId === "tab-fixture");
      expect(privateTab()).toBe(true);
      expect([...kit!.handoffs.values()].map(({ kind }) => kind)).toEqual(["other"]);
      expect("message" in held.result && held.result.message).toContain("stays with the user");
      // Its wait runs out and the close is refused: still private, still asked.
      yield* TestClock.adjust("4 minutes");
      expect(held.closed).toContain("tab-fixture");
      expect(privateTab()).toBe(true);
      expect(kit!.handoffs.size).toBe(1);
      // The person lets go: the code clears and the tab is released.
      trouble.clearFails = 0;
      yield* TestClock.adjust("2 seconds");
      expect(privateTab()).toBe(false);
      expect(kit!.handoffs.size).toBe(0);
    }),
);

it.effect("a switch changed while the code waits to be sent clears it unsent", () =>
  Effect.gen(function* () {
    // The person turns codes off and on again during the look right before the submit: still on,
    // but not the switch the code was found under.
    let version = 0;
    const { typed, typedInputs, pressed } = yield* run(
      {
        codes: {
          enabled: Effect.succeed(true),
          version: Effect.sync(() => version),
          look: () => Effect.succeed(sure("111222")),
          used: () => Effect.void,
        },
      },
      "999999",
      undefined,
      { ...scope, unattended: true },
      undefined,
      (typedSoFar) => {
        if (typedSoFar.includes("111222") && version === 0) version = 1;
        return { document: 4, otpBox: "7:2", otpField: "7" };
      },
    );
    expect(pressed).toEqual([]);
    // Cleared at once, before the tab goes back to anyone.
    expect(typed.slice(0, 2)).toEqual(["111222", ""]);
    // regression: the clear named only the old selector, so a moved field kept the code.
    expect(typedInputs[1]).toMatchObject({ text: "", instance: "7", document: 4 });
  }),
);

it.effect(
  "names who sent a code that names no service, or a shared one, on the person's card",
  () =>
    Effect.gen(function* () {
      let seen: AccountHandoff["codes"];
      let handoffs: Map<string, AccountHandoff> | undefined;
      let looks = 0;
      const fake = { chosen: undefined as undefined | ((id: string) => void) };
      yield* run(
        {
          codes: {
            enabled: Effect.succeed(true),
            look: () =>
              Effect.sync(() => {
                const card = handoffs && [...handoffs.values()][0];
                if (card?.codes && looks++ === 1) {
                  seen = card.codes;
                  fake.chosen?.(card.codes[0]!.codeId);
                }
                return {
                  automatic: undefined,
                  offered: [
                    { ...candidate("482913"), sender: "govil", named: "shared" as const },
                    candidate("555555"),
                  ],
                };
              }),
            used: () => Effect.void,
          },
        },
        "482913",
        undefined,
        scope,
        (kit) => {
          handoffs = kit.handoffs;
          fake.chosen = (codeId) => void kit.chosen.set([...kit.handoffs.keys()][0]!, codeId);
        },
      );
      // The shared sender's code says who sent it; one that names the service needs no sender.
      expect(seen?.map(({ from }) => from)).toEqual(["govil", undefined]);
    }),
);

it.effect("tells every code box of the run and who filled it, across origins", () =>
  Effect.gen(function* () {
    const found = finding(sure("111222"));
    const boxes: string[] = [];
    // The key answers an authenticator's box on the site; then a box on its sign-in service
    // takes a code read from Messages, and the sign-in finishes.
    const { result, typed } = yield* run(
      {
        codes: found.codes,
        onCodeBox: (box, by) => void boxes.push(`${box}:${by}`),
      },
      "111222",
      () => "https://example.com",
      { ...scope, unattended: true },
      undefined,
      (_entered, _detecting, submits) =>
        submits === 0 ? { otpApp: true } : { origin: "https://login.example.com", otp: "#code" },
      {},
      { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
    );
    expect(result.outcome).toBe("signed-in");
    expect(typed.at(-1)).toBe("111222");
    // regression: only the first, one-shot step was told, so the outside code left the row `totp`.
    expect(boxes).toContain("https://example.com||selector #otp:key");
    expect(boxes).toContain("https://login.example.com||selector #code:other");
  }),
);

it.effect("tells a later challenge at the same field apart, and a key only once it went in", () =>
  Effect.gen(function* () {
    const boxes: string[] = [];
    let after = 0;
    // The key answers an authenticator's box; the next page load asks again at the same selector,
    // with no word of an authenticator, and the person types a code there in the browser.
    const { result, typed } = yield* run(
      {
        codes: nothingFound,
        onCodeBox: (box, by) => void boxes.push(`${box}:${by}`),
      },
      "never-typed",
      () => "https://example.com",
      { ...scope, unattended: true },
      undefined,
      (entered, detecting) => {
        // The page as typed, until the submit; then the next load, then signed in.
        const read = entered.length === 0 ? -1 : detecting ? after++ : after - 1;
        return read < 1
          ? { otpApp: true, document: 1, otpBox: "aa" }
          : read < 2
            ? { document: 2, otpBox: "bb" }
            : { document: 3, otp: null, signedIn: true };
      },
      {},
      { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
    );
    expect(typed).toHaveLength(1);
    // Every box as it was seen, before anything was decided, then the key once it was in.
    const fits = boxes.indexOf("https://example.com|1|aa:fits");
    expect(fits).toBeGreaterThanOrEqual(0);
    expect(boxes.indexOf("https://example.com|1|aa:key")).toBeGreaterThan(fits);
    // regression: keyed by origin and selector, the later box was the first one, already the key's.
    expect(boxes).toContain("https://example.com|2|bb:seen");
    expect(result.outcome).toBe("signed-in");
  }),
);

it.effect("tells no key for a box whose typing failed", () =>
  Effect.gen(function* () {
    const boxes: string[] = [];
    const attempt = yield* run(
      {
        codes: nothingFound,
        onCodeBox: (box, by) => void boxes.push(`${box}:${by}`),
      },
      "never-typed",
      () => "https://example.com",
      { ...scope, unattended: true },
      undefined,
      () => ({ otpApp: true, document: 1, otpBox: "aa" }),
      // Every clear and every typing into the page fails.
      { typeFails: true },
      { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
    ).pipe(Effect.exit);
    expect(attempt._tag).toBeDefined();
    expect(boxes).toContain("https://example.com|1|aa:fits");
    // regression: the key was told before the typing, so a failed one counted as the key's.
    expect(boxes.filter((box) => box.endsWith(":key"))).toEqual([]);
  }),
);

/** The person clicks Use saved once, on the first card that offers it, with that card's revision. */
const clickUseSaved = (fake: ReturnType<typeof fakeAccounts>, clicked?: () => void) => {
  let done = false;
  Object.assign(fake.service, {
    savedRequested: () =>
      Effect.sync(() => {
        const revision = [...fake.handoffs.values()].find(
          (handoff) => handoff.useSavedRevision !== undefined,
        )?.useSavedRevision;
        if (done || revision === undefined) return undefined;
        done = true;
        clicked?.();
        return revision;
      }),
  });
};

it.effect("lets a Use saved pressed at the password put no key into a later code box", () =>
  Effect.gen(function* () {
    const boxes: string[] = [];
    let savedAsked = false;
    const signingIn = yield* run(
      {
        codes: nothingFound,
        onCodeBox: (box, by) => void boxes.push(`${box}:${by}`),
        saved: Effect.succeed({
          password: Redacted.make("synthetic-password"),
          totp: Redacted.make("JBSWY3DPEHPK3PXP"),
        }),
      },
      "never-typed",
      () => "https://example.com",
      scope,
      // The person presses Use saved on the password's hand-off.
      (fake) => clickUseSaved(fake, () => (savedAsked = true)),
      // The password page; once it is in, a code box that speaks of a phone.
      (entered) =>
        entered.includes("synthetic-password")
          ? { document: 2, otpBox: "7:1", otpDelivery: true }
          : { username: null, password: "#password", otp: null, document: 1 },
      {},
    ).pipe(Effect.forkChild);
    for (let minute = 0; minute < 10; minute++) yield* TestClock.adjust("1 minute");
    const { result, typed } = yield* Fiber.join(signingIn);
    expect(savedAsked).toBe(true);
    expect(typed).toContain("synthetic-password");
    // regression: the choice at the password counted for the code box too, and the key went in.
    expect(typed.filter((text) => /^\d{6}$/.test(text))).toEqual([]);
    expect(boxes).toContain("https://example.com|2|7:1:seen");
    expect(boxes.some((box) => box.endsWith(":chosen") || box.endsWith(":key"))).toBe(false);
    expect(result.outcome).not.toBe("signed-in");
  }),
);

it.effect("lets a Use saved pressed at a code box put the key into that box alone", () =>
  Effect.gen(function* () {
    const boxes: string[] = [];
    const signingIn = yield* run(
      {
        codes: nothingFound,
        onCodeBox: (box, by) => void boxes.push(`${box}:${by}`),
        saved: Effect.succeed({
          password: Redacted.make("synthetic-password"),
          totp: Redacted.make("JBSWY3DPEHPK3PXP"),
        }),
      },
      "never-typed",
      () => "https://example.com",
      scope,
      (fake) => clickUseSaved(fake),
      // A code box that names no app, where the person presses Use saved; then another one.
      (entered) =>
        entered.some((text) => /^\d{6}$/.test(text))
          ? { document: 3, otpBox: "9:1", otpField: "9" }
          : { document: 2, otpBox: "5:1", otpField: "5" },
      {},
    ).pipe(Effect.forkChild);
    for (let minute = 0; minute < 10; minute++) yield* TestClock.adjust("1 minute");
    const { typed, typedInputs } = yield* Fiber.join(signingIn);
    expect(typed.filter((text) => /^\d{6}$/.test(text))).toHaveLength(1);
    // The code goes into that very element, in that page load, or nowhere.
    expect(typedInputs.find((input) => /^\d{6}$/.test(String(input["text"])))).toMatchObject({
      instance: "5",
      document: 2,
      mode: "explicit",
    });
    expect(boxes).toContain("https://example.com|2|5:1:chosen");
    // The next box needs its own choice, or the automatic rule.
    expect(boxes).toContain("https://example.com|3|9:1:seen");
    expect(boxes.filter((box) => box.includes("|9:1:") && /:(key|chosen)$/.test(box))).toEqual([]);
  }),
);

it.effect("lets no Use saved put the key into a box for a delivered code", () =>
  Effect.gen(function* () {
    const boxes: string[] = [];
    const signingIn = yield* run(
      {
        codes: nothingFound,
        onCodeBox: (box, by) => void boxes.push(`${box}:${by}`),
        saved: Effect.succeed({
          password: Redacted.make("synthetic-password"),
          totp: Redacted.make("JBSWY3DPEHPK3PXP"),
        }),
      },
      "never-typed",
      () => "https://example.com",
      scope,
      (fake) => clickUseSaved(fake),
      // The person presses Use saved at a box whose page speaks of the code it mailed.
      () => ({ document: 2, otpBox: "5:1", otpDelivery: true }),
      {},
    ).pipe(Effect.forkChild);
    for (let minute = 0; minute < 10; minute++) yield* TestClock.adjust("1 minute");
    const { typed } = yield* Fiber.join(signingIn);
    // regression: the person's choice overrode the veto, and the key went into a mailed code's box.
    expect(typed.filter((text) => /^\d{6}$/.test(text))).toEqual([]);
    expect(boxes.some((box) => /:(key|chosen)$/.test(box))).toBe(false);
  }),
);

it.effect("lets a Use saved click count for nothing once its box was replaced", () =>
  Effect.gen(function* () {
    const boxes: string[] = [];
    let clicked = false;
    const signingIn = yield* run(
      {
        codes: nothingFound,
        onCodeBox: (box, by) => void boxes.push(`${box}:${by}`),
        saved: Effect.succeed({
          password: Redacted.make("synthetic-password"),
          totp: Redacted.make("JBSWY3DPEHPK3PXP"),
        }),
      },
      "never-typed",
      () => "https://example.com",
      scope,
      (fake) => clickUseSaved(fake, () => (clicked = true)),
      // The person clicks Use saved at box 5; the site replaces it with an identical box 6.
      () =>
        clicked
          ? { document: 2, otpBox: "6:1", otpField: "6" }
          : { document: 2, otpBox: "5:1", otpField: "5" },
      {},
    ).pipe(Effect.forkChild);
    for (let minute = 0; minute < 10; minute++) yield* TestClock.adjust("1 minute");
    const { typed } = yield* Fiber.join(signingIn);
    expect(clicked).toBe(true);
    // regression: the click, kept by hand-off, went to whichever box the sign-in looked at next.
    expect(typed.filter((text) => /^\d{6}$/.test(text))).toEqual([]);
    expect(boxes).toContain("https://example.com|2|6:1:seen");
    expect(boxes.some((box) => /:(key|chosen)$/.test(box))).toBe(false);
  }),
);

it.effect(
  "clears the key and hands off when the prompt is redrawn after the fill, before the send",
  () =>
    Effect.gen(function* () {
      const { result, typed, typedInputs, pressed } = yield* run(
        { codes: nothingFound },
        "never-typed",
        () => "https://example.com",
        { ...scope, unattended: true },
        undefined,
        // An authenticator's box; once the key is in, the page redraws it for a texted code.
        (entered) =>
          entered.some((text) => /^\d{6}$/.test(text))
            ? { otpBox: "5:1", otpField: "5", otpContainer: "1", document: 2, otpDelivery: true }
            : { otpBox: "5:1", otpField: "5", otpContainer: "1", document: 2, otpApp: true },
        {},
        { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
      );
      // regression: only limits and checks were read before the send, so the key went out.
      expect(pressed).toEqual([]);
      expect(typed.filter((text) => /^\d{6}$/.test(text))).toHaveLength(1);
      expect(typedInputs.at(-1)).toMatchObject({ text: "", instance: "5", document: 2 });
      expect(result).toMatchObject({
        outcome: "needs-user",
        message: expect.stringContaining("changed"),
      });
    }),
);

it.effect("types no key into a prompt that never reads the same twice", () =>
  Effect.gen(function* () {
    let reads = 0;
    const { result, typed } = yield* run(
      { codes: nothingFound },
      "never-typed",
      () => "https://example.com",
      { ...scope, unattended: true },
      undefined,
      // The box is replaced on every read.
      (_entered, detecting) => {
        if (detecting) reads++;
        return { otpBox: `${reads}:1`, otpField: String(reads), document: 2, otpApp: true };
      },
      {},
      { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
    );
    // regression: the key went in after a single read of a prompt still being drawn.
    expect(typed).toEqual([]);
    expect(result).toMatchObject({
      outcome: "needs-user",
      message: expect.stringContaining("changed"),
    });
  }),
);

it.effect("types nothing when the admitted prompt is replaced by another site's document", () =>
  Effect.gen(function* () {
    let reads = 0;
    const { result, typed } = yield* run(
      { codes: nothingFound },
      "never-typed",
      () => "https://example.com",
      { ...scope, unattended: true },
      undefined,
      // An authenticator's box on the site; then a redirect settles on another HTTPS origin with
      // a box just like it, read the same every time.
      (_entered, detecting) => {
        if (detecting) reads++;
        return reads <= 1
          ? { otpBox: "5:1", otpField: "5", otpContainer: "1", document: 1, otpApp: true }
          : {
              origin: "https://login.example.net",
              otpBox: "5:1",
              otpField: "5",
              otpContainer: "1",
              document: 2,
              otpApp: true,
            };
      },
      {},
      { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
    );
    // regression: two matching reads of the new document gave the old action the new origin.
    expect(typed).toEqual([]);
    expect(result.outcome).not.toBe("signed-in");
  }),
);

it.effect.each([
  { change: "a replacement button under the same selector", after: { submitInstance: "9" } },
  { change: "a limit newly showing", after: { limited: true } },
])("clears the key and hands off when the send finds $change", ({ after }) =>
  Effect.gen(function* () {
    const box = {
      otpBox: "5:1",
      otpField: "5",
      otpContainer: "1",
      document: 2,
      otpApp: true,
      submitInstance: "8",
    };
    const { result, typedInputs, pressed } = yield* run(
      { codes: nothingFound },
      "never-typed",
      () => "https://example.com",
      { ...scope, unattended: true },
      undefined,
      // Only the read at the send, after the earlier look before it, finds the change.
      (entered, detecting) =>
        detecting && entered.some((text) => /^\d{6}$/.test(text)) ? { ...box, ...after } : box,
      {},
      { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
    );
    // regression: the send checked the button by selector only, and no limit or check.
    expect(pressed).toEqual([]);
    expect(typedInputs.at(-1)).toMatchObject({ text: "", instance: "5", document: 2 });
    expect(result.outcome).toBe("needs-user");
  }),
);

it.effect("sends a second password in a resumed attempt only through its gate", () =>
  Effect.gen(function* () {
    let reads = 0;
    const gate: string[] = [];
    const { result, typed } = yield* run(
      {
        codes: nothingFound,
        resume: {
          submissions: [
            { origin: "https://example.com", fields: ["password"], otpPeriod: undefined },
          ],
        },
        fallback: (kind) => Effect.sync(() => void gate.push(kind)).pipe(Effect.as(false)),
      },
      "never-typed",
      () => "https://example.com",
      { ...scope, unattended: true },
      undefined,
      // The code box the attempt resumed at; on the second look the page asks for the password too.
      (_entered, detecting) => {
        if (detecting) reads++;
        const box = { otpBox: "5:1", otpField: "5", otpContainer: "1", document: 2, otpApp: true };
        return reads <= 1 ? box : { ...box, password: "#password" };
      },
      {},
      { password: Redacted.make("synthetic-password"), totp: Redacted.make("JBSWY3DPEHPK3PXP") },
    );
    // regression: the action decided again gained the password, typed without asking the gate.
    expect(typed).not.toContain("synthetic-password");
    expect(gate).toEqual(["password"]);
    expect(result.outcome).toBe("needs-user");
  }),
);

it.effect("leaves the tab as it is when the site may still have the key, and sends no other", () =>
  Effect.gen(function* () {
    const box = { otpBox: "5:1", otpField: "5", otpContainer: "1", document: 2, otpApp: true };
    for (const sendPending of ["in flight", "silent"] as const) {
      const { result, typedInputs, sendDeadlines, pressed, closed } = yield* run(
        { codes: nothingFound },
        "never-typed",
        () => "https://example.com",
        { ...scope, unattended: true },
        undefined,
        () => box,
        { sendPending },
        { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
      );
      // regression: a site still answering, or one whose request nothing saw, was taken to want
      // a real press, and the key was cleared from under it and the attempt dropped.
      expect(typedInputs.filter(({ text }) => text === "")).toEqual([]);
      expect(pressed).toHaveLength(1);
      expect(closed).toEqual([]);
      expect(sendDeadlines).toEqual([50_000]);
      expect(result).toMatchObject({
        outcome: "needs-user",
        message: "Finish signing in on the site's page.",
        pending: { code: false, submissions: [{ fields: ["otp"], unanswered: true }] },
      });
    }
  }),
);

it.effect("sends no code in a resumed attempt after one the site never answered", () =>
  Effect.gen(function* () {
    const { result, typed, pressed } = yield* run(
      {
        codes: nothingFound,
        resume: {
          submissions: [
            {
              origin: "https://example.com",
              fields: ["otp"],
              otpPeriod: undefined,
              saved: true,
              unanswered: true,
            },
          ],
        },
        fallback: () => Effect.succeed(true),
      },
      "never-typed",
      () => "https://example.com",
      { ...scope, unattended: true },
      undefined,
      () => ({ otpBox: "5:1", otpField: "5", otpContainer: "1", document: 2, otpApp: true }),
      {},
      { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
    );
    expect(typed).toEqual([]);
    expect(pressed).toEqual([]);
    // Still the site's: the attempt stays kept, its tab with it.
    expect(result).toMatchObject({ outcome: "needs-user", pending: { code: false } });
  }),
);

it.effect(
  "types the saved key into a plain code box unless the run spoke of a delivered code",
  () =>
    Effect.gen(function* () {
      const plain = { otpBox: "5:1", otpField: "5", otpContainer: "1", document: 2, otpOnly: true };
      // A password page first, then the page's one plain code box.
      const attempt = (
        passwordPage: { readonly codeCue?: true },
        options: Parameters<typeof signIn>[4] = {},
        row = account,
      ) =>
        run(
          { codes: nothingFound, ...options },
          "never-typed",
          () => "https://example.com",
          { ...scope, unattended: true },
          undefined,
          (_typed, _detecting, submits) =>
            submits === 0 ? { password: "#password", otp: null, ...passwordPage } : plain,
          {},
          {
            password: Redacted.make("synthetic-password"),
            totp: Redacted.make("JBSWY3DPEHPK3PXP"),
          },
          row,
        ).pipe(
          Effect.map(({ typedInputs }) =>
            typedInputs.filter(({ text }) => /^\d{6}$/.test(String(text))),
          ),
        );
      // Nothing in the run spoke of a delivered code: the key goes in, checked again as plain.
      expect(yield* attempt({})).toMatchObject([
        { mode: "generic", instance: "5", passwordSent: true },
      ]);
      // regression (AMENDMENTS 63a): a text chosen on an earlier page left the plain box to the key.
      expect(yield* attempt({ codeCue: true })).toEqual([]);
      // "Sign in only when I ask": the saved key is no evidence there.
      expect(
        yield* attempt(
          {},
          {},
          {
            ...account,
            details: {
              kind: "website",
              sites: ["example.com"],
              username: "fixture-user",
              oneSession: true,
            },
          },
        ),
      ).toEqual([]);
      // A resumed run can't see its earlier pages.
      expect(yield* attempt({}, { resume: { submissions: [] } })).toEqual([]);
      // First in the run, the box needs words of a code to be a code challenge (round 23).
      const first = (box: {
        readonly otpContext?: true;
        readonly otpNoForm?: true;
        readonly otpNoSubmit?: true;
        readonly otpUnusable?: true;
      }) =>
        run(
          { codes: nothingFound },
          "never-typed",
          () => "https://example.com",
          { ...scope, unattended: true },
          undefined,
          () => ({ ...plain, ...box }),
          {},
          { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
        ).pipe(
          Effect.map(({ typedInputs }) =>
            typedInputs.filter(({ text }) => /^\d{6}$/.test(String(text))),
          ),
        );
      expect(yield* first({})).toEqual([]);
      expect(yield* first({ otpContext: true })).toMatchObject([{ mode: "generic" }]);
      // A field with no form of its own takes no key on any path (round 33).
      expect(yield* first({ otpContext: true, otpNoForm: true })).toEqual([]);
      // Nor one whose form has no enabled native button to press (round 35).
      expect(yield* first({ otpContext: true, otpNoSubmit: true })).toEqual([]);
      // Nor one the platform says isn't usable (round 36).
      expect(yield* first({ otpContext: true, otpUnusable: true })).toEqual([]);
    }),
);

it.effect("tells the page no earlier password when the password goes with the code", () =>
  Effect.gen(function* () {
    // One form asking for the password and the code together, the code worded as one.
    const { typedInputs, sendInputs } = yield* run(
      { codes: nothingFound },
      "never-typed",
      () => "https://example.com",
      { ...scope, unattended: true },
      undefined,
      () => ({
        password: "#password",
        otpBox: "5:1",
        otpField: "5",
        otpContainer: "1",
        document: 2,
        otpOnly: true,
        otpContext: true,
      }),
      {},
      { password: Redacted.make("synthetic-password"), totp: Redacted.make("JBSWY3DPEHPK3PXP") },
    );
    // regression: the password typed into the same form counted as sent before, so the page's
    // check at the send let a box that lost its words of a code through.
    const key = typedInputs.filter(({ text }) => /^\d{6}$/.test(String(text)));
    expect(key).toMatchObject([{ mode: "generic" }]);
    expect(key[0]).not.toHaveProperty("passwordSent");
    expect(sendInputs).toHaveLength(1);
    expect(sendInputs[0]).toMatchObject({ mode: "generic" });
    expect(sendInputs[0]).not.toHaveProperty("passwordSent");
  }),
);

it.effect("clears the key and hands off when the accounts world refuses the send", () =>
  Effect.gen(function* () {
    const box = {
      otpBox: "5:1",
      otpField: "5",
      otpContainer: "1",
      document: 2,
      otpApp: true,
      submitInstance: "8",
    };
    const { result, typedInputs, pressed } = yield* run(
      { codes: nothingFound },
      "never-typed",
      () => "https://example.com",
      { ...scope, unattended: true },
      undefined,
      () => box,
      { sendRefused: true },
      { totp: Redacted.make("JBSWY3DPEHPK3PXP") },
    );
    // regression: the send resolved a selector outside the world, after the last check.
    expect(pressed).toEqual([]);
    expect(typedInputs.at(-1)).toMatchObject({ text: "", instance: "5", document: 2 });
    expect(result.outcome).toBe("needs-user");
  }),
);
