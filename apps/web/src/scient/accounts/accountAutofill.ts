import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  INCOGNITO_BROWSER_PROFILE_ID,
  ThreadId,
  type AccountId,
  type DesktopLoginForm,
  type EnvironmentId,
} from "@t3tools/contracts";
import { automaticSignInOnHold } from "@t3tools/shared/scientAccountSignIn";
import { loginUserKey } from "@t3tools/shared/scientLoginIdentity";
import { isLoginPlace } from "@t3tools/shared/scientSignInPage";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { readThreadPreviewState } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";
import { accountsState } from "./accountsState";
import { agentMayUse, automaticSignIn, fillableAccounts, fillChoice } from "./accountsView";
import { signInEvidence, type CookieMetadata } from "./sessionDetection";

/** Runtime tab ids are `[environmentId, threadId, serverEpoch, tabId]` (`previewRuntimeTabId`). */
export function runtimeTab(id: string) {
  try {
    const [environmentId, threadId, , tabId] = JSON.parse(id) as unknown[];
    return typeof environmentId === "string" &&
      typeof threadId === "string" &&
      typeof tabId === "string"
      ? { environmentId, threadId, tabId }
      : null;
  } catch {
    return null;
  }
}

/** The server's record of a fill in a runtime tab, which keeps the page from agents that may not use it. */
export function filledTabRecord(runtimeTabId: string, url: string) {
  const tab = runtimeTab(runtimeTabId);
  return tab
    ? { threadId: ThreadId.make(tab.threadId), tabId: tab.tabId, url: new URL(url).origin }
    : undefined;
}

/**
 * Whether the tab still shows the document its values were read for: a page reloaded or replaced
 * meanwhile gets none of them. The insertion checks the document again in the page itself.
 */
export async function stillShows(tabId: string, documentId: string, origin: string) {
  const loginForm = window.desktopBridge?.accounts?.loginForm;
  if (!loginForm) return true;
  const form = await loginForm(tabId).catch(() => null);
  return form?.documentId === documentId && form.url === origin;
}

/** A submitted form has had time to reject the password by now. */
const SIGN_IN_SETTLE_MS = 6_000;
/** A page still loading or asking for a code is looked at this often, for up to two minutes. */
const SIGN_IN_RELOOK_MS = 2_000;
const SIGN_IN_LOOKS = 60;
/** Looks at a settled page with only unproven cookies before the card asks the person. */
const UNPROVEN_LOOKS = 3;
/** A setup's code is refreshed for this many of its periods, then left. */
const OTP_REFRESHES = 10;
/** A page whose keep failed is read and sealed again after this pause, once. */
const KEEP_RETRY_MS = 1_000;

/**
 * Whether a sign-in sent from `submitted` (origin and path) finished: past every login and code
 * box on another page, with an authenticated session for the site since it was sent (`signedIn`).
 * The whole transition is followed, for two minutes: a page loading or asking for a code, a
 * session set a moment after the page settles, until the page is back at a login box (a refusal).
 */
export async function signInFinished(
  tabId: string,
  submitted: string,
  signedIn: () => Promise<"signed-in" | "unverified" | "none">,
): Promise<"signed-in" | "unverified" | false> {
  const read = window.desktopBridge?.accounts?.signInPage;
  if (!read) return false;
  // Settled past the form with only unproven cookies for this many looks: the person decides.
  let unproven = 0;
  for (let look = 0; look < SIGN_IN_LOOKS; look++) {
    await new Promise((settled) =>
      setTimeout(settled, look === 0 ? SIGN_IN_SETTLE_MS : SIGN_IN_RELOOK_MS),
    );
    const page = await read(tabId).catch(() => null);
    if (page === null) return false;
    if (page.state === "loading" || page.state === "code") continue;
    // Its form again, or another login box: the site said no.
    if (page.state !== "done") return false;
    const now = URL.parse(page.url);
    if (now === null) return false;
    // Still where it was sent from, or no session yet: follow it a little longer.
    if (`${now.origin}${now.pathname}` === submitted) continue;
    const evidence = await signedIn();
    if (evidence === "signed-in") return "signed-in";
    if (evidence === "unverified" && ++unproven >= UNPROVEN_LOOKS) return "unverified";
  }
  return unproven > 0 ? "unverified" : false;
}

const filled = new Map<string, { readonly accountId: string; readonly url: string }>();
const listeners = new Set<() => void>();

