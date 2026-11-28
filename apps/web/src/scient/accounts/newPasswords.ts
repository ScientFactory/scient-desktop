import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AccountsError,
  BrowserProfileId,
  ThreadId,
  type AccountId,
  type AccountPendingInput,
  type AccountSummary,
  type DesktopCapturedSignIn,
  type DesktopLoginForm,
  type EnvironmentId,
} from "@t3tools/contracts";
import { loginUserKey } from "@t3tools/shared/scientLoginIdentity";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import { secureRandom, strongPassword } from "@t3tools/shared/scientStrongPassword";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { readThreadPreviewState } from "~/previewStateStore";
import { runtimeTab, stillShows } from "./accountAutofill";
import { accountsState } from "./accountsState";

export interface HeldPassword {
  readonly origin: string;
  readonly password: string;
  /** Accounts' hold of it, made before it was filled. */
  readonly pendingId: string;
  /** The login whose Fix filled it, and that login's username. */
  readonly accountId?: AccountId;
  readonly username?: string;
  /** The page it went into. */
  readonly documentId: string;
}

/**
 * Strong passwords Scient put into a sign-up or change form, per tab. Each stays here until the
 * site took it, so a submit the site refuses can be sent again and still be kept.
 */
const held = new Map<string, HeldPassword>();
/** Held passwords being saved and settled now: a repeated submit doesn't send them twice. */
const settling = new WeakSet<HeldPassword>();
/** Held passwords their form sent at least once: never forgotten when the tab fills another. */
const sent = new WeakSet<HeldPassword>();
const isAccountsError = Schema.is(AccountsError);

/** A Fix's wish: its login, the tab it opened, and the origin it opened there. */
interface FixWish {
  readonly account: AccountSummary;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  readonly origin: string;
  readonly until: number;
}
const fixes = new Map<AccountId, FixWish>();
/** The last new-password form each runtime tab reported, for a Fix bound after it showed. */
const shownForms = new Map<string, DesktopLoginForm>();
let fillFix: ((form: DesktopLoginForm) => void) | undefined;
let seekPage: ((fix: FixWish) => void) | undefined;
/** A Fix the person doesn't finish soon is forgotten: a later visit is just a visit. */
const FIX_FOR_MS = 10 * 60 * 1000;
/** A Fix's page with no change form by now (the well-known path missing) gets the site's own. */
const SEEK_PAGE_AFTER_MS = 6_000;
const SETTLE_MS = 6_000;
const RELOOK_MS = 2_000;
const LOOKS = 60;

/** The password Scient made for this tab's form, when the form sent it, unless already saving. */
export function heldPasswordFor(tabId: string, origin: string, submitted: string) {
  const entry = held.get(tabId);
  return entry?.origin === origin && entry.password === submitted && !settling.has(entry)
    ? entry
    : undefined;
}

/**
 * The site's answer, from evidence tied to this submit only: the request the form sent (as the
 * desktop saw it leave) succeeded, and the page right after shows no form and no refusal.
 * Anything else (no such evidence, an older desktop, a later visit) is unclear: the person says.
 */
async function siteAnswer(tabId: string, entry: HeldPassword) {
  const bridge = window.desktopBridge?.accounts;
  if (!bridge?.signInPage) return "unclear" as const;
  for (let look = 0; look < LOOKS; look++) {
    await new Promise((settled) => setTimeout(settled, look === 0 ? SETTLE_MS : RELOOK_MS));
    const answer = (await bridge.signInPage(tabId).catch(() => null))?.submitted;
    if (answer?.documentId !== entry.documentId) continue;
    return answer.status >= 200 &&
      answer.status < 400 &&
      answer.formGone &&
      !answer.refusal &&
      !answer.leftOrigin
      ? ("accepted" as const)
      : ("unclear" as const);
  }
  return "unclear" as const;
}

/**
 * A made password its form sent, held by Accounts since before the fill, until the site's answer:
 * accepted saves it with Undo (or keeps both, its login changed meanwhile); unclear is the
 * person's. A message tried twice and failed is "unsaved"; Accounts still holds the password.
 */
