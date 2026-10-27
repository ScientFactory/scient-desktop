import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { BrowserImportSourceId } from "../browserImport.ts";
import { BrowserProfileId } from "../browserProfile.ts";
import { GrantScope } from "./secrets.ts";

/**
 * Scient Accounts: things the user connects once (website sign-ins, library
 * access, API keys, databases, command-line logins) and browser profiles, with
 * the access each agent session gets. Values never travel in these schemas
 * except as explicit inputs. See docs/internals/scient-accounts.md.
 */

export const AccountId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^acc_[A-Za-z0-9_-]{8,64}$/),
).pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;

export const AccountKind = Schema.Literals([
  "website",
  "library",
  "api-key",
  "database",
  "cli-login",
]);
export type AccountKind = typeof AccountKind.Type;

/** `allowed` never prompts, including scheduled runs; `ask` waits for the user's card. */
export const AccountAccess = Schema.Literals(["off", "ask", "allowed"]);
export type AccountAccess = typeof AccountAccess.Type;

/** Enforced only where Scient performs or configures the use (brokered requests, databases). */
export const AccountPermission = Schema.Literals(["read-only", "full"]);
export type AccountPermission = typeof AccountPermission.Type;

/** `readable`: the agent may receive the value in a per-session file. */
export const AccountVisibility = Schema.Literals(["hidden", "readable"]);
export type AccountVisibility = typeof AccountVisibility.Type;

export const AccountControls = Schema.Struct({
  access: AccountAccess,
  permission: AccountPermission,
  visibility: AccountVisibility,
  scope: GrantScope,
  /** Projects where Ask counts as Allowed, from "Always in this project". */
  allowedProjects: Schema.optional(Schema.Array(ProjectId)),
});
export type AccountControls = typeof AccountControls.Type;

const ALL_PROJECTS: GrantScope = { type: "all-projects" };

/** Everything new starts Allowed; values an agent must run with start readable. */
export const defaultAccountControls = (kind: AccountKind): AccountControls => ({
  access: "allowed",
  permission: "full",
  visibility: kind === "website" || kind === "library" ? "hidden" : "readable",
  scope: ALL_PROJECTS,
});

/** A secret field name; also valid as an environment variable name. */
export const AccountFieldKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
);
export type AccountFieldKey = typeof AccountFieldKey.Type;

/** `op://vault/item[/section]/field[?attribute=otp]` as copied from 1Password. */
export const OnePasswordReference = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^op:\/\/[^/\s]+\/[^/\s]+(?:\/[^/\s]+){1,2}(?:\?attribute=[a-z]+)?$/),
);
export type OnePasswordReference = typeof OnePasswordReference.Type;

export const CliPasswordStore = Schema.Literals(["bitwarden", "proton-pass"]);
export type CliPasswordStore = typeof CliPasswordStore.Type;
const CliIdentifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[A-Za-z0-9][^\s/?#]*$/),
);
const cliPasswordFields = {
  connection: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  itemId: CliIdentifier,
  vaultId: Schema.optional(CliIdentifier),
  field: TrimmedNonEmptyString.check(Schema.isMaxLength(256), Schema.isPattern(/^[^/?#]+$/)),
};
export const CliPasswordSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("bitwarden"), ...cliPasswordFields }),
  Schema.Struct({ type: Schema.Literal("proton-pass"), ...cliPasswordFields }),
]);
export type CliPasswordSource = typeof CliPasswordSource.Type;
export const CliPasswordStatus = Schema.Struct({
  state: Schema.Literals([
    "not-installed",
    "not-connected",
    "unauthenticated",
    "locked",
    "unlocked",
    "unavailable",
  ]),
  connection: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  serverUrl: Schema.optional(Schema.String),
});
export type CliPasswordStatus = typeof CliPasswordStatus.Type;
export const CliPasswordItem = Schema.Struct({
  itemId: CliIdentifier,
  vaultId: Schema.optional(CliIdentifier),
  name: Schema.String,
  fields: Schema.Array(Schema.String),
});
export type CliPasswordItem = typeof CliPasswordItem.Type;
export const CliPasswordStoreInput = Schema.Struct({
  store: CliPasswordStore,
  action: Schema.Literals(["status", "connect", "disconnect", "list"]),
  password: Schema.optional(Schema.String.check(Schema.isMaxLength(65536))),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type CliPasswordStoreInput = typeof CliPasswordStoreInput.Type;
export const CliPasswordStoreResult = Schema.Struct({
  status: CliPasswordStatus,
  items: Schema.Array(CliPasswordItem),
});
export type CliPasswordStoreResult = typeof CliPasswordStoreResult.Type;

const KeychainName = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

/** The read source of a secret field or the location of a saved copy. */
export const AccountValueSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("scient") }),
  Schema.Struct({ type: Schema.Literal("keychain"), service: KeychainName, account: KeychainName }),
  Schema.Struct({ type: Schema.Literal("1password"), reference: OnePasswordReference }),
  CliPasswordSource,
  /** The key of a Custom models connection, stored once by Custom models. */
  Schema.Struct({ type: Schema.Literal("custom-model"), connectionId: TrimmedNonEmptyString }),
]);
export type AccountValueSource = typeof AccountValueSource.Type;

