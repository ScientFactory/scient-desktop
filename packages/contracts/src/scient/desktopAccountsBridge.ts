import type { BrowserImportResult, BrowserImportSourceId } from "../browserImport.ts";
import type { AccountPageOffer, SessionCookie } from "./accounts.ts";

/** A profile found in another browser on this machine; metadata only, never its sign-ins. */
export interface DesktopSourceProfileDetails {
  readonly sourceId: BrowserImportSourceId;
  /** Matches `BrowserImportSourceProfile.directory`. */
  readonly directory: string;
  readonly name: string;
  readonly email?: string;
  /** Square PNG data URI, at most 96 px. */
  readonly picture?: string;
  /** `#rrggbb` the source browser shows for this profile. */
  readonly color?: string;
  readonly passwordCount?: number;
}

/** Sites with cookies in a Scient browser profile on this desktop. */
export interface DesktopProfileSignedInSite {
  /** Registrable domain, e.g. `huji.ac.il`. */
  readonly domain: string;
  readonly cookies: number;
}

/** A sign-in the user submitted in a desktop browser tab: the step that sent a password. */
export interface DesktopCapturedSignIn {
  readonly tabId: string;
  readonly profileId: string;
  readonly url: string;
  /** The page's path when it was sent. */
  readonly path: string;
  readonly step: "password";
  readonly username: string;
  readonly password: string;
  /**
   * A sign-up or change form's new password, where it has one. With it, `password` is the current
   * one, and may be empty.
   */
  readonly newPassword?: string;
  /** The username came from an earlier step of the same sign-in, in this tab and origin. */
  readonly usernameFrom: "form" | "earlier-step";
}

export interface DesktopSignInPage {
  /** "done": past every username, password and code box, the page fully loaded. */
  readonly state: "loading" | "login" | "code" | "done";
  readonly url: string;
  /** The page's document came back as an HTTP error (a refused form's answer, a 404). */
  readonly failed?: boolean;
  /** The page says the site is limiting sign-ins (too many attempts, a lockout). */
  readonly limited?: boolean;
  /** The page's document, as its form reports name it; absent on older desktops. */
  readonly documentId?: string;
  /**
   * The answer to the last new-password or filled sign-in form submitted in this tab: the response
   * to the request it sent on the submit, and the page right after that response (never a later
   * one).
   */
  readonly submitted?: DesktopSubmitAnswer;
}

export interface DesktopSubmitAnswer {
  /** The document whose form was submitted. */
  readonly documentId: string;
  /** The final HTTP status of that request (after redirects); 0 when it failed. */
  readonly status: number;
  /** The page right after: no new-password, sign-in or code box left. */
  readonly formGone: boolean;
  /** The page right after says it failed (a password wrong, a rule unmet), in English. */
  readonly refusal: boolean;
  /** The page right after is on another origin. */
  readonly leftOrigin: boolean;
}

export interface DesktopLoginForm {
  readonly tabId: string;
  readonly profileId: string;
  /** The page's origin. */
  readonly url: string;
  /** The full page address, for the tab Scient filled. */
  readonly pageUrl?: string;
  readonly documentId: string;
  readonly userEdited: boolean;
  readonly hasPassword: boolean;
  readonly hasValues: boolean;
  /** The page's username box, then its second one: what each accepts. */
  readonly boxes: ReadonlyArray<DesktopLoginBox>;
  /** The page also offers something to keep: a 2FA setup's key. Absent from older desktops. */
  readonly offer?: AccountPageOffer;
  /** A sign-up or change-password form: what it says about the new password it takes. */
  readonly newPassword?: DesktopNewPasswordRules;
}

/**
 * What a page says about the new password it takes: its box's limits, and what its own words
 * state, read in the page (the words themselves stay there, since they can hold codes).
 */