/** The sign-in autofill put into each runtime tab, for the toolbar's chip. */
export const autofilledTabs = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (runtimeTabId: string) => filled.get(runtimeTabId),
};

/**
 * Fills saved sign-ins into every login form in this environment's tabs, but never over typed text
 * or in incognito. An agent's tab gets only what that agent may use; the server keeps the user's
 * filled pages from other agents. It submits only to sign the user back in: their own tab, the
 * site's one saved sign-in, known to work.
 */
export function watchAccountAutofill(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const bridge = window.desktopBridge?.accounts;
  if (!bridge?.originBoundFill || !bridge.onLoginFormDetected) return () => undefined;
  const cookies = (profileId: string) =>
    bridge.cookieMetadata?.(profileId, environmentId).catch(() => null) ?? Promise.resolve(null);
  const snapshot = async () => {
    const current = registry.get(accountsState.snapshot({ environmentId, input: {} }));
    if (AsyncResult.isSuccess(current)) return current.value;
    const read = await runAtomCommand(
      registry,
      accountsState.readSnapshot,
      { environmentId, input: { omitExternalIdentities: true } },
      { reportFailure: false },
    );
    return read._tag === "Success" ? read.value : undefined;
  };
  /**
   * Keeps a setup's code box current: each new period's code (the period the server read in the
   * key) goes in only while the tab shows the same document and the box still holds Scient's last
   * code for this same setup, or was cleared for a fresh one.
   */
  const refreshSetupCode = async (
    form: DesktopLoginForm,
    pendingId: string,
    first: string,
    period: number,
  ) => {
    let last = first;
    const periodMs = period * 1000;
    for (let turn = 0; turn < OTP_REFRESHES; turn++) {
      await new Promise((settled) => setTimeout(settled, periodMs - (Date.now() % periodMs) + 500));
      if (!(await stillShows(form.tabId, form.documentId, form.url))) return;
      const next = await runAtomCommand(
        registry,
        accountsState.pending,
        { environmentId, input: { type: "code", pendingId } },
        { reportFailure: false },
      );
      if (next._tag !== "Success" || !next.value.code) return;
      if (next.value.code === last) continue;
      const typed = await bridge
        // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- The desktop bridge's fill, not Array.fill.
        .fill({
          tabId: form.tabId,
          expectedOrigin: form.url,
          documentId: form.documentId,
          otp: next.value.code,
          otpExpected: last,
        })
        .catch(() => false);
      if (!typed) return;
      last = next.value.code;
    }
  };
  /** What Scient last typed as a password in each tab, and in which document. */
  const typedIn = new Map<string, { documentId: string; password: string }>();
  /**
   * `followUp`: the form back after a submit's result, filled for the person to submit, never by
   * itself; `expected`, Scient's own earlier password in the box, replaced only while still there.
   */
  const fill = async (form: DesktopLoginForm, followUp?: { expected?: string }) => {
    const expected = followUp?.expected;
    const tab = runtimeTab(form.tabId);
    if (tab?.environmentId !== environmentId) return;
    const threadRef = { environmentId, threadId: ThreadId.make(tab.threadId) };
    const agentTab =
      readThreadPreviewState(threadRef).sessions[tab.tabId]?.automationOwner !== undefined;
    // A 2FA setup or backup codes in the person's own tab: the desktop reads and seals them for
    // its backend, which holds them for the person; this app carries only the sealed text. A
    // failed keep is read again once (the page may not report again). The setup's code goes into
    // an empty box, then is refreshed each period while the box still holds it.
    if (form.offer) {
      const accounts = await snapshot();
      if (
        agentTab ||
        !bridge.pageSecrets ||
        form.profileId === INCOGNITO_BROWSER_PROFILE_ID ||
        !form.url.startsWith("https://") ||
        accounts?.pendingFeatures?.includes("page-seal") !== true
      )
        return;
      const offer = form.offer;
      const keep = async () => {
        const shown = await bridge
          .pageSecrets?.(form.tabId, offer, form.documentId)
          .catch(() => null);
        if (!shown) return undefined;
        const kept = await runAtomCommand(
          registry,
          accountsState.pageKeep,
          {
            environmentId,
            input: { offer, documentId: form.documentId, sealed: shown.sealed },
          },
          { reportFailure: false },
        );
        return kept._tag === "Success" && kept.value.found ? kept.value : undefined;
      };
      const kept =
        (await keep()) ??
        (await new Promise((settled) => setTimeout(settled, KEEP_RETRY_MS)).then(keep));
      if (!kept?.code) return;
      const typed = await bridge
        // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- The desktop bridge's fill, not Array.fill.
        .fill({
          tabId: form.tabId,
          expectedOrigin: form.url,
          documentId: form.documentId,
          automatic: true,
          otp: kept.code,
        })
        .catch(() => false);
      if (typed && kept.pendingId)
        await refreshSetupCode(form, kept.pendingId, kept.code, kept.period ?? 30);
      return;
    }
    // The page reports a form once per set of login boxes, and when the user clicks into one.
    const replacing =
      expected !== undefined &&
      !form.userEdited &&
      form.profileId !== INCOGNITO_BROWSER_PROFILE_ID &&
      form.url.startsWith("https://");
    if (!automaticSignIn(form) && !replacing) return;
    const accounts = await snapshot();
    if (!accounts) return;
    // A page an agent controls can read what is filled, so it gets only accounts that agent may use.
    const projectId = appAtomRegistry.get(
      environmentThreadShells.threadShellAtom(threadRef),
    )?.projectId;
    const matches = fillableAccounts(accounts.accounts, form.url, form.profileId);
    const { account, otherUsername } = fillChoice(
      matches.filter(
        (match) =>
          !agentTab ||
          (agentMayUse(match.controls, accounts.agentAccess, projectId) &&
            match.signIn?.state !== "password-rejected" &&
            match.signIn?.state !== "limited"),
      ),
      form.boxes,
    );
    if (!account) return;
    const pageUrl = form.pageUrl ?? form.url;
    // Only a sign-in page: a form asking for the password on "close account" looks just the same.
    // The server grants a submit by itself (`submit`) only with no failure on the site in the hour.
    const mayTry =
      followUp === undefined &&
      !agentTab &&
      form.hasPassword &&
      matches.length === 1 &&
      account.details.kind === "website" &&
      (account.details.profileId ?? form.profileId) === form.profileId &&
      !automaticSignInOnHold(account, Date.now(), true) &&
      isLoginPlace(new URL(pageUrl));
    const values = await runAtomCommand(
      registry,
      accountsState.fillValues,
      {
        environmentId,
        input: {
          accountId: account.accountId,
          origin: form.url,
          tab: { threadId: ThreadId.make(tab.threadId), tabId: tab.tabId, url: form.url },
          ...(mayTry ? { autoSubmit: true as const } : {}),
        },
      },
      { reportFailure: false },
    );
    if (values._tag !== "Success" || !(await stillShows(form.tabId, form.documentId, form.url)))
      return;
    const { attempt, password } = values.value;
    const submit = mayTry && values.value.submit === true && attempt !== undefined;
    const accountId = account.accountId;
    // A submit by itself is registered before the fill: the form coming back waits for its result.
    if (submit && password !== undefined) {
      const before = await cookies(form.profileId);
      register({ form, accountId, attempt, before: Promise.resolve(before) });
    }
    const done = await bridge
      // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- The desktop bridge's fill, not Array.fill.
      .fill({
        tabId: form.tabId,
        expectedOrigin: form.url,
        documentId: form.documentId,
        automatic: true,
        ...(submit ? { submit: true } : {}),
        ...(values.value.username === undefined ? {} : { username: values.value.username }),
        ...(otherUsername === undefined ? {} : { otherUsername }),
        ...(password === undefined ? {} : { password }),
        ...(values.value.otp === undefined ? {} : { otp: values.value.otp }),
        ...(replacing ? { passwordExpected: expected } : {}),
      })
      .catch(() => false);
    if (!done) return;
    if (password !== undefined) typedIn.set(form.tabId, { documentId: form.documentId, password });
    filled.set(form.tabId, { accountId, url: pageUrl });
    for (const listener of listeners) listener();
    if (submit || attempt === undefined || password === undefined || !form.hasPassword) return;
    // The person's own submit of what Scient typed, seen when it is captured, is answered too.
    typedBy.set(form.tabId, {
      form,
      accountId,
      password,
      username: values.value.username,
      attempt,
    });
  };
  /** The fills each tab's person may still submit: what Scient typed, and its one-time attempt. */
  const typedBy = new Map<
    string,
    {
      form: DesktopLoginForm;
      accountId: AccountId;
      password: string;
      username: string | undefined;
      attempt: string;
    }
  >();
  interface Sent {
    readonly form: DesktopLoginForm;
    readonly accountId: AccountId;
    readonly attempt: string;
    /** The site's cookies as it was sent. */
    readonly before: Promise<ReadonlyArray<CookieMetadata> | null>;
  }
  /** Each tab's submitted sign-in until its result, and that result's promise. */
  const sent = new Map<string, { entry: Sent; settled: Promise<void> }>();
  const register = (entry: Sent) => sent.set(entry.form.tabId, { entry, settled: answer(entry) });
  const seen = (entry: Sent, outcome: "signed-in" | "password-rejected" | "limited") =>
    runAtomCommand(
      registry,
      accountsState.signInSeen,
      {
        environmentId,
        input: { accountId: entry.accountId, outcome, attempt: entry.attempt },
      },
      { reportFailure: false },
    );
  /** What the site's cookies say since the submit; "unknown" when a read of them failed. */
  const newSession = async (entry: Sent) => {
    const [then, now] = await Promise.all([entry.before, cookies(entry.form.profileId)]);
    return then !== null && now !== null
      ? signInEvidence(then, now, entry.form.url)
      : ("unknown" as const);
  };
  /**
   * A submit's result, by its attempt and the desktop's answer to its own request. Signed in:
   * answered below 400 without refusal, page past every box and loaded, the site's session
   * cookie (`signInEvidence`). Limited: a 429, or the page says so. Refused: the form still there
   * saying the password failed, or back in a new document with no new cookie. Else: nothing.
   */
  const answer = async (entry: Sent) => {
    const tabId = entry.form.tabId;
    const from = URL.parse(entry.form.pageUrl ?? entry.form.url);
    const submitted = from ? `${from.origin}${from.pathname}` : entry.form.url;
    try {
      const finished = await signInFinished(tabId, submitted, async () => {
        const evidence = await newSession(entry);
        // A failed read proves nothing either way: the page is looked at again.
        return evidence === "unknown" ? "none" : evidence;
      });
      const page = await bridge.signInPage?.(tabId).catch(() => null);
      const own = page?.submitted?.documentId === entry.form.documentId ? page.submitted : null;
      if (page?.limited || own?.status === 429) return void (await seen(entry, "limited"));
      if (
        finished === "signed-in" &&
        own &&
        own.status > 0 &&
        own.status < 400 &&
        !own.refusal &&
        !page?.failed
      )
        return void (await seen(entry, "signed-in"));
      if (own && own.status >= 500) return;
      if (own && !own.formGone && own.refusal) return void (await seen(entry, "password-rejected"));
      const still = await bridge.loginForm?.(tabId).catch(() => null);
      if (
        still?.hasPassword &&
        still.url === entry.form.url &&
        still.documentId !== entry.form.documentId &&
        (await newSession(entry)) === "none"
      )
        await seen(entry, "password-rejected");
    } finally {
      if (sent.get(tabId)?.entry === entry) sent.delete(tabId);
    }
  };
  const stopCaptures = bridge.onSignInCaptured((capture) => {
    const typed = typedBy.get(capture.tabId);
    if (!typed || capture.newPassword !== undefined) return;
    typedBy.delete(capture.tabId);
    // Only what Scient typed, for the login it typed it for: same site, password and username.
    if (
      capture.url !== typed.form.url ||
      capture.password !== typed.password ||
      (typed.username !== undefined &&
        loginUserKey(capture.username) !== loginUserKey(typed.username))
    )
      return;
    const { form, accountId, attempt } = typed;
    register({ form, accountId, attempt, before: cookies(form.profileId) });
  });
  // A form reported while a submit waits for its result (a new document, or the same one drawn
  // again) waits too; then it gets the password the result leaves the login holding, for the
  // person to submit: over the refused one only where Scient's typing is still there, untouched.
  const onForm = async (form: DesktopLoginForm) => {
    const waiting = sent.get(form.tabId);
    if (!waiting) return fill(form);
    await waiting.settled;
    const typed = typedIn.get(form.tabId);
    await fill(form, typed?.documentId === form.documentId ? { expected: typed.password } : {});
  };
  const stopForms = bridge.onLoginFormDetected((form) => void onForm(form));
  return () => {
    stopForms();
    stopCaptures();
  };
}
