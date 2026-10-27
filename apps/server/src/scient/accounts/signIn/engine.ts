import {
  AccountsError,
  type AccountSummary,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { authorizePreviewProfile, recordProfileUse } from "../agent/previewProfileAccess.ts";
import type { AccountSessionScope } from "../AccountsService.ts";
import { decideSignIn } from "./decision.ts";
import { SignInDetection, signInDetectionScript } from "./detection.ts";
import { accountOtp } from "./totp.ts";
import { matchesAccountOrigin } from "./origin.ts";

const decodeDetection = Schema.decodeUnknownEffect(SignInDetection);

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
  for (let step = 0; step < 6; step++) {
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
    const action = decideSignIn(page, details.sites, {
      username: details.username !== undefined,
      password: password !== undefined,
      otp: totp !== undefined,
    });
    if (action.type === "signed-in") return { outcome: "signed-in" as const, tabId: target };
    if (action.type === "needs-user")
      return { outcome: "needs-user" as const, message: action.message, tabId: target };
    const timestamp = yield* Clock.currentTimeMillis;
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
      yield* invoke(
        "accountType",
        { origin: page.origin, selector: field.selector, text, clear: true },
        target,
      );
    }
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
