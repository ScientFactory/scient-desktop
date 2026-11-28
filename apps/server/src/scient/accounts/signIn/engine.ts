// @effect-diagnostics nodeBuiltinImport:off -- Opaque hand-off ids use the operating system CSPRNG.
import {
  AccountsError,
  DEFAULT_BROWSER_PROFILE_ID,
  BACKUP_CODE_ID,
  type AccountHandoff,
  type AccountSummary,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { googleSignInPage } from "@t3tools/shared/scientGoogleSignIn";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { browserFailure, previewInvoker } from "../agent/broker.ts";
import type { KeyDispatch } from "../agent/browserOperations.ts";
import { authorizePreviewProfile, recordProfileUse } from "../agent/previewProfileAccess.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import {
  decideSignIn,
  decideSignInContinuation,
  MAX_SIGN_IN_STEPS,
  pageOffersNoSignIn,
  SIGN_IN_TOO_LONG,
  type SignInSubmission,
} from "./decision.ts";
import {
  SignInDetection,
  SignInStop,
  signInDetectionScript,
  signInStopScript,
  tickRememberScript,
} from "./detection.ts";
import { keepPrivateUntil } from "./keepPrivate.ts";
import type { CodeCandidate } from "./messageCodes.ts";
import { accountOtp, parseTotp } from "./totp.ts";
import {
  signInReturn,
  universityDetails,
  universitySignInLink,
} from "@t3tools/shared/scientPaperLinks";

const decodeDetection = Schema.decodeUnknownEffect(SignInDetection);
const decodeStop = Schema.decodeUnknownEffect(SignInStop);
const REJECTION_SETTLE_CHECKS = 5;
const EMPTY_PAGE_SETTLE_CHECKS = 3;

export interface SignInOptions {
  /** The user's own check: their profile's agent access doesn't apply. */
  readonly userRun?: boolean;
  /** An agent's sign-in: asked right before each fill and submit, so Off or an edit stops it. */
  readonly beforeType?: (origin: string) => Effect.Effect<void, AccountsError>;
  /** The person chose this tab on the account's site: sign in there, though no agent owns it. */
  readonly personTab?: boolean;
  /** An agent's hand-off ends by then, so its card never outlasts the agent's call. */
  readonly handoffMs?: number;
  /**
   * The saved password and 2FA key Scient didn't type, read only when the person presses Use
   * saved on the hand-off: the sign-in then types them and goes on.
   */
  readonly saved?: Effect.Effect<Readonly<Record<string, Redacted.Redacted<string>>>>;
  /** Waits for a code the user types into a private card, on any of their devices. */
  readonly askCode?: (site: string) => Effect.Effect<string, never, never>;
  /** Codes found in the sources the user turned on: one to insert by itself, or some to offer. */
  readonly codes?: {
    /** The person's switch, now: a code found or chosen while it's off doesn't go in. */
    readonly enabled: Effect.Effect<boolean>;
    /** Advances whenever the person changes the switch: a code goes in only under the one it was picked under. */
    readonly version?: Effect.Effect<number>;
    readonly look: (look: {
      readonly since: number;
      readonly requestedAt: number | undefined;
    }) => Effect.Effect<{
      readonly automatic: CodeCandidate | undefined;
      readonly offered: ReadonlyArray<CodeCandidate>;
    }>;
    readonly used: (candidate: CodeCandidate) => Effect.Effect<void>;
  };
  /**
   * The login's attempt budget, asked before an automatic second submission of a password or code
   * in one sign-in. The engine allows one such fallback at most, whatever it answers.
   */
  readonly fallback?: (kind: "password" | "code") => Effect.Effect<boolean>;
  /**
   * Asked right before Scient types a value or submits by itself: why it stops now (the person
   * signed out, renewal was turned off, nobody is there for a code), or nothing.
   */
  readonly stillAllowed?: Effect.Effect<string | undefined>;
  /** The attempt this sign-in belongs to, the same across resumes: it names each code challenge. */
  readonly attemptId?: string;
  /** A code an agent read from its own mail, tried once when the page asks for one. */
  readonly agentCode?: string;
  /** The login's next backup code, taken only when the person taps "Use a backup code". */
  readonly backupCode?: Effect.Effect<Redacted.Redacted<string> | undefined, AccountsError>;
  /**
   * No person is here to answer: at a code, only look for one this long, then stop with the tab
   * kept. Unattended sessions look too. Other steps stop at once, as without it.
   */
  readonly stopAtCode?: boolean;
  readonly codeWaitMs?: number;
  /**
   * The user's own sign-in: a visible tab, and whatever Scient can't do is theirs to finish, for up
   * to `waitMs`. `learnOrigins` collects each page that asked them for something (universities).
   */
  readonly person?: {
    readonly waitMs: number;
    readonly lookGapMs: number;
    readonly learnOrigins: boolean;
  };
  /** Continues a pending attempt in its own tab, from what it already submitted. */
  readonly resume?: {
    readonly submissions: ReadonlyArray<SignInSubmission>;
    readonly submittedAt?: number | undefined;
  };
  /** Why an agent asked the user to sign in, for the card. */
  readonly reason?: string;
  /** Told the attempt's tab as soon as it has one. */
  readonly onTab?: (tabId: PreviewTabId, profileId: string | undefined) => Effect.Effect<void>;
  /** Told each page it looks at: its origin, whether it asked for anything, and for a password. */
  readonly onPage?: (page: {
    readonly origin: string;
    readonly fields: boolean;
    readonly password: boolean;
    readonly captcha: boolean;
    /** The form says it refused the password submitted from it. */
    readonly refused: boolean;
    /** Which page load it is, told apart from the one before. */
    readonly document?: number | undefined;
  }) => void;
  /** Told each origin Scient typed a password into, with the password it typed. */
  readonly onTyped?: (origin: string, password: string) => void;
  /** Told when the saved authenticator key's code goes into a page. */
  readonly onSavedCode?: () => void;
  /**
   * The page asks for a code no saved key answers, or a push: the person's phone gets one
   * (`sent`). Or a code box the saved key may or may not answer, on a row whose key hasn't been
   * seen to sign in alone (`ambiguous`): the key goes in, but it may be a texted box. Told once,
   * before Scient looks for or types the code; false stops the sign-in there.
   */
  readonly onCodeStep?: (kind: "sent" | "ambiguous") => Effect.Effect<boolean>;
  /**
   * Told of every code box in the run, by its page load, challenge and field (`codeBoxId`), as it
   * is seen, before anything is decided: `fits` (the saved key may answer it) or `seen` (it may
   * not); then of what went in once typing worked: `key` (the saved key's code), `chosen` (the
   * same, because the person pressed "Use saved") or `other` (a code from outside).
   */
  readonly onCodeBox?: (box: string, by: CodeBoxMark) => void;
  /**
   * Scient types and submits nothing by itself, the username included, until the person presses
   * "Use saved" in this hand-off: an agent's add while "Renew sign-ins automatically" is off.
   */
  readonly handsOff?: boolean;
  /** Whether the site refused the password the person last submitted in the tab. */
  readonly personRefused?: () => boolean;
}

