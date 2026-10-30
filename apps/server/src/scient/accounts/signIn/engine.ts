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
import { SignInDetection, signInDetectionScript, tickRememberScript } from "./detection.ts";
import { accountOtp, parseTotp } from "./totp.ts";
import { matchesAccountOrigin } from "./origin.ts";

const decodeDetection = Schema.decodeUnknownEffect(SignInDetection);
const REJECTION_SETTLE_CHECKS = 5;

export const signIn = Effect.fn("AccountsAgent.signIn")(function* (
  session: AccountSessionScope,
  account: AccountSummary,
  secrets: Readonly<Record<string, Redacted.Redacted<string>>>,
  tabId?: PreviewTabId,
  options: {
    /** The user's own check: their profile's agent access doesn't apply. */
    readonly userRun?: boolean;
    /** Waits for a code the user types into a private card, on any of their devices. */
    readonly askCode?: (site: string) => Effect.Effect<string, never, never>;
    /** Looks once for a code in the sources the user turned on. */
    readonly findCode?: (sinceMs: number) => Effect.Effect<string | undefined, never, never>;
  } = {},
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
        // Browser errors are written for agents (a full tab limit, a closed tab); keep them.
        Effect.mapError(
          (error) =>
            new AccountsError({
              reason: "unavailable",
              message: error.message || "The browser sign-in could not be completed.",
            }),
        ),
      );
  const status = yield* invoke<PreviewAutomationStatus>("status", {}, tabId);
  const current = status.tabs?.find((tab) => tab.tabId === (tabId ?? status.tabId));
  const onSite = current?.url ? matchesAccountOrigin(current.url, details.sites) : false;
  const sameProfile = details.profileId === undefined || current?.profileId === details.profileId;
  // The agent's own tab is used when it is on the account's site (in any profile: the password
  // works anywhere) or in the account's profile, where it is sent to the site. A new tab opens the
  // sign-in page, this page, or the account's first site.
  const reuse = current?.ownedByCaller === true && (sameProfile || (tabId !== undefined && onSite));
  const firstSite = details.sites[0];
  const siteUrl =
    firstSite && (firstSite.startsWith("https://") ? firstSite : `https://${firstSite}`);
  const destination =
    details.loginUrl ?? (reuse ? (onSite ? undefined : siteUrl) : onSite ? current?.url : siteUrl);
  const openInput = {
    ...(destination ? { url: destination } : {}),
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
  const open = (profileId: string | undefined) =>
    invoke<PreviewAutomationStatus>(
      "open",
      { ...openInput, ...(profileId === undefined ? {} : { profileId }) },
      reuse ? current?.tabId : undefined,
    );
  const opened = options.userRun
    ? yield* open(current?.profileId ?? details.profileId)
    : yield* authorizePreviewProfile(session, status, openInput).pipe(
        Effect.flatMap(({ profileId }) => recordProfileUse(session, profileId, open(profileId))),
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
        if (page.limited)
          return { outcome: "limited" as const, message: action.message, tabId: target };
        if (session.unattended || action.kind === undefined)
          return { outcome: "needs-user" as const, message: action.message, tabId: target };
        const handoffId = NodeCrypto.randomUUID();
        const startedAt = timestamp;
        const enterCode = Effect.fn("accounts.signIn.enterCode")(function* (code: string) {
          const field = yield* inspect(step);
          if (!field.page.otp) return "continue" as const;
          yield* invoke(
            "accountType",
            { origin: field.page.origin, selector: field.page.otp, text: code, clear: true },
            target,
          );
          submissions.push({
            origin: field.page.origin,
            fields: ["otp"],
            otpPeriod: undefined,
          });
          if (field.page.submit) yield* invoke("click", { selector: field.page.submit }, target);
          else yield* invoke("press", { key: "Enter" }, target);
          yield* invoke("accountWaitForLoad", { settleMs: 1000 }, target);
          ({ page, timestamp, otpPeriod, continuation } = yield* inspect(step));
          return "continue" as const;
        });
        const answered =
          action.kind === "code" && options.askCode
            ? options.askCode(new URL(page.origin).host).pipe(Effect.flatMap(enterCode))
            : Effect.never;
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
            const found =
              action.kind === "code" && options.findCode
                ? yield* options.findCode(startedAt)
                : undefined;
            if (found !== undefined) return yield* enterCode(found);
          }
          return "timeout" as const;
        });
        const result = yield* Effect.raceFirst(wait, answered).pipe(
          Effect.ensuring(accounts.removeHandoff(handoffId)),
        );
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
        if (continuation.type !== "continue")
          return { outcome: continuation.type, message: continuation.message, tabId: target };
        if (action.type === "needs-user")
          return { outcome: "needs-user" as const, message: action.message, tabId: target };
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
      // Keeps the session and skips codes next time; never worth failing a sign-in over.
      if (page.remember)
        yield* invoke("evaluate", { expression: tickRememberScript(page.remember) }, target).pipe(
          Effect.ignore,
        );
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