export interface DesktopNewPasswordRules {
  readonly minLength: number;
  readonly maxLength: number;
  /** The box's `pattern`, matched whole, as the browser checks it. */
  readonly pattern: string;
  /** Apple's `passwordrules` attribute, where the page has one. */
  readonly passwordRules: string;
  /** Lengths the form's words state, such as "at least 12 characters" (-1 for none). */
  readonly statedMinLength: number;
  readonly statedMaxLength: number;
  /** Kinds of character the words require, such as "one symbol". */
  readonly required: ReadonlyArray<"lower" | "upper" | "digit" | "symbol">;
  /** The words refuse symbols ("letters and numbers only"). */
  readonly noSymbols: boolean;
  /** The words say a password was refused ("incorrect", "too weak", "already used"). */
  readonly refusal: boolean;
}

/** What a username box accepts: an email or not, and its own length and pattern limits. */
export interface DesktopLoginBox {
  readonly email: boolean;
  readonly minLength: number;
  readonly maxLength: number;
  readonly pattern: string;
}

export interface DesktopSignInFill {
  readonly tabId: string;
  /** Reject if the main frame or a filled frame has a different origin at fill time. */
  readonly expectedOrigin?: string;
  readonly documentId?: string;
  readonly automatic?: boolean;
  /** Submit a complete sign-in after filling it. */
  readonly submit?: boolean;
  readonly username?: string;
  /** Another saved username for the page's second box: an email beside an ID, or the reverse. */
  readonly otherUsername?: string;
  readonly password?: string;
  readonly otp?: string;
  /**
   * Replace the code box's value only while it still holds this code (Scient's own earlier one
   * for the same setup), never what the person typed.
   */
  readonly otpExpected?: string;
  /**
   * Replace the password box's value only while it still holds this password (the one Scient
   * typed and a site refused), never what the person typed.
   */
  readonly passwordExpected?: string;
  /**
   * A new password for every new-password box of a sign-up or change form; `password` then goes
   * in its current box. Sent only to a desktop whose form reports carry `newPassword`.
   */
  readonly newPassword?: string;
}

/** Scient Accounts members of the desktop bridge (`ScientDesktopBridge.accounts`). */
export interface DesktopGoogleSession {
  readonly email: string;
  /** False when Google remembers the account but no longer accepts its session. */
  readonly valid: boolean;
}

/** What a copy of one unit did; `restore-failed` left it refused until the user signs out there. */
export type DesktopUnitOutcome =
  | "copied"
  | "same"
  | "conflict"
  | "blocked"
  | "busy"
  | "failed"
  | "restore-failed";

/** What a copy into Main did to each unit; never any cookie value. */
export interface DesktopFillMainResult {
  readonly units: ReadonlyArray<{
    readonly sites: ReadonlyArray<string>;
    /** `busy`: a page wrote the unit meanwhile; its newer cookies were left and nothing copied. */
    readonly outcome: DesktopUnitOutcome;
  }>;
  /** Cookies Scient can't carry exactly, such as opaque partitions; left out. */
  readonly unsupported: number;
  /**
   * For an import into Main: the import's cookie rows, before the copy judged them by site.
   * Cookie counts, never added to the units' site counts.
   */
  readonly importSummary?: Pick<BrowserImportResult, "imported" | "skipped" | "skippedByReason">;
}

/**
 * A copy into Main. The app window decides which profiles may give Main their sign-ins, from the
 * server's profile record; the desktop refuses only Main and Incognito as sources.
 */
export interface DesktopFillMainInput {
  /** Omit for the primary local environment. */
  readonly environmentId?: string;
  /** A Scient profile, or another browser's profile to import into Main. */
  readonly from:
    | string
    | { readonly importSourceId: BrowserImportSourceId; readonly sourceProfileDirectory: string };
  /** Absent: the whole jar, one unit per registrable site. */
  readonly units?: ReadonlyArray<ReadonlyArray<string>>;
  /** For a whole jar: multi-site sign-ins whose sites are copied as one unit. */
  readonly join?: ReadonlyArray<ReadonlyArray<string>>;
  readonly mode: "fill" | "fill-or-replace";
  /** Site → when Main's row for it was seen signed out. */
  readonly replaceAllowedSince?: Readonly<Record<string, string>>;
  /** Google may be replaced too: Google has signed Main out, so Main has no session to keep. */
  readonly replaceGoogle?: boolean;
  /** Sites the user signed out of in Main; never copied. */
  readonly skipSites: ReadonlyArray<string>;
  /** An agent's refresh of Main: checked in Main's turn, in the data it was decided in. */
  readonly operationId?: string;
  readonly generation?: number;
}