/** A second factor the person answers; an attempt stopped at one waits for them as it is. */
/** Looks after a submit for a code step, each a load wait and a settle of `POST_SUBMIT_LOOK_MS`. */
/** A key goes in only once two reads this far apart agree, within a few reads. */
const STEADY_GAP_MS = 500;
const STEADY_READS = 4;
const PROMPT_MOVED =
  "The code box changed while Scient was signing in, so it typed nothing there. Finish signing in on the site's page.";
const KEY_SEND_MS = 50_000;
const POST_SUBMIT_LOOKS = 8;
const POST_SUBMIT_LOOK_MS = 500;
const SECOND_FACTORS = new Set(["code", "push", "captcha", "passkey"]);
const AGENT_WAIT = { waitMs: 180_000, lookGapMs: 2_000 };
const CODE_LOOK_GAP_MS = 2_000;
const SITE_LIMITED = "The site is limiting access from this network. Try again later.";

/**
 * What a sign-in saw of a code box, and what went into it: the saved key by itself (`key`), the
 * saved key because the person chose it there (`chosen`), or a code from outside (`other`).
 */
export type CodeBoxMark = "seen" | "fits" | "key" | "chosen" | "other";

/**
 * One code box: its origin, page load and element instance (`otpBox`); the selector only where no
 * instance was read. Changed words or a moved selector are the same box, a replacement a new one.
 */
/**
 * What Scient typed, to clear before the tab goes back to anyone: a code field by its instance in
 * its page load, so a moved field is still found and a replaced one is reported, not assumed clear.
 */
type Typed = {
  readonly origin: string;
  readonly selector: string;
  readonly expected: string;
  readonly instance?: string;
  readonly document?: number;
};

/** The code field as inspected, for its clear later: the same element in that page load. */
const identity = (page: SignInDetection) =>
  page.otpField === undefined || page.document === undefined
    ? {}
    : { instance: page.otpField, document: page.document };

/** The code field as inspected: a fill goes into that very element in that page load, or none. */
const inspected = (page: SignInDetection) =>
  page.otpField === undefined || page.document === undefined
    ? {}
    : {
        instance: page.otpField,
        document: page.document,
        ...(page.otpContainer === undefined ? {} : { container: page.otpContainer }),
      };

const codeBoxId = (page: SignInDetection, selector: string) =>
  [page.origin, page.document ?? "", page.otpBox ?? `selector ${selector}`].join("|");

