import type { BrowserImportSourceId } from "../browserImport.ts";

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
}

/** Sites with cookies in a Scient browser profile on this desktop. */
export interface DesktopProfileSignedInSite {
  /** Registrable domain, e.g. `huji.ac.il`. */
  readonly domain: string;
  readonly cookies: number;
}

/** A sign-in the user submitted in a desktop browser tab. */
export interface DesktopCapturedSignIn {
  readonly tabId: string;
  readonly profileId: string;
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

export interface DesktopLoginForm {
  readonly tabId: string;
  readonly profileId: string;
  readonly url: string;
  readonly documentId: string;
  readonly userEdited: boolean;
  readonly hasValues: boolean;
}

export interface DesktopSignInFill {
  readonly tabId: string;
  /** Reject if the main frame or a filled frame has a different origin at fill time. */
  readonly expectedOrigin?: string;
  readonly documentId?: string;
  readonly automatic?: boolean;
  readonly username?: string;
  readonly password?: string;
  readonly otp?: string;
}

/** Scient Accounts members of the desktop bridge (`ScientDesktopBridge.accounts`). */
export interface DesktopAccountsBridge {
  /** Set only when fill enforces expectedOrigin in the native guest before applying values. */
  readonly originBoundFill?: true;
  readonly sourceProfiles: () => Promise<ReadonlyArray<DesktopSourceProfileDetails>>;
  /** Omit environmentId for the primary local environment. */
  readonly signedInSites: (
    profileId: string,
    environmentId?: string,
  ) => Promise<ReadonlyArray<DesktopProfileSignedInSite>>;
  /** Fills the login form on the tab's current page. Resolves false when it found none. */
  readonly fill: (input: DesktopSignInFill) => Promise<boolean>;
  readonly loginForm?: (tabId: string) => Promise<DesktopLoginForm | null>;
  readonly onLoginFormDetected?: (listener: (form: DesktopLoginForm) => void) => () => void;
  readonly onSignInCaptured: (listener: (capture: DesktopCapturedSignIn) => void) => () => void;
}
