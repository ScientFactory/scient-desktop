import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";

const BROWSER_IMPORT_SOURCE_IDS = [
  "chrome",
  "edge",
  "brave",
  "vivaldi",
  "opera",
  "arc",
  "helium",
  "firefox",
  "zen",
  "safari",
] as const;

export const BrowserImportSourceId = Schema.Literals(BROWSER_IMPORT_SOURCE_IDS);
export type BrowserImportSourceId = typeof BrowserImportSourceId.Type;

export const BrowserImportUnavailableReason = Schema.Literals([
  "notInstalled",
  "needsKeychainApproval",
  "keychainItemMissing",
  "needsFullDiskAccess",
  "browserRunning",
  "unsupportedPlatform",
  // SCIENT-FORK:START — Scient Accounts: Windows keeps Chromium sign-ins from other apps.
  "appBoundEncryption",
  // SCIENT-FORK:END
]);
export type BrowserImportUnavailableReason = typeof BrowserImportUnavailableReason.Type;

export const BrowserImportFailureReason = Schema.Literals([
  ...BrowserImportUnavailableReason.literals,
  "keychainUnavailable",
  "unknownSource",
  "unknownSourceProfile",
  "sessionUnavailable",
  "profileNotSaved",
  "profileLimitReached",
  "readFailed",
  // SCIENT-FORK:START — Scient Accounts: cookies read but none could be stored in the profile.
  "writeFailed",
  // SCIENT-FORK:END
]);
export type BrowserImportFailureReason = typeof BrowserImportFailureReason.Type;

export const BrowserImportSourceProfile = Schema.Struct({
  directory: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  cookieCount: Schema.optional(Schema.Int),
});
export type BrowserImportSourceProfile = typeof BrowserImportSourceProfile.Type;

export const BrowserImportSource = Schema.Struct({
  id: BrowserImportSourceId,
  name: TrimmedNonEmptyString,
  profiles: Schema.Array(BrowserImportSourceProfile),
  unavailable: Schema.optional(BrowserImportUnavailableReason),
});
export type BrowserImportSource = typeof BrowserImportSource.Type;

export const BrowserImportInput = Schema.Struct({
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: TrimmedNonEmptyString,
  targetProfileId: BrowserProfileId,
  // SCIENT-FORK:START — Scient Accounts: a refresh leaves working sign-ins alone.
  keepSites: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  // SCIENT-FORK:END
});
export type BrowserImportInput = typeof BrowserImportInput.Type;

export const DesktopPreviewImportCookiesInputSchema = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: TrimmedNonEmptyString,
  targetProfileId: BrowserProfileId,
  // SCIENT-FORK:START — Scient Accounts: a refresh leaves working sign-ins alone.
  keepSites: BrowserImportInput.fields.keepSites,
  // SCIENT-FORK:END
});

// SCIENT-FORK:START — Scient Accounts: say why cookies were left behind.
/** Cookie rows left out, by cause; a row counts once, so the sum is at most `skipped`. */
export const BrowserImportSkippedByReason = Schema.Struct({
  /** Windows `v20` rows, readable only by the browser that wrote them. */
  appBoundEncryption: Schema.Int,
  decryptFailed: Schema.Int,
  /** Partitioned rows without the stored ancestor bit their key needs. */
  partitionUnsupported: Schema.Int,
  writeFailed: Schema.Int,
});
export type BrowserImportSkippedByReason = typeof BrowserImportSkippedByReason.Type;
// SCIENT-FORK:END

export const BrowserImportResult = Schema.Struct({
  imported: Schema.Int,
  skipped: Schema.Int,
  skippedDomains: Schema.Array(Schema.String),
  // SCIENT-FORK:START — Scient Accounts: the sites an import brought cookies for.
  importedSites: Schema.optional(Schema.Int),
  skippedByReason: Schema.optional(BrowserImportSkippedByReason),
  /** Whether any imported cookie belongs to Google. */
  importedGoogle: Schema.optional(Schema.Boolean),
  // SCIENT-FORK:END
});
export type BrowserImportResult = typeof BrowserImportResult.Type;

const BROWSER_IMPORT_UNAVAILABLE_COPY: Readonly<Record<BrowserImportUnavailableReason, string>> = {
  notInstalled: "Not installed on this machine.",
  needsKeychainApproval: "Needs Keychain access to read its cookies.",
  keychainItemMissing:
    "No encryption key in your Keychain. Sign in to that browser once, then retry.",
  needsFullDiskAccess:
    "Give Scient Full Disk Access in System Settings → Privacy & Security, then retry.",
  browserRunning: "Quit the browser first so its cookie database can be read.",
  unsupportedPlatform: "Importing from this browser isn't possible on this platform.",
  // SCIENT-FORK:START — Scient Accounts: Windows keeps Chromium sign-ins from other apps.
  appBoundEncryption: "Windows protects this browser's saved sign-ins from other apps.",
  // SCIENT-FORK:END
};

export const BROWSER_IMPORT_FAILURE_COPY: Readonly<Record<BrowserImportFailureReason, string>> = {
  ...BROWSER_IMPORT_UNAVAILABLE_COPY,
  keychainUnavailable:
    "The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.",
  unknownSource: "That browser is no longer available to import from.",
  unknownSourceProfile: "That browser profile no longer exists.",
  sessionUnavailable: "The target profile could not be opened.",
  profileNotSaved: "The cookies were imported, but the new profile couldn't be saved. Try again.",
  profileLimitReached:
    "You've reached the profile limit. Delete a profile or import into an existing one.",
  readFailed: "The browser's cookie database could not be read.",
  // SCIENT-FORK:START — Scient Accounts: cookies read but none could be stored in the profile.
  writeFailed: "The cookies were read, but none could be saved into the profile.",
  // SCIENT-FORK:END
};