export async function keepMadePassword(
  tabId: string,
  made: HeldPassword,
  capture: DesktopCapturedSignIn,
  sameSite: ReadonlyArray<AccountSummary>,
  actions: {
    readonly rotate: (
      accountId: AccountId | undefined,
      capture: DesktopCapturedSignIn,
      pendingId: string,
    ) => Promise<string | undefined>;
    readonly settle: (pendingId: string, outcome: "accepted" | "unclear") => Promise<boolean>;
  },
) {
  settling.add(made);
  sent.add(made);
  try {
    // The Fix's login takes it unless the form names another account.
    const otherUser =
      capture.username !== "" &&
      made.username !== undefined &&
      loginUserKey(capture.username) !== loginUserKey(made.username);
    const accountId =
      (otherUser ? undefined : made.accountId) ??
      sameSite.find(
        ({ details }) =>
          details.kind === "website" &&
          details.username !== undefined &&
          loginUserKey(details.username) === loginUserKey(capture.username),
      )?.accountId ??
      (!capture.username && sameSite.length === 1 ? sameSite[0]!.accountId : undefined);
    const withMade = { ...capture, password: made.password };
    const pendingId =
      (await actions.rotate(accountId, withMade, made.pendingId)) ??
      (await actions.rotate(accountId, withMade, made.pendingId));
    if (!pendingId) return "unsaved" as const;
    const answer = await siteAnswer(tabId, made);
    if (!(await actions.settle(pendingId, answer))) return "unsaved" as const;
    if (answer === "accepted" && held.get(tabId) === made) held.delete(tabId);
    return answer;
  } finally {
    settling.delete(made);
  }
}

/**
 * Fix for this login, in the tab it opened on `origin`: its change page, when it shows there,
 * fills itself. Only that tab, while it is the person's own, on the login's sites.
 */
export function wantPasswordFix(
  account: AccountSummary,
  opened: {
    readonly environmentId: EnvironmentId;
    readonly threadId: string;
    readonly tabId: string;
    readonly origin: string;
  },
  at: number,
) {
  if (account.details.kind !== "website") return;
  const fix = { account, ...opened, until: at + FIX_FOR_MS };
  fixes.set(account.accountId, fix);
  for (const form of shownForms.values()) fillFix?.(form);
  if (fixes.get(account.accountId) === fix) seekPage?.(fix);
}

/**
 * Fills a strong password the form's stated rules accept into its new-password boxes, and the
 * login's saved password into its current box when the login is known, then holds it for the tab.
 * A Fix's form that shows another account's username is left alone.
 */
export async function fillStrongPassword(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  form: DesktopLoginForm,
  account?: AccountSummary,
) {
  const bridge = window.desktopBridge?.accounts;
  const tab = runtimeTab(form.tabId);
  if (!bridge || !tab || !form.newPassword) return false;
  // Only a server that holds a made password from before its fill (`reserve`) gets one: an
  // older one couldn't keep it once the form is sent.
  const accounts = registry.get(accountsState.snapshot({ environmentId, input: {} }));
  if (!AsyncResult.isSuccess(accounts) || !accounts.value.pendingFeatures?.includes("reserve"))
    return false;
  const password = strongPassword(form.newPassword, secureRandom);
  if (password === undefined) return false;
  const username = account?.details.kind === "website" ? account.details.username : undefined;
  const current = account
    ? await runAtomCommand(
        registry,
        accountsState.fillValues,
        {
          environmentId,
          input: {
            accountId: account.accountId,
            origin: form.url,
            tab: { threadId: ThreadId.make(tab.threadId), tabId: tab.tabId, url: form.url },
          },
        },
        { reportFailure: false },
      )
    : undefined;
  if (!(await stillShows(form.tabId, form.documentId, form.url))) return false;
  // The last check before typing: an agent that took the tab meanwhile gets nothing.
  const threadRef = { environmentId, threadId: ThreadId.make(tab.threadId) };
  if (readThreadPreviewState(threadRef).sessions[tab.tabId]?.automationOwner !== undefined)
    return false;
  // Accounts holds it before it is typed: against the login's password as it is now, and with
  // room for it (when too many wait, nothing is filled, and the person is told).
  const pending = (input: AccountPendingInput) =>
    runAtomCommand(
      registry,
      accountsState.pending,
      { environmentId, input },
      {
        reportFailure: false,
      },
    );
  const reserved = await pending({
    type: "reserve",
    origin: form.url,
    profileId: BrowserProfileId.make(form.profileId),
    password,
    ...(account ? { accountId: account.accountId } : {}),
  });
  const pendingId = reserved._tag === "Success" ? reserved.value.pendingId : undefined;
  if (!pendingId) {
    const error = reserved._tag === "Failure" ? Cause.squash(reserved.cause) : undefined;
    toastManager.add({
      type: "error",
      title: isAccountsError(error)
        ? error.message
        : m(msg("Accounts couldn't hold a new password")),
    });
    return "unheld" as const;
  }
  const saved = current?._tag === "Success" ? current.value.password : undefined;
  const filled = await bridge
    // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- The desktop bridge's fill, not Array.fill.
    .fill({
      tabId: form.tabId,
      expectedOrigin: form.url,
      documentId: form.documentId,
      newPassword: password,
      ...(saved === undefined ? {} : { password: saved }),
      ...(username === undefined ? {} : { username }),
    })
    // No answer from the desktop (it may have typed it): kept, never discarded.
    .catch(() => "unknown" as const);
  // The desktop typed nothing: nothing of it reached the page, and Accounts forgets it.
  if (filled === false) {
    void pending({ type: "discard", pendingId });
    return false;
  }
  // An earlier made password this tab never sent is replaced: Accounts forgets it.
  const before = held.get(form.tabId);
  if (before && !sent.has(before)) void pending({ type: "discard", pendingId: before.pendingId });
  const entry: HeldPassword = {
    origin: form.url,
    password,
    pendingId,
    documentId: form.documentId,
    ...(account ? { accountId: account.accountId } : {}),
    ...(username === undefined ? {} : { username }),
  };
  // Maybe typed, maybe sent: Accounts keeps it until its answer or the person's discard.
  if (filled === "unknown") sent.add(entry);
  held.set(form.tabId, entry);
  return true;
}