export const AccountWriteStore = Schema.Union([
  Schema.Struct({ type: Schema.Literal("scient") }),
  Schema.Struct({ type: Schema.Literal("keychain") }),
  Schema.Struct({ type: Schema.Literal("1password"), vaultId: TrimmedNonEmptyString }),
]);
export type AccountWriteStore = typeof AccountWriteStore.Type;

export const AccountSecretSummary = Schema.Struct({
  source: AccountValueSource,
  copies: Schema.optional(Schema.Array(AccountValueSource)),
  /** Last four characters of a token-like value held by Scient; never for passwords. */
  hint: Schema.optional(Schema.String.check(Schema.isMaxLength(4))),
});
export type AccountSecretSummary = typeof AccountSecretSummary.Type;

/**
 * A site an account may be used on: a bare domain (`huji.ac.il`, matching its
 * subdomains) or an exact `https://` origin.
 */
export const AccountSite = TrimmedNonEmptyString.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?:https:\/\/[a-z0-9.-]+(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/,
  ),
);
export type AccountSite = typeof AccountSite.Type;

const HttpsUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https?:\/\//),
);

export const EnvironmentVariableName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
);

const WebsiteFields = {
  sites: Schema.Array(AccountSite).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /** Where Scient starts a sign-in; defaults to the page the agent is on. */
  loginUrl: Schema.optional(HttpsUrl),
  username: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  /** Profile whose browser session holds this sign-in; the default profile otherwise. */
  profileId: Schema.optional(BrowserProfileId),
} as const;

export const ApiKeyAuth = Schema.Union([
  Schema.Struct({ type: Schema.Literal("bearer") }),
  Schema.Struct({ type: Schema.Literal("header"), name: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("basic"), username: Schema.String }),
  Schema.Struct({ type: Schema.Literal("query"), name: TrimmedNonEmptyString }),
]);
export type ApiKeyAuth = typeof ApiKeyAuth.Type;

export const CliLoginTool = Schema.Literals(["gh", "wrangler", "aws", "gcloud", "other"]);
export type CliLoginTool = typeof CliLoginTool.Type;

export const CliLoginVariable = Schema.Struct({
  name: EnvironmentVariableName,
  /** Secret variables keep their value in `secrets[name]`; others carry it here. */
  secret: Schema.Boolean,
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type CliLoginVariable = typeof CliLoginVariable.Type;

/** What the account is; secret values are held separately under `secrets`. */
export const AccountDetails = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("website"), ...WebsiteFields }),
  Schema.Struct({
    kind: Schema.Literal("library"),
    ...WebsiteFields,
    /** Proxy or redirector address containing `{url}`, e.g. an OpenAthens redirector. */
    proxyUrl: HttpsUrl.check(Schema.isIncluding("{url}")),
  }),
  Schema.Struct({
    kind: Schema.Literal("api-key"),
    sites: Schema.Array(AccountSite).check(Schema.isMaxLength(16)),
    auth: ApiKeyAuth,
    /** Variable name scripts read the key from, e.g. HF_TOKEN. */
    envName: Schema.optional(EnvironmentVariableName),
  }),
  Schema.Struct({
    kind: Schema.Literal("database"),
    engine: Schema.Literal("postgres"),
    host: TrimmedNonEmptyString.check(Schema.isMaxLength(253)),
    port: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(65_536)),
    database: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    user: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    sslmode: Schema.optional(
      Schema.Literals(["disable", "prefer", "require", "verify-ca", "verify-full"]),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("cli-login"),
    tool: CliLoginTool,
    variables: Schema.Array(CliLoginVariable).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  }),
]);
export type AccountDetails = typeof AccountDetails.Type;

