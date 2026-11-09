import type { BrowserImportSourceId } from "../browserImport.ts";
import type { SessionCookie } from "./accounts.ts";

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
  /** The username came from an earlier step of the same sign-in, in this tab and origin. */
  readonly usernameFrom: "form" | "earlier-step";
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
}

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
  /** A Chromium profile's saved passwords as CSV for `accountsImportPasswords`; local desktop only. */
  readonly readBrowserPasswords?: (input: {
    readonly sourceId: BrowserImportSourceId;
    readonly directory: string;
  }) => Promise<{ readonly content: string; readonly skipped: number } | null>;
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
  }> | null>;
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
  readonly signOutSite?: (
    profileId: string,
    site: string,
    environmentId?: string,
  ) => Promise<boolean>;
  /** Fills the login form on the tab's current page. Resolves false when it found none. */
  /** False when nothing was filled; "submitted" when the form was also really sent. */
  readonly fill: (input: DesktopSignInFill) => Promise<boolean | "submitted">;
  readonly loginForm?: (tabId: string) => Promise<DesktopLoginForm | null>;
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
  /** Dev builds only: checks that session copies are exact on this platform; null if refused. */
  readonly qualifySessionCopy?: () => Promise<ReadonlyArray<DesktopQualifyCase> | null>;
}