/**
 * A Fix's change page fills itself when it shows in the tab the Fix opened, on the login's sites,
 * while no agent controls that tab.
 */
export function watchPasswordFixes(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const bridge = window.desktopBridge?.accounts;
  if (!bridge?.onLoginFormDetected) return () => undefined;
  const consider = (form: DesktopLoginForm) => {
    const tab = runtimeTab(form.tabId);
    if (tab?.environmentId !== environmentId || !form.newPassword) return;
    const now = Date.now();
    for (const [accountId, fix] of fixes) {
      if (fix.until <= now) fixes.delete(accountId);
      else if (
        fix.environmentId === environmentId &&
        fix.threadId === tab.threadId &&
        fix.tabId === tab.tabId &&
        fix.account.details.kind === "website" &&
        // The origin the Fix opened, exactly: another of the login's sites is another place.
        form.url === fix.origin &&
        anySiteMatches(fix.account.details.sites, form.url)
      ) {
        const threadRef = { environmentId, threadId: ThreadId.make(tab.threadId) };
        // An agent took the tab meanwhile: the Fix ends, nothing typed.
        fixes.delete(accountId);
        if (readThreadPreviewState(threadRef).sessions[tab.tabId]?.automationOwner !== undefined)
          return;
        void fillStrongPassword(registry, environmentId, form, fix.account);
        return;
      }
    }
  };
  fillFix = consider;
  // Still waiting a while on: the desktop takes the tab along the site's own links to its change
  // page, never off the origin the Fix opened.
  const seek = (fix: FixWish) =>
    setTimeout(() => {
      const threadRef = { environmentId, threadId: ThreadId.make(fix.threadId) };
      const preview = readThreadPreviewState(threadRef);
      if (
        fixes.get(fix.account.accountId) !== fix ||
        fix.environmentId !== environmentId ||
        preview.sessions[fix.tabId]?.automationOwner !== undefined
      )
        return;
      void bridge
        .seekPasswordPage?.(
          previewRuntimeTabId(threadRef, preview.serverEpoch, fix.tabId),
          fix.origin,
        )
        .catch(() => false);
    }, SEEK_PAGE_AFTER_MS);
  seekPage = seek;
  const stop = bridge.onLoginFormDetected((form) => {
    if (form.newPassword) shownForms.set(form.tabId, form);
    else shownForms.delete(form.tabId);
    consider(form);
  });
  return () => {
    stop();
    if (fillFix === consider) fillFix = undefined;
    if (seekPage === seek) seekPage = undefined;
    shownForms.clear();
  };
}