/** Secret fields each kind may hold. Command-line logins use their secret variable names. */
export const ACCOUNT_SECRET_FIELDS: Readonly<
  Record<Exclude<AccountKind, "cli-login">, ReadonlyArray<string>>
> = {
  website: ["password", "totp"],
  library: ["password", "totp"],
  "api-key": ["token"],
  database: ["password", "clientCert", "clientKey", "caCert"],
};

export const AccountStatus = Schema.Literals(["ready", "needs-attention"]);
export type AccountStatus = typeof AccountStatus.Type;

export const AccountSignInOutcome = Schema.Literals([
  "signed-in",
  "needs-user",
  "password-rejected",
  "code-rejected",
  "failed",
]);

export const AccountSummary = Schema.Struct({
  accountId: AccountId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  details: AccountDetails,
  secrets: Schema.Record(AccountFieldKey, AccountSecretSummary),
  controls: AccountControls,
  status: AccountStatus,
  /** Set only when something is wrong. */
  statusMessage: Schema.optional(TrimmedNonEmptyString),
  lastSignInOutcome: Schema.optional(AccountSignInOutcome),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastUsedAt: Schema.optional(IsoDateTime),
});
export type AccountSummary = typeof AccountSummary.Type;

/** A small square picture as an inline PNG/JPEG/WebP; clients never load remote images. */
export const ProfilePictureDataUri = Schema.String.check(
  Schema.isMaxLength(90_000),
  Schema.isPattern(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u),
);
export type ProfilePictureDataUri = typeof ProfilePictureDataUri.Type;

export const ProfileColor = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i));

export const BrowserProfileSource = Schema.Struct({
  browser: BrowserImportSourceId,
  profileName: TrimmedNonEmptyString,
  email: Schema.optional(TrimmedNonEmptyString),
  importedAt: IsoDateTime,
});
export type BrowserProfileSource = typeof BrowserProfileSource.Type;

/**
 * Scient's record for an upstream browser profile id. A profile without a
 * record is Allowed for all projects with script sign-ins on.
 */
export const BrowserProfileRecord = Schema.Struct({
  profileId: BrowserProfileId,
  access: AccountAccess,
  scope: GrantScope,
  /** Projects where Ask counts as Allowed, from "Always in this project". */
  allowedProjects: Schema.optional(Schema.Array(ProjectId)),
  /** Agents' scripts may receive this profile's session for a site. */
  scriptSignIn: Schema.Boolean,
  picture: Schema.optional(ProfilePictureDataUri),
  color: Schema.optional(ProfileColor),
  source: Schema.optional(BrowserProfileSource),
});
export type BrowserProfileRecord = typeof BrowserProfileRecord.Type;

export const defaultBrowserProfileRecord = (profileId: BrowserProfileId): BrowserProfileRecord => ({
  profileId,
  access: "allowed",
  scope: ALL_PROJECTS,
  scriptSignIn: true,
});

export const AccountTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("account"), accountId: AccountId }),
  Schema.Struct({ type: Schema.Literal("profile"), profileId: BrowserProfileId }),
]);
export type AccountTarget = typeof AccountTarget.Type;

export const AccountUseAction = Schema.Literals([
  "sign-in",
  "credentials",
  "request",
  "browser-session",
  "open-profile",
]);
export type AccountUseAction = typeof AccountUseAction.Type;

export const AccountActivityEntry = Schema.Struct({
  at: IsoDateTime,
  target: AccountTarget,
  action: AccountUseAction,
  decision: Schema.Literals(["allowed", "asked", "denied"]),
  outcome: Schema.optional(Schema.Literals(["ok", "error"])),
  signInOutcome: Schema.optional(AccountSignInOutcome),
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
  /** Safe summary such as a site or `GET api.example.com`; never values, queries or bodies. */
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type AccountActivityEntry = typeof AccountActivityEntry.Type;

export const AccountApprovalId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^apr_[A-Za-z0-9_-]{8,64}$/),
);

