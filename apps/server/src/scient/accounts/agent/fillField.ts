import {
  AccountsError,
  type AccountId,
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
import { agentSignInOnHold } from "../AccountDecisions.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { SignInDetection, signInDetectionScript } from "../signIn/detection.ts";
import { matchesAccountOrigin } from "../signIn/origin.ts";
import { accountOtp } from "../signIn/totp.ts";
import { authorizePreviewTab } from "./previewProfileAccess.ts";

/** Only the agent sees whether a password worked, so a refused one must not be able to repeat. */
const PASSWORD_FILL_GAP_MS = 15 * 60 * 1000;
const passwordFills = new Map<AccountId, number>();

const decodeDetection = Schema.decodeUnknownEffect(SignInDetection);

const denied = (message: string) => new AccountsError({ reason: "denied", message });

/**
 * Types one saved value into the agent's own tab, on a page of the account's sites. The agent reads
 * the page and presses its buttons, in any language; the value never reaches it through this tool.
 */
export const fillField = Effect.fn("AccountsAgent.fillField")(function* (
  scope: AccountSessionScope,
  account: AccountSummary,
  input: {
    readonly field: "username" | "password" | "code";
    readonly tabId?: PreviewTabId | undefined;
    readonly selector?: string | undefined;
  },
) {
  const { details } = account;
  if (details.kind !== "website" && details.kind !== "library")
    return yield* denied("Only website and library accounts fill a page.");
  const now = yield* Clock.currentTimeMillis;
  if (agentSignInOnHold(account, scope, now))
    return {
      filled: false,
      message: "The last sign-in for this account didn't go through. Tell the user.",
    };
  const lastPassword = passwordFills.get(account.accountId);
  if (
    input.field === "password" &&
    lastPassword !== undefined &&
    now - lastPassword < PASSWORD_FILL_GAP_MS
  )
    return {
      filled: false,
      message: "This password was filled moments ago. If the site refused it, tell the user.",
    };
  const accounts = yield* AccountsService;
  const broker = yield* PreviewAutomationBroker;
  const invocation = yield* AgentInvocationContext;
  const invoke = <A>(
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    value: unknown,
    tabId?: PreviewTabId,
  ) =>
    broker
      .invoke<A>({
        scope: invocation,
        operation,
        input: value,
        ...(tabId === undefined ? {} : { tabId }),
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new AccountsError({
              reason: "unavailable",
              message: error.message || "The browser could not fill this field.",
            }),
        ),
      );
  const status = yield* invoke<PreviewAutomationStatus>("status", {}, input.tabId);
  const tabId = input.tabId ?? status.tabId ?? undefined;
  if (!status.tabs?.some((tab) => tab.tabId === tabId && tab.ownedByCaller))
    return yield* denied("Fill only your own browser tab.");
  yield* authorizePreviewTab(scope, status, tabId);
  const page = yield* decodeDetection(
    yield* invoke<unknown>("evaluate", { expression: signInDetectionScript }, tabId),
  ).pipe(
    Effect.mapError(
      () => new AccountsError({ reason: "unavailable", message: "The page could not be read." }),
    ),
  );
  if (!matchesAccountOrigin(page.origin, details.sites))
    return yield* denied("This page isn't on one of the account's sites.");
  // Only the field asked for: another field's store may be locked or disconnected.
  const secretText = Effect.fn("AccountsAgent.fillSecret")(function* (field: "password" | "code") {
    const secret = field === "password" ? "password" : "totp";
    const value = (yield* accounts.resolveSecrets(account.accountId, [secret]))[secret];
    if (value === undefined) return undefined;
    return field === "password" ? Redacted.value(value) : accountOtp(Redacted.value(value), now);
  });
  const found = { username: page.username, password: page.password, code: page.otp }[input.field];
  const selector = input.selector ?? found;
  if (!selector)
    return { filled: false, message: "No such field found. Pass its selector if you can see it." };
  const text = input.field === "username" ? details.username : yield* secretText(input.field);
  if (text === undefined)
    return { filled: false, message: `This account has no saved ${input.field}.` };
  yield* invoke("accountType", { origin: page.origin, selector, text, clear: true }, tabId);
  if (input.field === "password") passwordFills.set(account.accountId, now);
  return { filled: true };
});