export const signIn = Effect.fn("AccountsAgent.signIn")(function* (
  session: AccountSessionScope,
  account: AccountSummary,
  secrets: Readonly<Record<string, Redacted.Redacted<string>>>,
  tabId?: PreviewTabId,
  options: SignInOptions = {},
) {
  if (account.details.kind !== "website")
    return yield* new AccountsError({
      reason: "invalid-input",
      message: "Choose a website account to sign in.",
    });
  const details = account.details;
  const university = universityDetails(details);
  const scope = yield* AgentInvocationContext;
  if (!scope.capabilities.has("preview"))
    return yield* new AccountsError({
      reason: "denied",
      message: "Browser access is disabled for this session.",
    });
  const broker = yield* PreviewAutomationBroker;
  const accounts = yield* AccountsService;
  const invoke = previewInvoker(broker, scope, {
    mapError: browserFailure("The browser sign-in could not be completed."),
  });
  // A key's send waits up to half a minute for the site to answer the request it made.
  const invokeSend = previewInvoker(broker, scope, {
    mapError: browserFailure("The browser sign-in could not be completed."),
    timeoutMs: KEY_SEND_MS,
  });
  const status = yield* invoke<PreviewAutomationStatus>("status", {}, tabId);
  const current = status.tabs?.find((tab) => tab.tabId === (tabId ?? status.tabId));
  const onSite = current?.url ? anySiteMatches(details.sites, current.url) : false;
  const sameProfile = details.profileId === undefined || current?.profileId === details.profileId;
  // The agent's own tab is used when it is on the account's site (in any profile: the password
  // works anywhere) or in the account's profile, where it is sent to the site. A new tab opens the
  // sign-in page, this page, or the account's first site.
  const reuse =
    options.resume !== undefined ||
    (options.personTab === true && tabId !== undefined && onSite) ||
    (current?.ownedByCaller === true && (sameProfile || (tabId !== undefined && onSite)));
  const firstSite = details.sites[0];
  const siteUrl =
    firstSite && (firstSite.startsWith("https://") ? firstSite : `https://${firstSite}`);
  // A tab already on the site stays put: a saved address may be a step of an old sign-in, and the
  // page may already be the one to use.
  const destination =
    options.resume || (reuse && onSite)
      ? undefined
      : university
        ? universitySignInLink(university)
        : (details.loginUrl ?? (onSite ? current?.url : siteUrl));
  const otherAddresses = (university ? [] : [...new Set([details.loginUrl, siteUrl])]).filter(
    (url): url is string => url !== undefined && url !== destination,
  );
  const openInput = {
    ...(destination ? { url: destination } : {}),
    ...(details.profileId === undefined ? {} : { profileId: details.profileId }),
    reuseExistingTab: reuse,
    ...(reuse && current ? { tabId: current.tabId } : {}),
    open: options.person !== undefined,
  };
  if (details.loginUrl && !anySiteMatches(details.sites, details.loginUrl))
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
  // A reused tab keeps its profile. A new one opens in the row's: a university's lives in its own
  // profile, where its check then looks, whatever tab the person was on.
  const ownProfile = university
    ? (details.profileId ?? DEFAULT_BROWSER_PROFILE_ID)
    : (details.profileId ?? current?.profileId);
  const opened = options.userRun
    ? yield* open(reuse ? (current?.profileId ?? details.profileId) : ownProfile)
    : yield* authorizePreviewProfile(session, status, openInput).pipe(
        Effect.flatMap(({ profileId }) =>
          accounts.admitProfileTab(
            profileId,
            session.threadId,
            recordProfileUse(session, profileId, open(profileId)),
          ),
        ),
      );
  if (!opened.tabId)
    return yield* new AccountsError({
      reason: "unavailable",
      message: "No browser tab is available for sign-in.",
    });
  const target = opened.tabId;
  if (options.onTab)
    yield* options.onTab(target, opened.tabs?.find((tab) => tab.tabId === target)?.profileId);
  let password = secrets.password === undefined ? undefined : Redacted.value(secrets.password);
  let totp = secrets.totp === undefined ? undefined : Redacted.value(secrets.totp);
  const offersSaved =
    options.saved !== undefined && password === undefined && account.secrets.password !== undefined;
  let codeStep: "none" | "sent" | "ambiguous" | "told" = "none";
  /** Tells `onCodeStep` once, after the decision that first saw the step. */
  const tellCodeStep = Effect.suspend(() => {
    if (codeStep === "none" || codeStep === "told" || options.onCodeStep === undefined)
      return Effect.succeed(true);
    const kind = codeStep;
    codeStep = "told";
    return options.onCodeStep(kind);
  });
  /** The person pressed "Use saved" in this sign-in: what they chose may go in. */
  let savedByPerson = false;
  /**
   * The code box on screen when they pressed it, if any: the saved key may go there, and only
   * there. A choice made at the password never lets the key into a later code box.
   */
  let chosenBox: string | undefined;
  /** The card's Use saved revision and the code box it shows ("" for none). */
  let savedRevision: { readonly id: string; readonly box: string } | undefined;
  let revisions = 0;
  const shownBox = (page: SignInDetection) => (page.otp === null ? "" : codeBoxId(page, page.otp));
  const chosenHere = (page: SignInDetection, selector = page.otp) =>
    chosenBox !== undefined && selector !== null && codeBoxId(page, selector) === chosenBox;
  const untold = {
    outcome: "failed" as const,
    message: "Scient couldn't tell you a code was coming, so it stopped signing in.",
  };
  /** A saved key is evidence for a plain box, unless the login signs in only when the person asks. */
  const keyIsEvidence = !(
    account.details.kind === "website" && account.details.oneSession === true
  );
  /** A delivered code's cue on any page of this run; a resumed run can't see its earlier pages. */
  let cueSeen = options.resume !== undefined;
  /**
   * The key goes in on an authenticator's instructions, into a code challenge's one plain box while
   * the run saw no cue, or into the box the person pressed "Use saved" at; never past the veto
   * (`otpDelivery`, `otpSent`), even by the person's choice. Elsewhere the box is handed off.
   */
  const keyFitsFor = (page: SignInDetection) =>
    totp !== undefined &&
    page.otpNoForm !== true &&
    page.otpNoSubmit !== true &&
    page.otpUnusable !== true &&
    page.otpSent === undefined &&
    page.otpDelivery !== true &&
    (chosenHere(page) ||
      page.otpApp === true ||
      (keyIsEvidence &&
        !cueSeen &&
        page.otpOnly === true &&
        (page.otpContext === true || passwordSent())));
  /** The run sent the password: told to the page's own checks of a plain box too. */
  const passwordSent = () => submissions.some(({ fields }) => fields.includes("password"));
  /** How the key's code goes in, checked again in the page: the person's, by its words, or plain. */
  const keyMode = (page: SignInDetection, selector: string) =>
    chosenHere(page, selector) ? "explicit" : page.otpApp === true ? "automatic" : "generic";
  /** The same code box, in the same container and page load, that the key may still answer. */
  const samePrompt = (before: SignInDetection, after: SignInDetection) =>
    after.otp !== null &&
    after.origin === before.origin &&
    after.document === before.document &&
    after.otpField === before.otpField &&
    after.otpContainer === before.otpContainer &&
    keyFitsFor(after) &&
    chosenHere(after) === chosenHere(before);
  /** Every code box read, before anything is decided on it. */
  const observe = (page: SignInDetection) => {
    if (page.codeCue === true) cueSeen = true;
    if (page.otp !== null)
      options.onCodeBox?.(codeBoxId(page, page.otp), keyFitsFor(page) ? "fits" : "seen");
    return page;
  };
  const decide = (page: SignInDetection) => {
    const sentCode = page.otp !== null && page.otpSent !== undefined;
    const keyFits = keyFitsFor(page);
    if (
      codeStep === "none" &&
      (page.challenge === "push" || (page.otp !== null && (totp === undefined || sentCode)))
    )
      codeStep = "sent";
    else if (codeStep === "none" && page.otp !== null && !keyFits) codeStep = "ambiguous";
    observe(page);
    if (university && signInReturn(page.url ?? page.origin)) return { type: "signed-in" } as const;
    const decision = decideSignIn(page, details.sites, {
      username: details.username !== undefined,
      password: password !== undefined,
      otp: keyFits,
      ...(details.username === undefined ? {} : { accountName: details.username }),
      passwordSent: submissions.some(({ fields }) => fields.includes("password")),
    });
    // Hands off: nothing goes in or out, the username included, until the person acts here.
    if (options.handsOff === true && !savedByPerson && decision.type === "fill")
      return {
        type: "needs-user" as const,
        kind: "other" as const,
        message: "Finish signing in on the site's page.",
      };
    // The person finishes what Scient can't: a university's own sign-in, which Scient learns from
    // their first one, or a sign-in the user started themselves. A page that didn't load, as when
    // Google drops the connection, waits for them too, so the Chrome window can bring them back.
    // A site limiting sign-ins is the person's to finish by hand; Scient submits nothing more.
    return (university || options.person) &&
      decision.type === "needs-user" &&
      decision.kind === undefined &&
      (!page.broken || (university !== undefined && options.person !== undefined)) &&
      (!page.limited || options.person !== undefined)
      ? {
          ...decision,
          kind: "other" as const,
          message: page.limited
            ? "The site is limiting sign-ins. Finish signing in on its page."
            : university
              ? "Finish signing in on your university's page."
              : "Finish signing in on the site's page.",
        }
      : decision;
  };
  // Only the last submission's fields: earlier pages are gone, and after a hand-off the user
  // continues with what is on screen.
  let filled: Array<Typed> = [];
  const submissions: SignInSubmission[] = [...(options.resume?.submissions ?? [])];
  // A code sent in reply to a submit can arrive before the page shows it asks for one.
  let submittedAt: number | undefined = options.resume?.submittedAt;
  // Only a submit that sent something asks a site for a code; a link or "stay signed in" doesn't.
  let requestedAt: number | undefined = options.resume?.submittedAt;
  /** Codes Scient typed: cleared before the tab goes back to anyone, unless the sign-in worked. */
  const typedCodes: Array<Typed> = [];
  let signedInAtEnd = false;
  /** The code field of the last challenge seen: a new one makes earlier messages someone else's. */
  let lastChallenge: string | undefined;
  let agentCode = options.agentCode;
  const attemptKey = options.attemptId ?? NodeCrypto.randomUUID();
  const switchVersion = options.codes?.version ?? Effect.succeed(0);
  let fallbackSpent = false;
  /**
   * One submission of a password and one of a code per sign-in; a second of either, sent by Scient
   * rather than chosen by the person, is the sign-in's one fallback, if the login's budget allows.
   */
  const mayResubmit = Effect.fn("accounts.signIn.mayResubmit")(function* (
    kind: "password" | "code",
  ) {
    const field = kind === "password" ? "password" : "otp";
    if (!submissions.some(({ fields }) => fields.includes(field))) return true;
    if (kind === "code" && submissions.some(({ unanswered }) => unanswered)) return false;
    if (fallbackSpent) return false;
    if (options.fallback && !(yield* options.fallback(kind))) return false;
    fallbackSpent = true;
    return true;
  });
  const learned = new Set<string>();
  const patience = options.person ?? {
    ...AGENT_WAIT,
    waitMs: Math.min(AGENT_WAIT.waitMs, Math.max(options.handoffMs ?? AGENT_WAIT.waitMs, 0)),
  };
  /** A code the site may still have: the tab is left as it is, its attempt kept for the person. */
  const leftWithSite = () => ({
    outcome: "needs-user" as const,
    message: "Finish signing in on the site's page.",
    tabId: target,
    pending: { submissions: [...submissions], submittedAt, code: false, factor: undefined },
  });
  /**
   * Kept as the site's pending attempt: stopped at a second factor, with what it submitted and
   * which factor, so the person is told the step.
   */
  const pendingAt = (kind: AccountHandoff["kind"] | undefined, via: SignInDetection["via"]) =>
    kind !== undefined && SECOND_FACTORS.has(kind)
      ? {
          pending: {
            submissions: [...submissions],
            submittedAt,
            code: kind === "code",
            factor: { kind, ...(via === undefined ? {} : { via }) },
          },
        }
      : {};
  // Cleared unless the sign-in succeeded or the user takes over, including on interruption.
  let clearFilled = true;
  let cleanupFailed = false;
  let codeHeld = false;
  /** Empties each field that still holds what Scient typed; returns those it couldn't. */
  const clearTyped = Effect.fn("accounts.signIn.clearTyped")(function* (
    fields: ReadonlyArray<Typed>,
  ) {
    const left: Typed[] = [];
    for (const field of fields)
      if (
        !(yield* invoke("accountType", { ...field, text: "", clear: true }, target).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ))
      )
        left.push(field);
    return left;
  });
  const run = Effect.gen(function* () {
    const inspect = Effect.fn("accounts.signIn.inspect")(function* (step: number) {
      const detected = yield* invoke<unknown>(
        "evaluate",
        { expression: signInDetectionScript, world: "accounts" },
        target,
      );
      const page = observe(
        yield* decodeDetection(detected).pipe(
          Effect.mapError(
            () =>
              new AccountsError({
                reason: "unavailable",
                message: "The sign-in page could not be inspected.",
              }),
          ),
        ),
      );
      const timestamp = yield* Clock.currentTimeMillis;
      const fields = Boolean(page.username || page.password || page.otp);
      if (options.person?.learnOrigins && page.origin.startsWith("https://") && fields)
        learned.add(page.origin);
      options.onPage?.({
        origin: page.origin,
        fields,
        password: Boolean(page.password),
        captcha: page.challenge === "captcha",
        refused: page.refused === true,
        document: page.document,
      });
      const otpSecret = totp;
      const otpPeriod =
        !page.otp || otpSecret === undefined || /^\d{6,8}$/.test(otpSecret)
          ? undefined
          : yield* Effect.try({
              try: () => Math.floor(timestamp / (parseTotp(otpSecret).period * 1000)),
              catch: () =>
                new AccountsError({
                  reason: "invalid-input",
                  message: "The account's two-factor setup is invalid.",
                }),
            });
      const continuation = decideSignInContinuation(page, submissions, step, otpPeriod);
      return { page, timestamp, otpPeriod, continuation };
    });
    /** Reads the prompt until two reads half a second apart agree, a few times at most. */
    /**
     * Reads the admitted prompt (its origin and page load pinned) until two reads in a row, half a
     * second apart, find it still eligible; a few reads at most. Another page load, or another
     * origin, ends it: a replacement document never inherits the action.
     */
    const steadyPrompt = Effect.fn("accounts.signIn.steadyPrompt")(function* (
      admitted: SignInDetection,
    ) {
      let eligible = 0;
      for (let read = 0; read < STEADY_READS; read++) {
        yield* invoke("accountWaitForLoad", { settleMs: STEADY_GAP_MS }, target).pipe(
          Effect.ignore,
        );
        const next = yield* inspect(-1).pipe(Effect.option);
        if (Option.isNone(next)) {
          eligible = 0;
          continue;
        }
        if (
          next.value.page.origin !== admitted.origin ||
          next.value.page.document !== admitted.document
        )
          return undefined;
        eligible = samePrompt(admitted, next.value.page) ? eligible + 1 : 0;
        if (eligible >= 2) return next.value;
      }
      return undefined;
    });
    /** Looked at right before a submit: a limit or a check means nothing more is sent. */
    const lookBeforeSubmit = invoke<unknown>(
      "evaluate",
      { expression: signInStopScript },
      target,
    ).pipe(
      Effect.flatMap(decodeStop),
      Effect.map((seen) => seen.limited === true || seen.captcha === true),
    );
    /** Why `stillAllowed` stopped the last submit. */
    let stopReason: string | undefined;
    // A page that can't be read right then gets one more look after it loads; still unreadable,
    // nothing is sent. A sign-out since the sign-in began stops it here too.
    const stopBeforeSubmit = Effect.gen(function* () {
      if (!options.person && options.stillAllowed) {
        stopReason = yield* options.stillAllowed;
        if (stopReason !== undefined) return true;
      }
      return yield* lookBeforeSubmit.pipe(
        Effect.catch(() =>
          invoke("accountWaitForLoad", { settleMs: 1000 }, target).pipe(
            Effect.andThen(lookBeforeSubmit),
          ),
        ),
        Effect.orElseSucceed(() => true),
      );
    });
    for (let step = 0; step <= MAX_SIGN_IN_STEPS; step++) {
      let { page, timestamp, otpPeriod, continuation } = yield* inspect(step);
      // Script-submitted logins answer after "load"; a field still on screen is only a
      // rejection once the page has had a few seconds to respond.
      for (
        let wait = 0;
        wait < REJECTION_SETTLE_CHECKS &&
        (continuation.type === "password-rejected" || continuation.type === "code-rejected") &&
        !page.signedIn &&
        !page.limited;
        wait++
      ) {
        yield* invoke("accountWaitForLoad", { settleMs: 1000 }, target);
        ({ page, timestamp, otpPeriod, continuation } = yield* inspect(step));
      }
      // Sites like Google change step without a page load, so an empty page may not have drawn yet.
      for (
        let wait = 0;
        wait < EMPTY_PAGE_SETTLE_CHECKS && !page.broken && pageOffersNoSignIn(page, details.sites);
        wait++
      ) {
        yield* invoke("accountWaitForLoad", { settleMs: 1000 }, target);
        ({ page, timestamp, otpPeriod, continuation } = yield* inspect(step));
      }
      // A limit is decided first: a form still showing after a 429 says nothing about the password.
      if (page.limited && !page.signedIn && !options.person)
        return { outcome: "limited" as const, message: SITE_LIMITED, tabId: target };
      if (continuation.type !== "continue" && !page.signedIn && !page.limited)
        return {
          outcome:
            continuation.type === "code-rejected" && !continuation.saved
              ? ("failed" as const)
              : continuation.type,
          message: continuation.message,
          tabId: target,
        };
      // A university sends a signed-in reader on to the publisher, which is none of its sites.
      if (
        university &&
        submissions.some(({ fields }) => fields.includes("password")) &&
        !anySiteMatches(details.sites, page.origin) &&
        !page.broken &&
        !page.limited &&
        !page.challenge &&
        !page.username &&
        !page.password &&
        !page.otp
      ) {
        clearFilled = false;
        return { outcome: "signed-in" as const, tabId: target };
      }
      // After a submission, an empty page is that sign-in's next step, not a dead address.
      const nextAddress =
        submissions.length === 0 && pageOffersNoSignIn(page, details.sites)
          ? otherAddresses.shift()
          : undefined;
      if (nextAddress !== undefined) {
        yield* invoke(
          "open",
          { url: nextAddress, reuseExistingTab: true, tabId: target, open: false },
          target,
        );
        yield* invoke("accountWaitForLoad", {}, target);
        continue;
      }
      let action = decide(page);
      if (!(yield* tellCodeStep)) return { ...untold, tabId: target };
      // Google refuses sign-ins it didn't see a person make; with nobody here, it's theirs.
      if (
        action.type === "fill" &&
        (session.unattended || options.stopAtCode === true) &&
        googleSignInPage(page.url ?? page.origin) !== null
      )
        return {
          outcome: "needs-user" as const,
          message: "Google's sign-in needs you.",
          tabId: target,
        };
      if (action.type === "signed-in" || action.type === "needs-user") clearFilled = false;
      if (action.type === "signed-in") return { outcome: "signed-in" as const, tabId: target };
      if (action.type === "needs-user") {
        // During a limit only the person's own sign-in goes on, by hand: Scient submits nothing.
        if (page.limited && !options.person)
          return { outcome: "limited" as const, message: action.message, tabId: target };
        const nobodyHere = session.unattended || options.stopAtCode === true;
        // With nobody to answer, a code is still looked for in the sources, and offered for Insert;
        // a phone approval is still watched for, so the sign-in goes on once the person taps it.
        const lookOnly = nobodyHere && action.kind === "code" && options.codes !== undefined;
        const watchPush = nobodyHere && action.kind === "push";
        if (action.kind === undefined || (session.unattended && !lookOnly && !watchPush))
          return {
            outcome: "needs-user" as const,
            message: action.message,
            tabId: target,
            ...pendingAt(action.kind, page.via),
          };
        if (options.stopAtCode && action.kind === "code" && !lookOnly)
          return {
            outcome: "needs-user" as const,
            message: "It needs a code.",
            tabId: target,
            ...pendingAt(action.kind, page.via),
          };
        const waitFor = lookOnly
          ? { waitMs: options.codeWaitMs ?? AGENT_WAIT.waitMs, lookGapMs: CODE_LOOK_GAP_MS }
          : patience;
        const handoffId = NodeCrypto.randomUUID();
        const startedAt = timestamp;
        // The code belongs to the page that asked for it, not to wherever the tab is by now.
        let codeOrigin: string | undefined;
        let codeField: string | null = null;
        const codeNeeded = yield* Deferred.make<void>();
        const noteCodeNeeded = Effect.suspend(() => {
          if (action.type !== "needs-user" || action.kind !== "code") return Effect.void;
          codeOrigin ??= page.origin;
          if (codeField === null) {
            codeField = page.otp;
            const challenge = `${page.origin}|${page.otp ?? ""}`;
            if (
              requestedAt !== undefined &&
              lastChallenge !== undefined &&
              lastChallenge !== challenge
            )
              requestedAt = Math.max(requestedAt, startedAt);
            lastChallenge = challenge;
          }
          return Deferred.succeed(codeNeeded, undefined).pipe(Effect.asVoid);
        });
        /** Why the agent's use of the account was refused at the moment a code would go in. */
        let refusal: AccountsError | undefined;
        const useAllowed = (origin: string) =>
          options.beforeType
            ? options.beforeType(origin).pipe(
                Effect.as(true),
                Effect.catch((error) =>
                  Effect.sync(() => {
                    refusal = error;
                    return false;
                  }),
                ),
              )
            : Effect.succeed(true);
        /** This step's challenge: the attempt, the page and its code field, across resumes. */
        const challengeId = () => `${attemptKey}|${codeOrigin ?? ""}|${codeField ?? ""}`;
        /**
         * `found`: Scient's own (a source's or an agent's), one per challenge and only with the
         * hand-off's claim; otherwise the person's. `fromSources`: it obeys the switch.
         */
        const enterCode = Effect.fn("accounts.signIn.enterCode")(function* (
          code: string,
          found = false,
          /** A source's code: the switch as it was when the code was picked. */
          pickedUnder?: number,
        ) {
          const fromSources = pickedUnder !== undefined;
          /** On, and not changed since the code was picked. */
          const switchHolds = Effect.gen(function* () {
            if (!fromSources || !options.codes) return true;
            return (yield* options.codes.enabled) && (yield* switchVersion) === pickedUnder;
          });
          const field = yield* inspect(step);
          // Only into the challenge it was found or chosen for; a limit or a check that appeared
          // meanwhile stops it before anything is sent.
          if (
            !field.page.otp ||
            field.page.origin !== codeOrigin ||
            field.page.otp !== codeField ||
            field.page.limited ||
            field.page.challenge
          ) {
            ({ page, timestamp } = field);
            return "continue" as const;
          }
          if (
            found &&
            (submissions.some((entry) => entry.found && entry.challenge === challengeId()) ||
              !(yield* mayResubmit("code")) ||
              (options.stillAllowed !== undefined && (yield* options.stillAllowed) !== undefined) ||
              // The person's click and Scient's own code claim the hand-off; the first wins.
              !(yield* accounts.claimHandoffCode(handoffId)))
          ) {
            ({ page, timestamp } = field);
            return "spent" as const;
          }
          // The switch, read right before the code goes in: changed since the pick means it doesn't.
          if (!(yield* switchHolds)) {
            ({ page, timestamp } = field);
            return "spent" as const;
          }
          // Whoever gave the code, the account it signs in to is still checked for the agent.
          if (!(yield* useAllowed(codeOrigin))) {
            ({ page, timestamp } = field);
            return "refused" as const;
          }
          yield* invoke(
            "accountType",
            {
              origin: codeOrigin,
              selector: field.page.otp,
              text: code,
              clear: true,
              secret: true,
              ...inspected(field.page),
            },
            target,
          );
          options.onCodeBox?.(codeBoxId(field.page, field.page.otp), "other");
          typedCodes.push({
            origin: codeOrigin,
            selector: field.page.otp,
            expected: code,
            ...identity(field.page),
          });
          submissions.push({
            origin: field.page.origin,
            fields: ["otp"],
            otpPeriod: undefined,
            ...(found ? { found: true as const, challenge: challengeId() } : {}),
          });
          if (yield* stopBeforeSubmit) {
            ({ page, timestamp } = yield* inspect(step));
            return "continue" as const;
          }
          // And again right before the submit: switched off or refused meanwhile, the code is
          // cleared unsent.
          const holds = yield* switchHolds;
          if (!holds || !(yield* useAllowed(codeOrigin))) {
            yield* invoke(
              "accountType",
              {
                origin: codeOrigin,
                selector: field.page.otp,
                text: "",
                clear: true,
                expected: code,
                ...identity(field.page),
              },
              target,
            ).pipe(Effect.ignore);
            ({ page, timestamp } = yield* inspect(step));
            return holds ? ("refused" as const) : ("spent" as const);
          }
          if (field.page.submit) yield* invoke("click", { selector: field.page.submit }, target);
          else yield* invoke("press", { key: "Enter" }, target);
          yield* invoke("accountWaitForLoad", { settleMs: 1000 }, target);
          ({ page, timestamp } = yield* inspect(step));
          return "continue" as const;
        });
        // A push or CAPTCHA can turn into a code partway, so the card waits until one is needed.
        const answered =
          options.askCode && !lookOnly
            ? Deferred.await(codeNeeded).pipe(
                Effect.andThen(
                  Effect.suspend(() => options.askCode!(new URL(codeOrigin ?? page.origin).host)),
                ),
                Effect.flatMap((code) => enterCode(code)),
              )
            : Effect.never;
        /** The codes offered for Insert, by the id the person's click sends; digits stay here. */
        let offered = new Map<string, CodeCandidate>();
        const codeIds = new Map<string, string>();
        /** The offer the person's click claimed, read once from the hand-off, and the switch then. */
        let claimedId: string | undefined;
        let claimedUnder: number | undefined;
        const readClaim = Effect.gen(function* () {
          if (claimedId !== undefined) return;
          const before = yield* switchVersion;
          claimedId = yield* accounts.chosenHandoffCode(handoffId);
          if (claimedId !== undefined) claimedUnder = before;
        });
        const wait = Effect.gen(function* () {
          let published = "";
          const update = Effect.fn("accounts.signIn.updateHandoff")(function* () {
            if (action.type !== "needs-user" || action.kind === undefined) return;
            const site = new URL(page.origin).host;
            const number =
              action.kind === "push" && page.number && /^\d{1,3}$/.test(page.number)
                ? page.number
                : undefined;
            const codes = [...offered].map(([codeId, candidate]) => ({
              codeId,
              source: candidate.source,
              at: DateTime.formatIso(DateTime.makeUnsafe(candidate.at)),
              // Not this service's by name: who sent it is how the person tells.
              ...(candidate.named !== undefined && candidate.sender
                ? { from: candidate.sender.slice(0, 120) }
                : {}),
            }));
            // What the site said to the last password tried here, so the card says it, not the step.
            const refused =
              continuation.type === "password-rejected" ||
              page.refused === true ||
              options.personRefused?.() === true;
            const notLoaded = "notLoaded" in action && action.notLoaded;
            // A new box on screen is a new card revision: a click on the old one counts for nothing.
            const offering = offersSaved && password === undefined;
            if (offering && savedRevision?.box !== shownBox(page))
              savedRevision = { id: `r${++revisions}`, box: shownBox(page) };
            const via =
              (action.kind === "passkey" && page.via === "security-key") ||
              (action.kind === "code" && page.via === "text")
                ? page.via
                : undefined;
            const signature = `${action.kind}|${"choose" in action ? action.choose : ""}|${notLoaded}|${site}|${number ?? ""}|${via ?? ""}|${[...offered.keys()].join(",")}|${refused}|${offering ? savedRevision?.id : ""}`;
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
                ...(via === undefined ? {} : { via }),
                ...(options.reason === undefined ? {} : { reason: options.reason }),
                ...(codes.length ? { codes } : {}),
                ...(action.kind === "code" &&
                options.backupCode &&
                (account.secrets["recovery"]?.left ?? 0) > 0
                  ? { backupCodes: true as const }
                  : {}),
                ...(offering && savedRevision
                  ? { useSaved: details.username ?? "", useSavedRevision: savedRevision.id }
                  : {}),
                ...(refused ? { refused: "password" as const } : {}),
                ...("choose" in action ? { choose: action.choose } : {}),
                ...(notLoaded ? { notLoaded: true as const } : {}),
                startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
                expiresAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt + waitFor.waitMs)),
              },
              invoke("open", { tabId: target, reuseExistingTab: true, open: true }, target).pipe(
                Effect.asVoid,
              ),
            );
            published = signature;
          });
          // The card shows this tab live in the conversation; "Open browser" reveals it elsewhere.
          yield* update();
          yield* noteCodeNeeded;
          for (let poll = 0; poll < waitFor.waitMs / waitFor.lookGapMs; poll++) {
            if (yield* accounts.handoffCancelled(handoffId)) return "cancelled" as const;
            // Only while the card offers it, read once, and only for the card revision on screen
            // whose box is still the one shown: a click on a replaced card or box counts for nothing.
            const pressed =
              offersSaved && password === undefined && options.saved
                ? yield* accounts.savedRequested(handoffId)
                : undefined;
            const bound =
              pressed !== undefined &&
              pressed === savedRevision?.id &&
              savedRevision.box === shownBox(page)
                ? savedRevision
                : undefined;
            if (bound && options.saved) {
              const saved = yield* options.saved;
              savedByPerson = true;
              if (bound.box !== "") chosenBox = bound.box;
              password = saved.password === undefined ? undefined : Redacted.value(saved.password);
              totp = saved.totp === undefined ? undefined : Redacted.value(saved.totp);
              if (password !== undefined) return "continue" as const;
            }
            // The user's actions navigate the page; a look that fails mid-navigation is retried.
            const looked = yield* invoke(
              "accountWaitForLoad",
              { settleMs: waitFor.lookGapMs },
              target,
            ).pipe(Effect.andThen(inspect(step)), Effect.option);
            if (yield* accounts.handoffCancelled(handoffId)) return "cancelled" as const;
            if (looked._tag === "None") continue;
            ({ page, timestamp, otpPeriod, continuation } = looked.value);
            action = decide(page);
            if (!(yield* tellCodeStep)) return "untold" as const;
            if (action.type !== "needs-user" || action.kind === undefined)
              return "continue" as const;
            // The person's click comes first, and counts until the wait's own deadline.
            yield* readClaim;
            const chosen = claimedId === undefined ? undefined : offered.get(claimedId);
            if (action.kind === "code" && chosen && options.codes && claimedUnder !== undefined) {
              const entered = yield* enterCode(chosen.code, false, claimedUnder);
              if (entered === "refused") return entered;
              if (entered !== "spent") {
                yield* options.codes.used(chosen);
                return entered;
              }
            }
            // The person's tap on "Use a backup code": the next one goes in, taken off the list.
            if (action.kind === "code" && claimedId === BACKUP_CODE_ID && options.backupCode) {
              claimedId = undefined;
              const code = yield* options.backupCode;
              if (code !== undefined) {
                const entered = yield* enterCode(Redacted.value(code));
                if (entered !== "spent") return entered;
              }
            }
            if (timestamp - startedAt >= waitFor.waitMs) break;
            if (action.kind === "code" && agentCode !== undefined) {
              const code = agentCode;
              agentCode = undefined;
              const entered = yield* enterCode(code, true);
              if (entered !== "spent") return entered;
            }
            // Offers are always kept current; only Scient's own entry waits on the rules above.
            if (action.kind === "code" && options.codes) {
              const sources = options.codes;
              const lookedUnder = yield* switchVersion;
              const look = yield* sources.look({
                since: Math.min(startedAt, submittedAt ?? startedAt),
                requestedAt,
              });
              const previous = offered;
              offered = new Map(
                look.offered.map((candidate) => {
                  const codeId = codeIds.get(candidate.key) ?? NodeCrypto.randomUUID();
                  codeIds.set(candidate.key, codeId);
                  return [codeId, candidate];
                }),
              );
              // A claimed offer stays bound to its code: a click that won is never dropped.
              yield* readClaim;
              const claimed = claimedId === undefined ? undefined : previous.get(claimedId);
              if (claimedId !== undefined && claimed && !offered.has(claimedId))
                offered.set(claimedId, claimed);
              if (look.automatic) {
                const entered = yield* enterCode(look.automatic.code, true, lookedUnder);
                if (entered === "refused") return entered;
                if (entered !== "spent") {
                  yield* sources.used(look.automatic);
                  return entered;
                }
              }
            }
            yield* update();
            yield* noteCodeNeeded;
          }
          return "timeout" as const;
        });
        const result = yield* Effect.raceFirst(wait, answered).pipe(
          Effect.ensuring(accounts.removeHandoff(handoffId)),
        );
        // Nobody was here to finish: the tab waits at its step for the person, as before the wait,
        // at the step the page shows now: a push may have turned into a code while it waited.
        if (result === "timeout" && (lookOnly || watchPush)) {
          const now = action.type === "needs-user" ? action : undefined;
          return {
            outcome: "needs-user" as const,
            message: now?.kind === "code" ? "It needs a code." : (now?.message ?? "It needs you."),
            tabId: target,
            ...pendingAt(now?.kind, page.via),
          };
        }
        if (result === "untold") return { ...untold, tabId: target };
        if (result === "refused")
          return { outcome: "failed" as const, message: refusal!.message, tabId: target };
        if (result !== "continue")
          return {
            outcome: "needs-user" as const,
            message:
              result === "cancelled"
                ? "The user cancelled the sign-in."
                : `The user did not finish signing in within ${Math.round(waitFor.waitMs / 60_000)} minutes.`,
            ended: result === "cancelled" ? ("cancelled" as const) : ("timed-out" as const),
            tabId: target,
          };
        // A code belongs to the page that asked for it; another site asking gets the user.
        if (page.otp && codeOrigin !== undefined && page.origin !== codeOrigin)
          return { outcome: "needs-user" as const, message: action.message, tabId: target };
        if (decide(page).type === "signed-in") {
          clearFilled = false;
          return { outcome: "signed-in" as const, tabId: target };
        }
        // Back to the top: it waits for a slow answer, and catches a limit or a refusal.
        yield* invoke("accountWaitForLoad", { settleMs: 1000 }, target);
        continue;
      }
      const typesSecret = action.fields.some(({ field }) => field !== "username");
      /** Why Scient may no longer send by itself, asked at the last moment before each send. */
      const stopNow =
        !options.person && options.stillAllowed ? options.stillAllowed : Effect.undefined;
      const stopped = typesSecret ? yield* stopNow : undefined;
      if (stopped !== undefined)
        return { outcome: "needs-user" as const, message: stopped, tabId: target };
      if (
        (action.fields.some(({ field }) => field === "password") &&
          !(yield* mayResubmit("password"))) ||
        (action.fields.some(({ field }) => field === "otp") && !(yield* mayResubmit("code")))
      )
        return submissions.some(({ unanswered }) => unanswered)
          ? leftWithSite()
          : {
              outcome: "needs-user" as const,
              message: "Scient already sent the saved password once in this sign-in.",
              tabId: target,
            };
      // The key goes into the admitted prompt only once it reads the same twice, at least half
      // a second apart, and the action is decided again from that read.
      const decided = action.fields;
      let keyField = decided.find(({ field }) => field === "otp");
      if (keyField) {
        const steady = yield* steadyPrompt(page);
        const again = steady === undefined ? undefined : decide(steady.page);
        keyField =
          again?.type === "fill" ? again.fields.find(({ field }) => field === "otp") : undefined;
        if (steady === undefined || again?.type !== "fill" || keyField === undefined)
          return {
            outcome: "needs-user" as const,
            message: PROMPT_MOVED,
            tabId: target,
          };
        // A field the action gained on the second look answers to the same budget: a resumed
        // attempt types a second password only through its gate.
        const gained = again.fields.filter(
          ({ field }) => !decided.some((before) => before.field === field),
        );
        if (
          (gained.some(({ field }) => field === "password") && !(yield* mayResubmit("password"))) ||
          (gained.some(({ field }) => field === "otp") && !(yield* mayResubmit("code")))
        )
          return submissions.some(({ unanswered }) => unanswered)
            ? leftWithSite()
            : {
                outcome: "needs-user" as const,
                message: "Scient already sent the saved password once in this sign-in.",
                tabId: target,
              };
        ({ page, timestamp } = steady);
        action = again;
      }
      // Authorized for the origin the values go into, after every wait above.
      const refused = options.beforeType
        ? yield* options.beforeType(page.origin).pipe(Effect.flip, Effect.option)
        : Option.none();
      if (Option.isSome(refused))
        return { outcome: "failed" as const, message: refused.value.message, tabId: target };
      clearFilled = true;
      filled = [];
      // A password sent by an earlier step, never one going with this step's own fields.
      const sentBefore = passwordSent();
      for (const field of action.fields) {
        // After the authorization wait above, and before each value goes in.
        const halted = field.field === "username" ? undefined : yield* stopNow;
        if (halted !== undefined)
          return { outcome: "needs-user" as const, message: halted, tabId: target };
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
        filled.push({
          origin: page.origin,
          selector: field.selector,
          expected: text,
          ...(field.field === "otp" ? identity(page) : {}),
        });
        yield* invoke(
          "accountType",
          {
            origin: page.origin,
            selector: field.selector,
            text,
            clear: true,
            ...(field.field === "username" ? {} : { secret: true }),
            ...(field.field === "otp"
              ? {
                  ...inspected(page),
                  mode: keyMode(page, field.selector),
                  ...(sentBefore ? { passwordSent: true } : {}),
                }
              : {}),
          },
          target,
        );
        // Only once it is in.
        if (field.field === "otp") {
          options.onSavedCode?.();
          options.onCodeBox?.(
            codeBoxId(page, field.selector),
            chosenHere(page, field.selector) ? "chosen" : "key",
          );
        }
      }
      // Keeps the session and skips codes next time; never worth failing a sign-in over.
      if (page.remember)
        yield* invoke("evaluate", { expression: tickRememberScript(page.remember) }, target).pipe(
          Effect.ignore,
        );
      // A limit or a check that appeared while typing stops it; what was typed is cleared.
      if (yield* stopBeforeSubmit)
        return {
          outcome: "needs-user" as const,
          message: stopReason ?? "The site asks for a check or is limiting sign-ins.",
          tabId: target,
        };
      submissions.push({
        origin: page.origin,
        fields: action.fields.map(({ field }) => field),
        otpPeriod,
        ...(action.fields.some(({ field }) => field === "otp") ? { saved: true as const } : {}),
      });
      if (password && action.fields.some(({ field }) => field === "password"))
        options.onTyped?.(page.origin, password);
      submittedAt = yield* Clock.currentTimeMillis;
      if (action.fields.length > 0) requestedAt = submittedAt;
      const late = options.beforeType
        ? yield* options.beforeType(page.origin).pipe(Effect.flip, Effect.option)
        : Option.none();
      if (Option.isSome(late))
        return { outcome: "failed" as const, message: late.value.message, tabId: target };
      // The very last moment before the send, after every wait above.
      const lastMoment = yield* stopNow;
      if (lastMoment !== undefined)
        return { outcome: "needs-user" as const, message: lastMoment, tabId: target };
      // At the send itself, the code box, its container, what it asks for and the button are
      // still the ones the key was typed for, or the key is cleared and the page is the person's.
      if (keyField) {
        const now = yield* inspect(step);
        // The same field and button by instance, and no limit or check newly showing.
        const stopShows = now.page.limited === true || now.page.challenge === "captcha";
        if (
          !samePrompt(page, now.page) ||
          now.page.submit !== page.submit ||
          now.page.submitInstance !== page.submitInstance ||
          stopShows
        ) {
          if ((yield* clearTyped(filled)).length > 0) cleanupFailed = true;
          filled = [];
          ({ page, timestamp } = now);
          return {
            outcome: "needs-user" as const,
            message: stopShows
              ? "The site asks for a check or is limiting sign-ins."
              : PROMPT_MOVED,
            tabId: target,
          };
        }
      }
      // The page as submitted: a look that still finds it has seen nothing new yet.
      const submittedDocument = page.document;
      // A key is sent from the accounts world, which checks the field, its container, the button
      // and what the page asks for in the same task as the click or Enter.
      const keySend =
        keyField && page.otpField !== undefined && page.document !== undefined
          ? {
              world: "accounts" as const,
              origin: page.origin,
              instance: page.otpField,
              document: page.document,
              ...(page.otpContainer === undefined ? {} : { container: page.otpContainer }),
              ...(page.submitInstance === undefined ? {} : { submitInstance: page.submitInstance }),
              mode: keyMode(page, keyField.selector),
              ...(sentBefore ? { passwordSent: true } : {}),
            }
          : {};
      const send = keyField ? invokeSend : invoke;
      const sent = yield* (
        action.submit
          ? send<KeyDispatch | undefined>("click", { selector: action.submit, ...keySend }, target)
          : send<KeyDispatch | undefined>("press", { key: "Enter", ...keySend }, target)
      ).pipe(Effect.result);
      if (Result.isFailure(sent)) {
        if (!keyField) return yield* sent.failure;
        if ((yield* clearTyped(filled)).length > 0) cleanupFailed = true;
        filled = [];
        return { outcome: "needs-user" as const, message: PROMPT_MOVED, tabId: target };
      }
      // The site may have the code and hasn't answered, or nothing showed at all: nothing is
      // taken back or sent again, and the tab waits as it is for the person.
      if (keyField && sent.success?.unanswered !== undefined) {
        filled = [];
        submissions.at(-1)!.unanswered = true;
        return leftWithSite();
      }
      // The submit may have made the site send a code: the page is read again every half second
      // or so for up to eight seconds, so a code step is told soon after it shows.
      for (let look = 0; look < POST_SUBMIT_LOOKS; look++) {
        if (codeStep !== "none" || !options.onCodeStep) break;
        const early = yield* invoke(
          "accountWaitForLoad",
          { loadMs: POST_SUBMIT_LOOK_MS, settleMs: POST_SUBMIT_LOOK_MS },
          target,
        ).pipe(
          Effect.andThen(
            invoke<unknown>(
              "evaluate",
              { expression: signInDetectionScript, world: "accounts" },
              target,
            ),
          ),
          Effect.flatMap(decodeDetection),
          Effect.map(observe),
          Effect.option,
        );
        if (Option.isNone(early)) continue;
        decide(early.value);
        if (!(yield* tellCodeStep)) return { ...untold, tabId: target };
        // Signed in, or a new page asking for something else: the step loop takes it from here.
        // The page as submitted, still showing its fields, is looked at again.
        const fresh =
          early.value.document === undefined || early.value.document !== submittedDocument;
        if (
          early.value.signedIn ||
          (fresh && (early.value.password !== null || early.value.username !== null))
        )
          break;
      }
      yield* invoke("accountWaitForLoad", { settleMs: 1000 }, target);
    }
    return { outcome: "failed" as const, message: SIGN_IN_TOO_LONG, tabId: target };
  });
  return yield* run.pipe(
    Effect.orElseSucceed(() => ({
      outcome: "failed" as const,
      message: "The browser sign-in could not be completed.",
      tabId: target,
    })),
    Effect.tap((result) =>
      Effect.sync(() => {
        signedInAtEnd = result.outcome === "signed-in";
      }),
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        if ((yield* clearTyped(clearFilled ? filled : [])).length > 0) cleanupFailed = true;
        let codes: ReadonlyArray<Typed> = signedInAtEnd ? [] : typedCodes;
        if (codes.length === 0) return;
        // A code on screen never goes back to an agent: the tab stays private and the person's
        // until it's cleared or the tab really closed.
        codeHeld = !(yield* keepPrivateUntil({
          tabId: target,
          threadId: session.threadId,
          accountId: account.accountId,
          accountName: account.name,
          site: new URL(codes[0]!.origin).host,
          reason: "Clear the code Scient typed in this tab.",
          waitMs: patience.waitMs,
          settle: Effect.suspend(() => clearTyped(codes)).pipe(
            Effect.map((left) => {
              codes = left;
              return left.length === 0;
            }),
          ),
          close: invoke("close", {}, target).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
          show: invoke("open", { tabId: target, reuseExistingTab: true, open: true }, target).pipe(
            Effect.ignore,
          ),
        }).pipe(Effect.provideService(AccountsService, accounts)));
      }).pipe(Effect.ignore),
    ),
    Effect.map((result) =>
      codeHeld
        ? {
            ...result,
            message: `${"message" in result ? result.message : "Sign-in did not finish."} A code Scient typed is still in its tab, so the tab stays with the user until it's cleared.`,
          }
        : cleanupFailed
          ? {
              ...result,
              message: `${"message" in result ? result.message : "Sign-in did not finish."} Some filled fields could not be cleared; ask the user to clear them in the browser.`,
            }
          : result,
    ),
    // A sign-in that worked after Scient typed the saved password shows that password works.
    Effect.map((result) => ({
      ...result,
      ...(result.outcome === "signed-in" &&
      submissions.some(({ fields }) => fields.includes("password"))
        ? { savedPasswordUsed: true as const }
        : {}),
      ...(options.person?.learnOrigins ? { learned: [...learned] } : {}),
    })),
  );
});