export const AccountApproval = Schema.Struct({
  approvalId: AccountApprovalId,
  target: AccountTarget,
  targetName: TrimmedNonEmptyString,
  action: AccountUseAction,
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  requestedAt: IsoDateTime,
});
export type AccountApproval = typeof AccountApproval.Type;

/** `project` and `always` change the target's controls, so the user is never asked twice. */
export const AccountApprovalDecision = Schema.Literals(["deny", "once", "project", "always"]);
export type AccountApprovalDecision = typeof AccountApprovalDecision.Type;

export const OnePasswordStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("not-connected") }),
  Schema.Struct({
    state: Schema.Literal("connected"),
    mode: Schema.Literals(["service-account", "desktop"]),
    /** Vault names for a service account; the account name for the desktop app. */
    label: TrimmedNonEmptyString,
    vaults: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: TrimmedNonEmptyString,
          name: TrimmedNonEmptyString,
          readOnly: Schema.Boolean,
        }),
      ),
    ),
  }),
  Schema.Struct({
    state: Schema.Literal("error"),
    mode: Schema.Literals(["service-account", "desktop"]),
    message: TrimmedNonEmptyString,
  }),
]);
export type OnePasswordStatus = typeof OnePasswordStatus.Type;

export const AccountStoresStatus = Schema.Struct({
  /** `file`: no system keychain on this host, so the store key sits in an owner-only file. */
  scient: Schema.Struct({ protection: Schema.Literals(["keychain", "file"]) }),
  keychain: Schema.Struct({
    available: Schema.Boolean,
    platform: Schema.Literals(["macos", "windows", "linux"]),
  }),
  onePassword: OnePasswordStatus,
  cli: Schema.optional(
    Schema.Struct({ bitwarden: CliPasswordStatus, "proton-pass": CliPasswordStatus }),
  ),
});
export type AccountStoresStatus = typeof AccountStoresStatus.Type;

/** Custom models connections whose key an API key account may use. */
export const AccountCustomModelKey = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  origin: Schema.optional(TrimmedNonEmptyString),
});
export type AccountCustomModelKey = typeof AccountCustomModelKey.Type;

export const AccountsSnapshot = Schema.Struct({
  /** Off turns every account and profile off for agents without changing their settings. */
  agentAccess: Schema.Boolean,
  accounts: Schema.Array(AccountSummary),
  profiles: Schema.Array(BrowserProfileRecord),
  stores: AccountStoresStatus,
  approvals: Schema.Array(AccountApproval),
  recentActivity: Schema.Array(AccountActivityEntry),
  customModelKeys: Schema.Array(AccountCustomModelKey),
  managedElsewhere: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["github", "custom-model"]),
        id: TrimmedNonEmptyString,
        name: TrimmedNonEmptyString,
        detail: Schema.optional(TrimmedNonEmptyString),
        href: Schema.Literals(["/settings/source-control", "/settings/custom-models"]),
      }),
    ),
  ),
});
export type AccountsSnapshot = typeof AccountsSnapshot.Type;

const SecretValue = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536));

/** How a save changes one secret field. Omitted fields are kept. */
export const AccountSecretInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("scient"),
    value: SecretValue,
    saveTo: Schema.optional(
      Schema.Array(AccountWriteStore).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("keychain"), service: KeychainName, account: KeychainName }),
  Schema.Struct({ type: Schema.Literal("1password"), reference: OnePasswordReference }),
  CliPasswordSource,
  Schema.Struct({ type: Schema.Literal("custom-model"), connectionId: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("clear") }),
]);
export type AccountSecretInput = typeof AccountSecretInput.Type;

export const AccountSaveInput = Schema.Struct({
  /** Omit to create. */
  accountId: Schema.optional(AccountId),
  name: AccountSummary.fields.name,
  details: AccountDetails,
  secrets: Schema.Record(AccountFieldKey, AccountSecretInput),
  /** Defaults to `defaultAccountControls(kind)` on create; kept on update. */
  controls: Schema.optional(AccountControls),
});
export type AccountSaveInput = typeof AccountSaveInput.Type;

export const AccountSaveResult = Schema.Struct({
  accountId: AccountId,
  warnings: Schema.optional(Schema.Array(Schema.String)),
});
export type AccountSaveResult = typeof AccountSaveResult.Type;

export const AccountRemoveInput = Schema.Struct({ accountId: AccountId });