/** A sign-in in a window of the person's own Chromium browser, then copied into a Scient profile. */
export interface DesktopChromeSignInInput {
  /** Omit for the primary local environment. */
  readonly environmentId?: string;
  readonly profileId: string;
  /** An https page, or a loopback http one. */
  readonly url: string;
  /** Names this sign-in for Done and Cancel, so one dialog's Cancel never ends another's. */
  readonly attemptId?: string;
  /** Required for Main: what the copy may do, as for an import into Main. */
  readonly main?: Pick<
    DesktopFillMainInput,
    "mode" | "replaceAllowedSince" | "replaceGoogle" | "skipSites"
  >;
}

/**
 * Google's answer right after a copy of its cookies: `accepted` means it takes the session now, not
 * that it will keep doing so; `unknown` means it couldn't be asked.
 */
export type DesktopGoogleCopyCheck = "accepted" | "rejected" | "unknown";

export type DesktopChromeSignInResult =
  | { readonly outcome: "no-browser" }
  /** `nothing`: the window held no sign-in when it closed. */
  | { readonly outcome: "busy" | "failed" | "cancelled" | "nothing"; readonly browser?: string }
  | {
      /** Cookies copied, not a sign-in proven; into Main, `main` says what each unit did. */
      readonly outcome: "copied";
      readonly browser: string;
      readonly sites: ReadonlyArray<string>;
      /** Into Main: what the copy did to each site. */
      readonly main?: DesktopFillMainResult;
      /** Present only when Google's cookies were written. */
      readonly google?: DesktopGoogleCopyCheck;
      /** Google already accepted a session in the profile before the copy wrote over it. */
      readonly googleHeldBefore?: true;
    };

/**
 * A shareable profile's sign-ins in the desktop's own jar, for other computers. The app window
 * decides which profiles may be read, from the server's profile record; the desktop doesn't.
 */
export interface DesktopReadSessionsInput {
  readonly profileId: string;
  /** Absent: the whole jar, one unit per registrable site. */
  readonly units?: ReadonlyArray<ReadonlyArray<string>>;
  /** For a whole jar: multi-site sign-ins whose sites are one unit. */
  readonly join?: ReadonlyArray<ReadonlyArray<string>>;
}

/** Each unit's live cookies; the values reach only the app window that asked. */
export interface DesktopReadSessionsResult {
  readonly units: ReadonlyArray<{
    readonly sites: ReadonlyArray<string>;
    readonly cookies: ReadonlyArray<SessionCookie>;
  }>;
}

