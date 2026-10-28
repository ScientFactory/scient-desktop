// @effect-diagnostics nodeBuiltinImport:off -- Opaque hand-off ids use the operating system CSPRNG.
import {
  AccountsError,
  type AccountSummary,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { authorizePreviewProfile, recordProfileUse } from "../agent/previewProfileAccess.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { decideSignIn, decideSignInContinuation, type SignInSubmission } from "./decision.ts";
import { SignInDetection, signInDetectionScript } from "./detection.ts";
import { accountOtp, parseTotp } from "./totp.ts";
import { matchesAccountOrigin } from "./origin.ts";

const decodeDetection = Schema.decodeUnknownEffect(SignInDetection);
const REJECTION_SETTLE_CHECKS = 5;

export const signIn = Effect.fn("AccountsAgent.signIn")(function* (
  session: AccountSessionScope,
  account: AccountSummary,
  secrets: Readonly<Record<string, Redacted.Redacted<string>>>,
  tabId?: PreviewTabId,
) {
  if (account.details.kind !== "website" && account.details.kind !== "library")
    return yield* new AccountsError({
      reason: "invalid-input",
      message: "Choose a website or library account to sign in.",
    });
  const details = account.details;
  const scope = yield* AgentInvocationContext;
  if (!scope.capabilities.has("preview"))
    return yield* new AccountsError({
      reason: "denied",
      message: "Browser access is disabled for this session.",
    });
  const broker = yield* PreviewAutomationBroker;
  const accounts = yield* AccountsService;
  const invoke = <A>(
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    input: unknown,
    target?: PreviewTabId,
  ) =>
    broker
      .invoke<A>({ scope, operation, input, ...(target === undefined ? {} : { tabId: target }) })
      .pipe(
        Effect.mapError(
          () =>
            new AccountsError({
              reason: "unavailable",
              message: "The browser sign-in could not be completed.",
            }),
        ),
      );
  const status = yield* invoke<PreviewAutomationStatus>("status", {}, tabId);
  const current = status.tabs?.find((tab) => tab.tabId === (tabId ?? status.tabId));
  const reuse =
    current?.ownedByCaller === true &&
    (details.profileId === undefined || current.profileId === details.profileId);
  const openInput = {
    ...(details.loginUrl === undefined ? {} : { url: details.loginUrl }),
    ...(details.profileId === undefined ? {} : { profileId: details.profileId }),
    reuseExistingTab: reuse,
    ...(reuse && current ? { tabId: current.tabId } : {}),
    open: false,
  };
  if (details.loginUrl && !matchesAccountOrigin(details.loginUrl, details.sites))
    return yield* new AccountsError({
      reason: "denied",
      message: "The sign-in URL does not match the account's sites.",
    });
  const profile = yield* authorizePreviewProfile(session, status, openInput);
  const opened = yield* recordProfileUse(
    session,
    profile.profileId,
    invoke<PreviewAutomationStatus>(
      "open",
      { ...openInput, profileId: profile.profileId },
      reuse ? current?.tabId : undefined,
    ),
  );
  if (!opened.tabId)
    return yield* new AccountsError({
      reason: "unavailable",
      message: "No browser tab is available for sign-in.",
    });
  const target = opened.tabId;
  const password = secrets.password === undefined ? undefined : Redacted.value(secrets.password);
  const totp = secrets.totp === undefined ? undefined : Redacted.value(secrets.totp);
  // Only the last submission's fields: earlier pages are gone, and after a hand-off the user
  // continues with what is on screen.
  let filled: Array<{ origin: string; selector: string; expected: string }> = [];
  const submissions: SignInSubmission[] = [];
  // Cleared unless the sign-in succeeded or the user takes over, including on interruption.
  let clearFilled = true;
  let cleanupFailed = false;
  const run = Effect.gen(function* () {
    const inspect = Effect.fn("accounts.signIn.inspect")(function* (step: number) {
      const detected = yield* invoke<unknown>(
        "evaluate",
        { expression: signInDetectionScript },
        target,
      );
      const page = yield* decodeDetection(detected).pipe(
        Effect.mapError(
          () =>
            new AccountsError({
              reason: "unavailable",
              message: "The sign-in page could not be inspected.",
            }),
        ),
      );
      const timestamp = yield* Clock.currentTimeMillis;
      const otpPeriod =
        !page.otp || totp === undefined || /^\d{6,8}$/.test(totp)
          ? undefined
          : yield* Effect.try({
              try: () => Math.floor(timestamp / (parseTotp(totp).period * 1000)),
              catch: () =>
                new AccountsError({
                  reason: "invalid-input",
                  message: "The account's two-factor setup is invalid.",
                }),
            });
      const continuation = decideSignInContinuation(page, submissions, step, otpPeriod);
      return { page, timestamp, otpPeriod, continuation };
    });
    for (let step = 0; step <= 6; step++) {
      let { page, timestamp, otpPeriod, continuation } = yield* inspect(step);
      // Script-submitted logins answer after "load"; a field still on screen is only a
      // rejection once the page has had a few seconds to respond.
      for (
        let wait = 0;
        wait < REJECTION_SETTLE_CHECKS &&
        (continuation.type === "password-rejected" || continuation.type === "code-rejected") &&
        !page.signedIn;
        wait++
      ) {
        yield* invoke("accountWaitForLoad", { settleMs: 1000 }, target);
        ({ page, timestamp, otpPeriod, continuation } = yield* inspect(step));
      }
      if (continuation.type !== "continue" && !page.signedIn)
        return { outcome: continuation.type, message: continuation.message, tabId: target };
      let action = decideSignIn(page, details.sites, {
        username: details.username !== undefined,
        password: password !== undefined,
        otp: totp !== undefined,
      });
      if (action.type === "signed-in" || action.type === "needs-user") clearFilled = false;
      if (action.type === "signed-in") return { outcome: "signed-in" as const, tabId: target };
      if (action.type === "needs-user") {
        if (session.unattended || action.kind === undefined)
          return { outcome: "needs-user" as const, message: action.message, tabId: target };
        const handoffId = NodeCrypto.randomUUID();
        const startedAt = timestamp;
        const wait = Effect.gen(function* () {
          let published = "";
          const update = Effect.fn("accounts.signIn.updateHandoff")(function* () {
            if (action.type !== "needs-user" || action.kind === undefined) return;
            const site = new URL(page.origin).host;
            const number =
              action.kind === "push" && page.number && /^\d{1,3}$/.test(page.number)
                ? page.number
                : undefined;
            const signature = `${action.kind}|${site}|${number ?? ""}`;
            if (signature === published) return;
            yield* accounts.setHandoff(
              {
                handoffId,
                threadId: session.threadId,
                accountId: account.accountId,
                accountName: account.name,
                site,
                tabId: target,
                kind: action.kind,
                ...(number === undefined ? {} : { number }),
                startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
                expiresAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt + 180_000)),
              },
              invoke("open", { tabId: target, reuseExistingTab: true, open: true }, target).pipe(
                Effect.asVoid,
              ),
            );
            published = signature;
          });
          // The card shows this tab live in the conversation; "Open browser" reveals it elsewhere.
          yield* update();
          for (let poll = 0; poll < 90; poll++) {
            if (yield* accounts.handoffCancelled(handoffId)) return "cancelled" as const;
            // The user's actions navigate the page; a look that fails mid-navigation is retried.
            const looked = yield* invoke("accountWaitForLoad", { settleMs: 2000 }, target).pipe(
              Effect.andThen(inspect(step)),
              Effect.option,
            );
            if (yield* accounts.handoffCancelled(handoffId)) return "cancelled" as const;
            if (looked._tag === "None") continue;
            ({ page, timestamp, otpPeriod, continuation } = looked.value);
            action = decideSignIn(page, details.sites, {
              username: details.username !== undefined,
              password: password !== undefined,
              otp: totp !== undefined,
            });
            if (action.type !== "needs-user" || action.kind === undefined)
              return "continue" as const;
            if (timestamp - startedAt >= 180_000) break;
            yield* update();
          }
          return "timeout" as const;
        }).pipe(Effect.ensuring(accounts.removeHandoff(handoffId)));
        const result = yield* wait;
        if (result !== "continue")
          return {
            outcome: "needs-user" as const,
            message:
              result === "cancelled"
                ? "The user cancelled the sign-in."
                : "The user did not finish signing in within 3 minutes.",
            tabId: target,
          };
        action = decideSignIn(page, details.sites, {
          username: details.username !== undefined,
          password: password !== undefined,
          otp: totp !== undefined,
        });
        if (action.type === "signed-in") return { outcome: "signed-in" as const, tabId: target };
        if (action.type === "needs-user")
          return { outcome: "needs-user" as const, message: action.message, tabId: target };
        if (continuation.type !== "continue")
          return { outcome: continuation.type, message: continuation.message, tabId: target };
      }
      clearFilled = true;
      filled = [];
      for (const field of action.fields) {
        const text = yield* Effect.try({
          try: () =>
            field.field === "username"
              ? details.username!
              : field.field === "password"
                ? password!
                : accountOtp(totp!, timestamp),
          catch: () =>
            new AccountsError({
              reason: "invalid-input",
              message: "The account's two-factor setup is invalid.",
            }),
        });
        filled.push({ origin: page.origin, selector: field.selector, expected: text });
        yield* invoke(
          "accountType",
          { origin: page.origin, selector: field.selector, text, clear: true },
          target,
        );
      }
      submissions.push({
        origin: page.origin,
        fields: action.fields.map(({ field }) => field),
        otpPeriod,
      });
      if (action.submit) yield* invoke("click", { selector: action.submit }, target);
      else yield* invoke("press", { key: "Enter" }, target);
      yield* invoke("accountWaitForLoad", {}, target);
    }
    return {
      outcome: "failed" as const,
      message: "Sign-in did not finish after six steps.",
      tabId: target,
    };
  });
  return yield* run.pipe(
    Effect.orElseSucceed(() => ({
      outcome: "failed" as const,
      message: "The browser sign-in could not be completed.",
      tabId: target,
    })),
    Effect.ensuring(
      Effect.gen(function* () {
        if (!clearFilled) return;
        for (const field of filled)
          yield* invoke("accountType", { ...field, text: "", clear: true }, target).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                cleanupFailed = true;
              }),
            ),
          );
      }),
    ),
    Effect.map((result) =>
      cleanupFailed
        ? {
            ...result,
            message: `${"message" in result ? result.message : "Sign-in did not finish."} Some filled fields could not be cleared; ask the user to clear them in the browser.`,
          }
        : result,
    ),
  );
});