export const AccountSetControlsInput = Schema.Struct({
  target: AccountTarget,
  access: Schema.optional(AccountAccess),
  permission: Schema.optional(AccountPermission),
  visibility: Schema.optional(AccountVisibility),
  scope: Schema.optional(GrantScope),
  /** Profiles only. */
  scriptSignIn: Schema.optional(Schema.Boolean),
});
export type AccountSetControlsInput = typeof AccountSetControlsInput.Type;

export const AccountsSetAgentAccessInput = Schema.Struct({ enabled: Schema.Boolean });

/** Sent by the client that imported or edited a profile; `null` clears a field. */
export const BrowserProfileRecordUpdateInput = Schema.Struct({
  profileId: BrowserProfileId,
  picture: Schema.optional(Schema.NullOr(ProfilePictureDataUri)),
  color: Schema.optional(Schema.NullOr(ProfileColor)),
  source: Schema.optional(Schema.NullOr(BrowserProfileSource)),
});
export type BrowserProfileRecordUpdateInput = typeof BrowserProfileRecordUpdateInput.Type;

export const BrowserProfileRecordRemoveInput = Schema.Struct({ profileId: BrowserProfileId });

export const AccountApprovalRespondInput = Schema.Struct({
  approvalId: AccountApprovalId,
  decision: AccountApprovalDecision,
});

export const AccountActivityInput = Schema.Struct({
  target: Schema.optional(AccountTarget),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(500)),
  ),
});

export const KeychainCandidate = Schema.Struct({
  service: KeychainName,
  account: KeychainName,
  label: Schema.optional(Schema.String),
});
export type KeychainCandidate = typeof KeychainCandidate.Type;

export const KeychainCandidatesInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
});

export const KeychainCandidatesResult = Schema.Struct({
  /** False where the platform cannot list item names; the user types service and account. */
  listed: Schema.Boolean,
  candidates: Schema.Array(KeychainCandidate),
});
export type KeychainCandidatesResult = typeof KeychainCandidatesResult.Type;

export const OnePasswordConnectInput = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("service-account"),
    token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)),
  }),
  Schema.Struct({ mode: Schema.Literal("desktop"), accountName: TrimmedNonEmptyString }),
]);
export type OnePasswordConnectInput = typeof OnePasswordConnectInput.Type;

export const PasswordImportFormat = Schema.Literals([
  "auto",
  "chrome",
  "safari",
  "firefox",
  "1password",
  "bitwarden",
  "keepass",
]);
export type PasswordImportFormat = typeof PasswordImportFormat.Type;

/** A password export file's text (CSV). The client reads the file; the server never sees its path. */
export const PasswordImportInput = Schema.Struct({
  format: PasswordImportFormat,
  content: Schema.String.check(Schema.isMaxLength(10_000_000)),
  profileId: Schema.optional(BrowserProfileId),
});
export type PasswordImportInput = typeof PasswordImportInput.Type;

export const PasswordImportResult = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  skipped: NonNegativeInt,
});
export type PasswordImportResult = typeof PasswordImportResult.Type;

/** The user's own sign-in on a page they are viewing; refused unless `origin` matches the account. */
export const AccountFillValuesInput = Schema.Struct({
  accountId: AccountId,
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});

export const AccountFillValues = Schema.Struct({
  username: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
  otp: Schema.optional(Schema.String),
});
export type AccountFillValues = typeof AccountFillValues.Type;

export const AccountMatchSignInInput = Schema.Struct({
  origin: AccountFillValuesInput.fields.origin,
  username: Schema.String.check(Schema.isMaxLength(256)),
  password: SecretValue,
  profileId: Schema.optional(BrowserProfileId),
});
export type AccountMatchSignInInput = typeof AccountMatchSignInInput.Type;
export const AccountMatchSignInResult = Schema.Struct({
  result: Schema.Literals(["new", "password-changed", "same"]),
  accountId: Schema.optional(AccountId),
});
export type AccountMatchSignInResult = typeof AccountMatchSignInResult.Type;

export const AccountsTestInput = Schema.Struct({ accountId: AccountId });

export class AccountsError extends Schema.TaggedError<AccountsError>()("AccountsError", {
  reason: Schema.Literals([
    "not-found",
    "invalid-input",
    "unavailable",
    "conflict",
    "unsupported",
    "denied",
  ]),
  message: TrimmedNonEmptyString,
}) {}