/** One case of the dev-only session-copy qualification. */
export interface DesktopQualifyCase {
  readonly case: number;
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface DesktopAccountsBridge {
  /** Set only when fill enforces expectedOrigin in the native guest before applying values. */
  readonly originBoundFill?: true;
  /**
   * Round 6f: a Chromium profile's saved passwords, read by the desktop and handed by it straight
   * to its own backend's Accounts: never to the page. Null when they couldn't be read or sent.
   */
  readonly importBrowserPasswords?: (input: {
    readonly sourceId: BrowserImportSourceId;
    readonly directory: string;
    readonly profileId?: string;
    readonly refresh?: true;
    readonly operationId?: string;
  }) => Promise<{
    readonly result?: {
      readonly created: number;
      readonly updated: number;
      readonly skipped: number;
    };
    readonly refused?: string;
    readonly skipped: number;
  } | null>;
  readonly sourceProfiles: () => Promise<ReadonlyArray<DesktopSourceProfileDetails>>;
  /** The site's icon as an image data URI, from the site itself and cached on disk; null if none. */
  readonly siteIcon?: (site: string) => Promise<string | null>;
  /** Omit environmentId for the primary local environment. */
  readonly signedInSites: (
    profileId: string,
    environmentId?: string,
  ) => Promise<ReadonlyArray<DesktopProfileSignedInSite>>;
  /** Full cookie-domain/expiry inventory, or null when the read failed. Never includes values. */
  readonly cookieMetadata?: (
    profileId: string,
    environmentId?: string,
  ) => Promise<ReadonlyArray<{
    readonly domain: string;
    readonly httpOnly?: boolean;
    readonly expires?: number;
    /** Its name and path, and a short fingerprint of its value (never the value): a rotation shows. */
    readonly name?: string;
    readonly path?: string;
    readonly digest?: string;
  }> | null>;
  /** A signed-in Google page refreshed a session in some profile; ask `googleSessions` again. */
  readonly onGoogleActivity?: (listener: () => void) => () => void;
  /** What Google says about this profile's accounts, or null when it couldn't be read. */
  readonly googleSessions?: (
    profileId: string,
    environmentId?: string,
  ) => Promise<ReadonlyArray<DesktopGoogleSession> | null>;
  /** Asks a site for a page with the profile's session and no page opened; null if that failed. */
  readonly quietVisit?: (
    profileId: string,
    url: string,
    environmentId?: string,
  ) => Promise<{ readonly url: string; readonly status: number } | null>;
  /** Removes every cookie of one site (a registrable domain) from the profile. Optional for older desktops. */
  /**
   * Round 6e: each operation's Undo deadline as its computer's Accounts records it (ISO), or null
   * while it is under way. The desktop lets go of an Undo save only past its deadline.
   */
  readonly setUndoDeadlines?: (
    deadlines: Readonly<Record<string, string | null>>,
  ) => Promise<boolean>;
  /** Round 6b: the generation each profile's partition is in, as Accounts says. */
  readonly setProfileGenerations?: (
    generations: Readonly<Record<string, number>>,
    environmentId?: string,
  ) => Promise<boolean>;
  /** Signs a profile out of a site, keeping its cookies encrypted for the Undo hour. */
  readonly signOutSiteKept?: (
    profileId: string,
    site: string,
    operationId: string,
    environmentId?: string,
    /** Round 6d: the data it was done in (and its destination's): its writes go there. */
    at?: { readonly generation?: number; readonly intoGeneration?: number },
  ) => Promise<{
    readonly signedOut: boolean;
    readonly saved: number;
    readonly notRestorable: number;
    /** Cookies it couldn't reach (an opaque partition), still there. */
    readonly leftBehind?: number;
  } | null>;
  /** That sign-out's Undo: the cookies set back where the site still takes them. */
  readonly restoreSignOut?: (
    profileId: string,
    operationId: string,
    environmentId?: string,
    /** Round 6d: the data it was done in (and its destination's): its writes go there. */
    at?: { readonly generation?: number; readonly intoGeneration?: number },
  ) => Promise<{ readonly restored: number; readonly refused: number } | null>;
  /** Copies a profile's cookies for these sites (all when none) into another partition, with Undo. */
  readonly copyProfileSites?: (
    profileId: string,
    into: string,
    sites: ReadonlyArray<string> | undefined,
    move: boolean,
    operationId: string,
    environmentId?: string,
    /** Round 6d: the data it was done in (and its destination's): its writes go there. */
    at?: { readonly generation?: number; readonly intoGeneration?: number },
  ) => Promise<{ readonly copied: number; readonly uncovered: ReadonlyArray<string> } | null>;
  readonly undoProfileCopy?: (
    profileId: string,
    into: string,
    operationId: string,
    environmentId?: string,
    /** Round 6d: the data it was done in (and its destination's): its writes go there. */
    at?: { readonly generation?: number; readonly intoGeneration?: number },
  ) => Promise<{ readonly restored: number; readonly refused: number } | null>;
  /** Forgets a profile's sign-in window: the folder where the browser kept its sign-ins. */
  /** With `since`: kept if the window was signed in to after it. False while the window is open. */
  readonly forgetChromeSignIn?: (profileId: string, since?: string) => Promise<boolean>;
  /** Empties one generation of a profile's partition, once its Undo hour is over. */
  readonly purgeProfileData?: (
    profileId: string,
    generation: number,
    environmentId?: string,
  ) => Promise<boolean>;
  readonly signOutSite?: (
    profileId: string,
    site: string,
    environmentId?: string,
  ) => Promise<boolean>;
  /** Fills the login form on the tab's current page. Resolves false when it found none. */
  /** False when nothing was filled; "submitted" when the form was also really sent. */
  readonly fill: (input: DesktopSignInFill) => Promise<boolean | "submitted">;
  readonly loginForm?: (tabId: string) => Promise<DesktopLoginForm | null>;
  /** Where the tab's sign-in stands; null when it can't tell. Optional for older desktops. */
  readonly signInPage?: (tabId: string) => Promise<DesktopSignInPage | null>;
  /**
   * What a 2FA setup or backup-code page in the person's own tab shows, read in the page's
   * document `documentId` only and sealed in the desktop's main process for the local backend it
   * runs (a key only the two derive), once, with the page's origin, profile and document bound to
   * it: the app only carries it, and no other server opens it. Null otherwise.
   */
  readonly pageSecrets?: (
    tabId: string,
    offer: AccountPageOffer,
    documentId: string,
  ) => Promise<{ readonly sealed: string } | null>;
  /**
   * Takes the person's tab from a page without a change-password form, along the site's own
   * links, to one with it; never off `origin`, redirects included. True when it got there.
   */
  readonly seekPasswordPage?: (tabId: string, origin: string) => Promise<boolean>;
  readonly onLoginFormDetected?: (listener: (form: DesktopLoginForm) => void) => () => void;
  readonly onSignInCaptured: (listener: (capture: DesktopCapturedSignIn) => void) => () => void;
  /** The one writer of Scient's copies into Main; null when refused. Optional for older desktops. */
  readonly fillMain?: (input: DesktopFillMainInput) => Promise<DesktopFillMainResult | null>;
  /** Accounts' Sign out on Main, under the same lock as every copy into it. */
  readonly signOutMainSite?: (site: string, environmentId?: string) => Promise<boolean>;
  /**
   * Removes from Main what a restricted profile's copies wrote there, unit by unit, where Main
   * still holds exactly that; the units removed, or null when Main can't be opened.
   */
  /**
   * Whether this window runs Accounts' background work, now and whenever that changes. One app
   * window does; the role moves when it closes.
   */
  readonly onAccountsOwner?: (listener: (owner: boolean) => void) => () => void;
  readonly withdrawFromMain?: (input: {
    readonly from: string;
    readonly environmentId?: string;
    /** Lists the units Main holds from `from`, removing nothing. */
    readonly heldOnly?: true;
  }) => Promise<{ readonly units: ReadonlyArray<ReadonlyArray<string>> } | null>;
  /** Reads the primary environment's jar under the Main lock; null when refused. */
  readonly readSessions?: (
    input: DesktopReadSessionsInput,
  ) => Promise<DesktopReadSessionsResult | null>;
  /**
   * The browser a sign-in window opens in ("Chrome", "Edge"…), or null when none is installed.
   * `canQuit`: Done can quit it; elsewhere the person closes the window themselves.
   */
  readonly chromeSignInBrowser?: () => Promise<{
    readonly name: string;
    readonly canQuit: boolean;
  } | null>;
  /**
   * Whether a browser that imports through itself (`BrowserImportSource.connection`) has remote
   * debugging turned on; null when refused. Never asks the person anything.
   */
  readonly browserConnection?: (
    sourceId: BrowserImportSourceId,
  ) => Promise<{ readonly on: boolean } | null>;
  /**
   * On a Mac: asks for Messages once so macOS lists Scient, opens Full Disk Access, and shows the
   * app in Finder to drag in. False elsewhere or when refused.
   */
  readonly openFullDiskAccess?: () => Promise<boolean>;
  /** Restarts Scient. */
  readonly relaunch?: () => Promise<boolean>;
  /** Resolves once the window closed and its sign-in was copied, or with why not. */
  readonly chromeSignIn?: (input: DesktopChromeSignInInput) => Promise<DesktopChromeSignInResult>;
  /**
   * Done (`keep`) quits the open sign-in window; Cancel stops it, its copy until the first cookie
   * write, or the attempt before it starts. False when there is nothing left to end.
   */
  readonly endChromeSignIn?: (keep: boolean, attemptId?: string) => Promise<boolean>;
  /** Dev builds only: checks that session copies are exact on this platform; null if refused. */
  readonly qualifySessionCopy?: () => Promise<ReadonlyArray<DesktopQualifyCase> | null>;
}
