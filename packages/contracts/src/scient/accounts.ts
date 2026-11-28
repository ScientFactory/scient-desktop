import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import {
  BROWSER_IMPORT_FAILURE_COPY,
  BrowserImportFailureReason,
  BrowserImportSourceId,
} from "../browserImport.ts";
import { BrowserProfileId } from "../browserProfile.ts";
import { PreviewTabId } from "../preview.ts";
import { SecretProviderId } from "../secretReference.ts";
import { isSecretReference } from "../settingsSecretValue.ts";
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

export const AccountKind = Schema.Literals(["website", "api-key", "database", "cli-login"]);
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
  visibility: kind === "website" ? "hidden" : "readable",
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
  /** Passwords only: when a sign-in with this value last worked. A new value starts without it. */
  verifiedAt: Schema.optional(IsoDateTime),
  /** Passwords only: when the browser it was imported from last changed it. */
  changedAt: Schema.optional(IsoDateTime),
  /** Passwords only: when a newer password replaced the one kept for recovery. */
  previousAt: Schema.optional(IsoDateTime),
  /**
   * Passwords only: when the site refused this value as Scient typed it. Bound to the value: a new
   * one starts without it, and only a sign-in where Scient types it again clears it.
   */
  refusedAt: Schema.optional(IsoDateTime),
  /**
   * Website passwords only: the login's earlier passwords, newest first, each usable again by its
   * `version` (`AccountRevealInput`, `AccountUsePasswordInput`). Older servers send none.
   */
  history: Schema.optional(
    Schema.Array(
      Schema.Struct({
        version: Schema.String,
        savedAt: Schema.optional(IsoDateTime),
        provenAt: Schema.optional(IsoDateTime),
        refused: Schema.optional(Schema.Literal(true)),
      }),
    ),
  ),
  /**
   * Website passwords only: each earlier password the person removed, its Undo
   * (`accounts.passwordVersions.restore`) open until `until`.
   */
  removedVersions: Schema.optional(
    Schema.Array(Schema.Struct({ undoId: Schema.String, until: IsoDateTime })),
  ),
  /** Backup codes only: how many are left unused. */
  left: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Backup codes only: kept one per line, a line one code; without it, split at any space. */
  lines: Schema.optional(Schema.Literal(true)),
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

const isAccountSite = Schema.is(AccountSite);

export function isCustomModelAccountOrigin(origin: string): boolean {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  return url.origin === origin && (url.protocol === "http:" || url.protocol === "https:");
}

export function isSpeechAccountOrigin(origin: string): boolean {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  return (
    url.origin === origin &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}

const HttpsUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https?:\/\//),
);

export const EnvironmentVariableName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
);

/** A university in the public directory of institutions that sign in to publishers. */
export const Institution = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  entityId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  domain: TrimmedNonEmptyString.check(Schema.isMaxLength(253)),
});
export type Institution = typeof Institution.Type;

const WebsiteFields = {
  sites: Schema.Array(AccountSite).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /** Where Scient starts a sign-in; defaults to the page the agent is on. */
  loginUrl: Schema.optional(HttpsUrl),
  username: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  /** Profile whose browser session holds this sign-in; the default profile otherwise. */
  profileId: Schema.optional(BrowserProfileId),
  /** The university this sign-in belongs to. */
  institution: Schema.optional(Institution),
  /** A library's link containing `{url}`, for a university outside the directory. */
  proxyUrl: Schema.optional(HttpsUrl.check(Schema.isIncluding("{url}"))),
  /** Recorded from a browser profile's session rather than typed in, so there is nothing to fill. */
  origin: Schema.optional(Schema.Literal("browser-session")),
  /**
   * The site keeps one session per account: a new sign-in ends the other one, the person's own
   * browser included. Scient then never signs in by itself; it asks the person.
   */
  oneSession: Schema.optional(Schema.Literal(true)),
} as const;

export const ApiKeyAuth = Schema.Union([
  Schema.Struct({ type: Schema.Literal("bearer") }),
  Schema.Struct({ type: Schema.Literal("header"), name: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("basic"), username: Schema.String }),
  Schema.Struct({ type: Schema.Literal("query"), name: TrimmedNonEmptyString }),
]);
export type ApiKeyAuth = typeof ApiKeyAuth.Type;

/** Whether a saved key's style is the one a use sends: the same type, and header or parameter. */
export function sameAuthStyle(saved: ApiKeyAuth, sent: ApiKeyAuth): boolean {
  if (saved.type === "header" || saved.type === "query")
    return sent.type === saved.type && sent.name.toLowerCase() === saved.name.toLowerCase();
  return sent.type === saved.type;
}

export const CliLoginTool = Schema.Literals(["gh", "glab", "wrangler", "aws", "gcloud", "other"]);
export type CliLoginTool = typeof CliLoginTool.Type;

export const CliLoginVariable = Schema.Struct({
  name: EnvironmentVariableName,
  /** Secret variables keep their value in `secrets[name]`; others carry it here. */
  secret: Schema.Boolean,
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type CliLoginVariable = typeof CliLoginVariable.Type;

/** Ways to a paper behind a subscription. */
export const PaperRoute = Schema.Literals(["publisher", "university", "library"]);
export type PaperRoute = typeof PaperRoute.Type;

/** Where a key Scient kept from a removed agent came from, so adding one like it can offer it. */
export const AccountKeptFrom = Schema.Struct({
  /** The agent: its driver, or `acpRegistry:<agentId>` for an ACP Registry agent. */
  agent: TrimmedNonEmptyString,
  /** The environment variable, or `config.<field>` for a key in the agent's settings. */
  setting: TrimmedNonEmptyString,
});
export type AccountKeptFrom = typeof AccountKeptFrom.Type;

/** `AccountKeptFrom.agent` for a provider instance: two ACP Registry agents are different agents. */
export function keptAgentOf(instance: { readonly driver: string; readonly config?: unknown }) {
  const config = instance.config;
  const agentId =
    instance.driver === "acpRegistry" && config !== null && typeof config === "object"
      ? (config as { readonly agentId?: unknown }).agentId
      : undefined;
  return typeof agentId === "string" && agentId ? `acpRegistry:${agentId}` : instance.driver;
}

/**
 * A key kept for one use only, as a typed key was: never listed to agents, read or bound
 * elsewhere. Older builds drop the field, so these rows are also saved Off and hidden.
 */
export const AccountPrivateUse = Schema.Struct({
  kind: Schema.Literals(["connector", "text-generator"]),
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type AccountPrivateUse = typeof AccountPrivateUse.Type;

/** What the account is; secret values are held separately under `secrets`. */
export const AccountDetails = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("website"), ...WebsiteFields }),
  Schema.Struct({
    kind: Schema.Literal("api-key"),
    sites: Schema.Array(Schema.String.check(Schema.isMaxLength(253))).check(Schema.isMaxLength(16)),
    auth: ApiKeyAuth,
    /** Variable name scripts read the key from, e.g. HF_TOKEN. */
    envName: Schema.optional(EnvironmentVariableName),
    keptFrom: Schema.optional(AccountKeptFrom),
    speechOnly: Schema.optional(Schema.Boolean),
    purpose: Schema.optional(Schema.Literal("custom-models")),
    privateTo: Schema.optional(AccountPrivateUse),
  }).check(
    Schema.makeFilter(
      ({ speechOnly, purpose, sites }) =>
        (purpose === "custom-models"
          ? !speechOnly && sites.length > 0 && sites.every(isCustomModelAccountOrigin)
          : sites.every(
              (site) =>
                isAccountSite(site) ||
                // Existing speech rows must still load so their sites can be corrected.
                (speechOnly === true &&
                  (isSpeechAccountOrigin(site) ||
                    /^http:\/\/localhost(?::[0-9]{1,5})?$/.test(site))),
            )) || "Use valid sites for API-key accounts.",
    ),
  ),
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
  website: ["password", "totp", "recovery"],
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
  "limited",
  "failed",
]);
export type AccountSignInOutcome = typeof AccountSignInOutcome.Type;

/**
 * Where an account's sign-in stands. Besides `signed-in`, a sign-in attempt ends in `needs-you`,
 * `password-rejected`, `code-rejected`, `limited` or `failed`; looking at the site finds
 * `signed-in`, `signed-out` or `unknown`, and can also find `limited` or a session that keeps
 * ending (`needs-you`). A refused API key is `failed`, with the service's answer in `detail`.
 */
export const AccountSignInState = Schema.Literals([
  "signed-in",
  "signed-out",
  "needs-you",
  "password-rejected",
  "code-rejected",
  "limited",
  "failed",
  "unknown",
]);
export type AccountSignInState = typeof AccountSignInState.Type;

/** What Scient last tried or saw of this sign-in, and when. */
export const AccountSignIn = Schema.Struct({
  state: AccountSignInState,
  at: IsoDateTime,
  detail: Schema.optional(TrimmedNonEmptyString),
  /**
   * `action`: something signed in or tried to (Scient, a recording, Google showing a new account).
   * `look`: Scient only looked (Check, an agent's page, a quiet visit, an import). Absent on old rows.
   */
  by: Schema.optional(Schema.Literals(["action", "look"])),
  /**
   * An `unknown` row made from another browser's import, or copied into Main from another profile,
   * not yet seen on the site. Any later look or attempt replaces it.
   */
  from: Schema.optional(Schema.Literals(["import", "copy"])),
  /** Failed attempts in a row, which space out the next automatic one. Absent means one. */
  failures: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * With `unknown`: the site couldn't be reached from this computer (network, VPN, the site down),
   * which says nothing about the sign-in. Older builds show it as a check that couldn't tell.
   */
  unreachable: Schema.optional(Schema.Literal(true)),
});
export type AccountSignIn = typeof AccountSignIn.Type;

export const AccountSummary = Schema.Struct({
  accountId: AccountId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  details: AccountDetails,
  secrets: Schema.Record(AccountFieldKey, AccountSecretSummary),
  controls: AccountControls,
  status: AccountStatus,
  /** Set only when something is wrong. */
  statusMessage: Schema.optional(TrimmedNonEmptyString),
  signIn: Schema.optional(AccountSignIn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastUsedAt: Schema.optional(IsoDateTime),
});
export type AccountSummary = typeof AccountSummary.Type;

/** An account name from any label: Accounts keeps at most 80 characters. */
export const accountName = (label: string) => label.trim().slice(0, 80).trim() || "Key";

/**
 * Whether a key saved for `sites` may go to `origin`: listed exactly, or listed by its bare host
 * when `origin` is that host over `https://` on the default port.
 */
export function keyServesOrigin(sites: ReadonlyArray<string>, origin: string): boolean {
  if (sites.includes(origin)) return true;
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  return url.protocol === "https:" && url.origin === origin && !url.port
    ? sites.includes(url.hostname)
    : false;
}

/** Whether Voice can send this key to a speech endpoint at `origin`: a sealed Bearer key for it. */
export function acceptsSpeechKey(
  account: Pick<AccountSummary, "details" | "secrets">,
  origin: string,
): boolean {
  const { details, secrets } = account;
  return (
    details.kind === "api-key" &&
    keyServesUse(account, { kind: "voice", id: "" }) &&
    details.auth.type === "bearer" &&
    isSpeechAccountOrigin(origin) &&
    keyServesOrigin(details.sites, origin) &&
    secrets.token?.source.type === "scient"
  );
}

/** Who is about to read or bind a key: a kind of use, and which one (empty when any). */
export interface KeyUser {
  readonly kind: AccountKeyUse["kind"];
  readonly id: string;
}

/**
 * The one rule for which uses a key may serve. A key kept for one use serves that use only; a
 * legacy Voice-only key serves Voice and an agent's own authorized use; any other key serves all.
 */
export function keyServesUse(account: Pick<AccountSummary, "details">, use: KeyUser): boolean {
  const { details } = account;
  if (details.kind !== "api-key") return false;
  if (details.privateTo)
    return details.privateTo.kind === use.kind && details.privateTo.id === use.id;
  if (details.speechOnly) return use.kind === "voice" || use.kind === "request";
  return true;
}

/**
 * Whether agents may use this key in every project: what a use that serves all projects at once
 * (a provider's variables, a background pass) needs, since it can't enforce a narrower scope.
 */
export function agentsMayUseEverywhere(
  account: Pick<AccountSummary, "controls">,
  agentAccess: boolean,
): boolean {
  return (
    agentAccess &&
    account.controls.access !== "off" &&
    account.controls.scope.type === "all-projects"
  );
}

/** Metadata eligibility for a server-owned Custom models credential. */
export function acceptsCustomModelKey(
  account: Pick<AccountSummary, "details" | "secrets">,
  origin: string,
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages",
): boolean {
  const { details, secrets } = account;
  return (
    details.kind === "api-key" &&
    keyServesUse(account, { kind: "custom-model", id: "" }) &&
    isCustomModelAccountOrigin(origin) &&
    keyServesOrigin(details.sites, origin) &&
    secrets.token?.source.type === "scient" &&
    (protocol === "anthropic-messages"
      ? details.auth.type === "header" && details.auth.name.toLowerCase() === "x-api-key"
      : details.auth.type === "bearer")
  );
}

/** One use of a key, as Used by and refusals name it. */
export const AccountKeyUse = Schema.Struct({
  kind: Schema.Literals([
    "connector",
    "plugin",
    "custom-model",
    "voice",
    "text-generator",
    "request",
    "library",
    "variable",
    "local-connector",
  ]),
  id: TrimmedNonEmptyString,
});
export type AccountKeyUse = typeof AccountKeyUse.Type;

/** A use whose provider refused the key as it is now; never the key. */
export const AccountKeyRefusal = Schema.Struct({
  accountId: AccountId,
  use: AccountKeyUse,
  at: IsoDateTime,
});
export type AccountKeyRefusal = typeof AccountKeyRefusal.Type;

/** A text generator's key, when it names an Accounts key rather than holding one. */
const ACCOUNTS_KEY_PROVIDER = "scient-accounts";

export const accountKeyReference = (accountId: AccountId) => ({
  provider: SecretProviderId.make(ACCOUNTS_KEY_PROVIDER),
  reference: accountId,
});

// A person may have named a secret provider "scient-accounts"; its references are `op://…`.
const isAccountIdText = Schema.is(AccountId);

export function referencedAccountId(value: unknown): AccountId | undefined {
  return isSecretReference(value) &&
    value.provider === ACCOUNTS_KEY_PROVIDER &&
    isAccountIdText(value.reference)
    ? value.reference
    : undefined;
}

/**
 * Whether a text generator of `kind` at `baseUrl` can send this key, in the header it uses. A
 * generator writes for every project, so a key limited to some projects never fits.
 */
export function acceptsTextGeneratorKey(
  account: Pick<AccountSummary, "details" | "secrets" | "controls">,
  generator: {
    readonly id: string;
    readonly baseUrl: string;
    readonly kind: "openaiCompatible" | "anthropic";
  },
): boolean {
  const { details, secrets } = account;
  const { baseUrl, kind } = generator;
  return (
    details.kind === "api-key" &&
    keyServesUse(account, { kind: "text-generator", id: generator.id }) &&
    URL.canParse(baseUrl) &&
    keyServesOrigin(details.sites, new URL(baseUrl).origin) &&
    secrets.token !== undefined &&
    account.controls.scope.type === "all-projects" &&
    (kind === "anthropic"
      ? details.auth.type === "header" && details.auth.name.toLowerCase() === "x-api-key"
      : details.auth.type === "bearer")
  );
}

/** A small square picture as an inline PNG/JPEG/WebP; clients never load remote images. */
export const ProfilePictureDataUri = Schema.String.check(
  Schema.isMaxLength(90_000),
  Schema.isPattern(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u),
);
export type ProfilePictureDataUri = typeof ProfilePictureDataUri.Type;

export const ProfileColor = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i));

/** The desktop a report comes from: its own server's environment id and the name it shows. */
export const ReportingComputer = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type ReportingComputer = typeof ReportingComputer.Type;

export const BrowserProfileSource = Schema.Struct({
  browser: BrowserImportSourceId,
  profileName: TrimmedNonEmptyString,
  /** The source profile's folder; unlike its name, it survives a rename in that browser. */
  directory: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
  /** The desktop it is on: a refresh never takes another computer's folder of the same name. */
  computer: Schema.optional(ReportingComputer),
  importedAt: IsoDateTime,
});
export type BrowserProfileSource = typeof BrowserProfileSource.Type;

/** The sites of one unit a copy moves whole: a registrable site, or one multi-site sign-in's. */
export const SessionUnitSites = Schema.Array(
  TrimmedNonEmptyString.check(Schema.isMaxLength(253)),
).check(Schema.isMinLength(1), Schema.isMaxLength(50));

/** A desktop revision: one counter per profile that only grows; times are only labels. */
const SessionRevision = NonNegativeInt;

/**
 * The desktop's record of the actions other computers must follow, newest per unit. An action
 * takes the next revision in the same commit that records it; `jar` covers the whole jar.
 */
export const ProfileSendLog = Schema.Struct({
  head: SessionRevision,
  jar: Schema.optional(SessionRevision),
  units: Schema.Array(
    Schema.Struct({
      sites: SessionUnitSites,
      revision: SessionRevision,
      kind: Schema.Literals(["copy", "delete"]),
      /** A delete that takes back only this computer's copy, while it still holds what it wrote. */
      copyOnly: Schema.optional(Schema.Literal(true)),
    }),
  ),
  /** When the profile stopped being shareable, so other computers drop its copies. */
  withdrawn: Schema.optional(SessionRevision),
});
export type ProfileSendLog = typeof ProfileSendLog.Type;

const ComputerLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

/** On the desktop: what another computer has applied of this profile, names and numbers only. */
export const ProfileSharedWith = Schema.Struct({
  environmentId: EnvironmentId,
  label: ComputerLabel,
  sentAt: Schema.optional(IsoDateTime),
  seenAt: Schema.optional(IsoDateTime),
  /** The highest revision with nothing lower still waiting. */
  applied: SessionRevision,
  waiting: NonNegativeInt,
  /** Units the remote kept with its own sign-in on the first delivery. */
  kept: Schema.optional(NonNegativeInt),
  needsYou: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(253))).check(
    Schema.isMaxLength(50),
  ),
});
export type ProfileSharedWith = typeof ProfileSharedWith.Type;

export const ReceivedUnitOutcome = Schema.Literals(["copied", "same", "kept", "deleted"]);

/** On a remote: one unit applied from a sender, and whether its copy was refused there. */
export const ReceivedUnit = Schema.Struct({
  sites: SessionUnitSites,
  revision: SessionRevision,
  outcome: ReceivedUnitOutcome,
  needsYou: Schema.optional(IsoDateTime),
  /** A digest of exactly the cookies the copy wrote; never sent to clients. */
  fingerprint: Schema.optional(TrimmedNonEmptyString),
});
export type ReceivedUnit = typeof ReceivedUnit.Type;

/** On a remote: the copies of one sender, the desktop its key proves. */
/** The controls a desktop sends with a profile; a project limit arrives as Off. */
export const SentProfileControls = Schema.Struct({
  access: AccountAccess,
  scope: GrantScope,
  scriptSignIn: Schema.Boolean,
});
export type SentProfileControls = typeof SentProfileControls.Type;

export const ProfileReceived = Schema.Struct({
  source: EnvironmentId,
  label: ComputerLabel,
  sentAt: IsoDateTime,
  withdrawn: Schema.optional(SessionRevision),
  units: Schema.Array(ReceivedUnit).check(Schema.isMaxLength(5_000)),
  /** The controls this sender last set; the profile follows the strictest of its senders'. */
  controls: Schema.optional(SentProfileControls),
});
export type ProfileReceived = typeof ProfileReceived.Type;

const FoldedProfileName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

/** What only Main keeps. */
export const MainProfileState = Schema.Struct({
  /**
   * Sites the user signed out of with Accounts' Sign out, which an import or back-fill never
   * copies back. A sign-in seen in Main clears its site.
   */
  signedOutSites: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** Each Sign out of Main counts one: a refresh decided before the latest is stopped (6j). */
  signOuts: Schema.optional(NonNegativeInt),
  /** The profiles whose sessions have been copied into Main once, in this environment. */
  backfilled: Schema.optional(Schema.Array(BrowserProfileId)),
  /** When profiles made in Scient were merged into Main, once, and the names of those merged. */
  folded: Schema.optional(
    Schema.Struct({
      at: IsoDateTime,
      profiles: Schema.Array(FoldedProfileName).check(Schema.isMaxLength(64)),
    }),
  ),
});
export type MainProfileState = typeof MainProfileState.Type;

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
  /**
   * When Scient made the profile; one imported or made elsewhere has none. The fold into Main
   * takes a profile with it even when another browser has a profile of the same name.
   */
  madeInScient: Schema.optional(IsoDateTime),
  /**
   * Merged into Main by the one-time fold: hidden and unused everywhere, its jar kept as it was.
   * `name` is what the client listed it as, for the line that offers Undo.
   */
  retired: Schema.optional(
    Schema.Struct({ at: IsoDateTime, into: Schema.Literal("main"), name: FoldedProfileName }),
  ),
  /** When Undo brought it back from Main; such a profile is never merged again. */
  undone: Schema.optional(IsoDateTime),
  /** When what binds agents last changed (controls, retirement): the version an agent writes at. */
  updatedAt: Schema.optional(IsoDateTime),
  /** The name a client last listed it under, so agents and other clients see it (protocol 2). */
  name: Schema.optional(FoldedProfileName),
  /**
   * The browser data in use: 0 (absent) is the profile's first; Clear moves to a new one, kept apart
   * from the old, which Undo can go back to for the hour.
   */
  generation: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * Removed, with Undo for the hour: hidden from every client and agent, its data left as it was
   * until `until`, then purged (`purgedAt`). A record so marked is never used again.
   */
  /** Round 6l: this server's browser can't open it until the server starts again. Never stored. */
  unavailable: Schema.optional(Schema.Literal(true)),
  removed: Schema.optional(
    Schema.Struct({
      at: IsoDateTime,
      operationId: TrimmedNonEmptyString,
      until: IsoDateTime,
      name: Schema.optional(FoldedProfileName),
      purgedAt: Schema.optional(IsoDateTime),
    }),
  ),
  /** Generations Clear or its Undo left, kept for Undo until `until`, then purged. */
  retained: Schema.optional(
    Schema.Array(
      Schema.Struct({
        generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        until: IsoDateTime,
        purgedAt: Schema.optional(IsoDateTime),
      }),
    ),
  ),
  /** Main's own record; no other profile has one. */
  main: Schema.optional(MainProfileState),
  /** On the desktop: the actions other computers follow. */
  send: Schema.optional(ProfileSendLog),
  /** On the desktop: the other computers this profile's sign-ins go to. */
  sharedWith: Schema.optional(Schema.Array(ProfileSharedWith)),
  /** On a remote: copies received from desktops; their controls are set there. */
  received: Schema.optional(Schema.Array(ProfileReceived).check(Schema.isMaxLength(4))),
});
export type BrowserProfileRecord = typeof BrowserProfileRecord.Type;

/** A partitioned cookie's key as the browser stored it; the ancestor bit is never derived. */
export const CookiePartitionKey = Schema.Struct({
  topLevelSite: Schema.String,
  hasCrossSiteAncestor: Schema.Boolean,
});
export type CookiePartitionKey = typeof CookiePartitionKey.Type;

const sessionCookieFields = {
  name: Schema.String,
  value: Schema.String,
  /** Chromium form: `.github.com` for a domain cookie, `github.com` for a host-only one. */
  domain: Schema.String,
  hostOnly: Schema.Boolean,
  path: Schema.String,
  secure: Schema.Boolean,
  httpOnly: Schema.Boolean,
  sameSite: Schema.Literals(["unspecified", "no_restriction", "lax", "strict"]),
  /** Unix seconds; absent for a cookie that ends with the browser. */
  expires: Schema.optional(Schema.Number),
  partitionKey: Schema.optional(CookiePartitionKey),
};
const hostOnlyMatchesDomain = Schema.makeFilter(
  (cookie: { readonly hostOnly: boolean; readonly domain: string }) =>
    cookie.hostOnly === !cookie.domain.startsWith("."),
);

/** One cookie with every attribute a copy between jars must keep. */
export const SessionCookie = Schema.Struct(sessionCookieFields).check(hostOnlyMatchesDomain);
export type SessionCookie = typeof SessionCookie.Type;

/** A session cookie sent to another computer: its value is redacted wherever it is decoded. */
export const SentSessionCookie = Schema.Struct({
  ...sessionCookieFields,
  value: Schema.RedactedFromValue(Schema.String),
}).check(hostOnlyMatchesDomain);
export type SentSessionCookie = typeof SentSessionCookie.Type;

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
  /** A password the user typed while Scient signed them in: kept, or left for its linked store. */
  keptTyped: Schema.optional(Schema.Literals(["kept", "linked"])),
});
export type AccountActivityEntry = typeof AccountActivityEntry.Type;

/**
 * A change an agent made to an account or profile (AMENDMENTS 56), kept apart from Activity: its
 * action list is closed, and an older client rejects a kind it doesn't know.
 */
export const AccountChange = Schema.Struct({
  at: IsoDateTime,
  target: AccountTarget,
  change: Schema.Literals([
    "edit",
    "controls",
    "remove",
    "restore",
    "save-offer",
    "clear",
    "sign-out",
    "copy",
    "move",
    "merge",
    "fold",
    "refresh",
  ]),
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
  /** Safe summary such as a new name; never values. */
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type AccountChange = typeof AccountChange.Type;

/**
 * A browser profile on a desktop that Scient can import from (AMENDMENTS 58): which browser and
 * folder, what the browser calls it, and the Scient profile it is linked to. Never a cookie,
 * password or history.
 */
export const BrowserSourceProfile = Schema.Struct({
  browser: BrowserImportSourceId,
  directory: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  name: FoldedProfileName,
  email: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(254))),
  linkedTo: Schema.optional(BrowserProfileId),
});
export type BrowserSourceProfile = typeof BrowserSourceProfile.Type;

/**
 * Whether a profile's link names this browser profile (round 6i): the one rule reports, admission
 * and commits all go by. By folder where both have one; a link made before folders were kept, by
 * the browser's name for it. A link or profile that names no desktop matches any.
 */
export const linksBrowserProfile = (
  link: Pick<BrowserProfileSource, "browser" | "profileName" | "directory" | "computer">,
  profile: {
    readonly browser: string;
    readonly name: string;
    readonly directory?: string | undefined;
    readonly computerId?: string | undefined;
  },
) =>
  link.browser === profile.browser &&
  (link.computer === undefined ||
    profile.computerId === undefined ||
    link.computer.id === profile.computerId) &&
  (link.directory && profile.directory
    ? link.directory === profile.directory
    : link.profileName === profile.name);

/**
 * Why an import or refresh from a browser profile failed (round 6d): the browser's own reason, or
 * one of Accounts', each with the one thing to do about it.
 */
export const ProfileImportCause = Schema.Literals([
  ...BrowserImportFailureReason.literals,
  "notLinked",
  "managedPolicy",
  "passwordsUnreadable",
  "passwordsNotSaved",
  "stopped",
]);
export type ProfileImportCause = typeof ProfileImportCause.Type;

/** Each cause in English, with the one action it needs; the app translates its own. */
export const PROFILE_IMPORT_CAUSE_COPY: Readonly<Record<ProfileImportCause, string>> = {
  ...BROWSER_IMPORT_FAILURE_COPY,
  notLinked: "It isn't linked to a browser profile: import from one of its sources.",
  managedPolicy: "This computer's managed policy doesn't allow importing browser cookies.",
  passwordsUnreadable:
    "The browser's passwords couldn't be read. Allow access if the computer asks, then try again.",
  passwordsNotSaved: "The passwords were read but couldn't be saved. Try again.",
  stopped:
    "The profile or agent access changed meanwhile, so it stopped. What it brought in stays.",
};

/** What one store of a profile (this server's browser, or the desktop's) did for an operation. */
export const ProfileStoreOutcome = Schema.Struct({
  state: Schema.Literals(["pending", "done", "failed"]),
  /** Sign-out: cookies kept for Undo, and those the browser didn't give back (not restorable). */
  saved: Schema.optional(Schema.Int),
  notRestorable: Schema.optional(Schema.Int),
  /** Undo of a sign-out: cookies set back, and those the browser refused. */
  restored: Schema.optional(Schema.Int),
  refused: Schema.optional(Schema.Int),
  /** Copy, move, merge: cookies copied, and the sites that couldn't be. */
  copied: Schema.optional(Schema.Int),
  uncovered: Schema.optional(Schema.Array(Schema.String)),
  /** Undo: cookies left as they are, set again since (a newer sign-in), not put back. */
  newer: Schema.optional(Schema.Int),
  /** Sign-out: cookies it couldn't reach (an opaque partition), still there (round 6d). */
  leftBehind: Schema.optional(Schema.Int),
  /** Import or refresh: why it failed, and the passwords it saved (round 6d). */
  cause: Schema.optional(ProfileImportCause),
  passwords: Schema.optional(Schema.Int),
});
export type ProfileStoreOutcome = typeof ProfileStoreOutcome.Type;

export const ProfileOperationId = TrimmedNonEmptyString.check(Schema.isMaxLength(100));

/**
 * A profile's Remove, Clear or site sign-out, by the person or an agent, with the Undo the person
 * gets: its receipt, per store, kept for the hour. A retry with the same id gets this receipt.
 */
/** Another desktop's part of a sign-out: its own jar of the profile (round 6d). */
const OtherDesktopPart = Schema.Struct({
  computer: ReportingComputer,
  outcome: ProfileStoreOutcome,
});

export const ProfileOperation = Schema.Struct({
  operationId: ProfileOperationId,
  kind: Schema.Literals([
    "remove",
    "clear",
    "sign-out",
    "copy",
    "move",
    "merge",
    "fold",
    "refresh",
  ]),
  profileId: BrowserProfileId,
  name: Schema.optional(FoldedProfileName),
  site: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(253))),
  /** Copy, move, merge and fold: the profile the sign-ins go to (Main for a fold). */
  into: Schema.optional(BrowserProfileId),
  /** Copy and move: the sites chosen; merge and fold take every one. */
  sites: Schema.optional(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(253)))),
  /** Sites a store couldn't copy; a merge then keeps its source. */
  uncovered: Schema.optional(Schema.Array(Schema.String)),
  /** Logins copied as new rows in `into`, which Undo removes. */
  rowsAdded: Schema.optional(Schema.Array(AccountId)),
  /** Each added row's version when added: Undo keeps a row edited since. */
  rowsAddedAt: Schema.optional(Schema.Array(Schema.String)),
  /** The profile's data (generation) when it was done, and the destination's: Undo needs both. */
  generation: Schema.optional(Schema.Int),
  intoGeneration: Schema.optional(Schema.Int),
  /** The profiles' versions it was decided at: its work stops if either changed (round 6c). */
  fromVersion: Schema.optional(Schema.String),
  intoVersion: Schema.optional(Schema.String),
  /** A sign-out: each other desktop linked to this computer signs its own jar out too. */
  others: Schema.optional(Schema.Array(OtherDesktopPart)),
  /** Why its work stopped before it began: a profile or an agent's access changed meanwhile. */
  stopped: Schema.optional(Schema.String),
  /** A merge retired its source: every site was copied. */
  retiredSource: Schema.optional(Schema.Boolean),
  /** Refresh from the linked browser profile: what was chosen to bring, sign-ins and passwords. */
  cookies: Schema.optional(Schema.Boolean),
  passwords: Schema.optional(Schema.Boolean),
  /** An import from a browser profile by its source: the desktop it is on carries it out. */
  computer: Schema.optional(ReportingComputer),
  /** The import made this profile. An import or refresh has no Undo (round 6m). */
  madeProfile: Schema.optional(Schema.Boolean),
  /**
   * An agent's call, as its retries name it (round 6e): kept apart from the operation's id, which
   * is fresh for every new request, so no id is ever used for two.
   */
  requestKey: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
  /**
   * An import by source: the link it makes once it has succeeded (round 6d), whether it did, and
   * the link it replaced.
   */
  link: Schema.optional(BrowserProfileSource),
  linked: Schema.optional(Schema.Boolean),
  /** A refresh of Main: Main's sign-out count when it was decided (round 6j). */
  mainSignOuts: Schema.optional(NonNegativeInt),
  at: IsoDateTime,
  until: IsoDateTime,
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
  /** Clear: the generation it left and the one it opened. */
  from: Schema.optional(Schema.Int),
  to: Schema.optional(Schema.Int),
  server: Schema.optional(ProfileStoreOutcome),
  desktop: Schema.optional(ProfileStoreOutcome),
  undone: Schema.optional(
    Schema.Struct({
      at: IsoDateTime,
      /** Clear: the sign-ins made since, kept in the generation Undo left. */
      conflicts: Schema.optional(Schema.Array(Schema.String)),
      server: Schema.optional(ProfileStoreOutcome),
      desktop: Schema.optional(ProfileStoreOutcome),
      others: Schema.optional(Schema.Array(OtherDesktopPart)),
    }),
  ),
});
export type ProfileOperation = typeof ProfileOperation.Type;

export const ProfileOperateInput = Schema.Struct({
  operationId: ProfileOperationId,
  kind: ProfileOperation.fields.kind,
  profileId: BrowserProfileId,
  site: ProfileOperation.fields.site,
  into: ProfileOperation.fields.into,
  cookies: ProfileOperation.fields.cookies,
  passwords: ProfileOperation.fields.passwords,
  /** Import: the source (`sources` id) to bring, into `profileId`, or a new profile when unknown. */
  sourceId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(400))),
  requestKey: ProfileOperation.fields.requestKey,
  sites: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(253))).check(
      Schema.isMaxLength(100),
    ),
  ),
});
export type ProfileOperateInput = typeof ProfileOperateInput.Type;

/** The receipt, or why nothing was done: tabs open in it (their chats) or a sign-in under way. */
export const ProfileOperateResult = Schema.Struct({
  operation: Schema.optional(ProfileOperation),
  refused: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["open-tabs", "signing-in", "not-allowed", "widens"]),
      message: Schema.String,
      threadIds: Schema.optional(Schema.Array(ThreadId)),
    }),
  ),
});
export type ProfileOperateResult = typeof ProfileOperateResult.Type;

export const ProfileUndoInput = Schema.Struct({ operationId: ProfileOperationId });

/** The desktop's part of an operation or its Undo, as the owner window carried it out. */
export const ProfileStoreDoneInput = Schema.Struct({
  operationId: ProfileOperationId,
  /** Which desktop's part: another desktop's, of a sign-out (round 6d); else the desktop's. */
  computer: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
  phase: Schema.Literals(["do", "undo"]),
  outcome: ProfileStoreOutcome,
});
export type ProfileStoreDoneInput = typeof ProfileStoreDoneInput.Type;

/**
 * A desktop asks before carrying out its part, and again before it writes: only the desktop it is
 * for, only one, and only while what it was decided on still stands (round 6c).
 */
export const ProfileClaimInput = Schema.Struct({
  operationId: ProfileOperationId,
  phase: Schema.Literals(["do", "undo"]),
  /** This desktop's computer id, as its profile report names it. */
  computer: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
});
export type ProfileClaimInput = typeof ProfileClaimInput.Type;
export const ProfileClaimResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String),
});
export type ProfileClaimResult = typeof ProfileClaimResult.Type;

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
  /** The item is Off for agents: the person's answer turns it on (`always`, `project`, `once`). */
  turnOn: Schema.optional(Schema.Literal(true)),
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

export const AccountHandoff = Schema.Struct({
  handoffId: TrimmedNonEmptyString,
  threadId: ThreadId,
  accountId: AccountId,
  accountName: TrimmedNonEmptyString,
  site: TrimmedNonEmptyString,
  /** The sign-in's browser tab, shown live in the conversation. */
  tabId: Schema.optional(TrimmedNonEmptyString),
  kind: Schema.Literals(["push", "captcha", "passkey", "code", "other"]),
  number: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{1,3}$/))),
  /** How the factor reaches the person: a hardware key for `passkey`, a text for `code`. */
  via: Schema.optional(Schema.Literals(["security-key", "text"])),
  /** Why an agent asked the user to sign in here. */
  reason: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  /** Codes found for this step that weren't certain enough to insert alone: one click inserts. */
  codes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        codeId: TrimmedNonEmptyString,
        source: Schema.Literals(["messages", "mail"]),
        at: IsoDateTime,
        /** Who sent a code that names no service, or one others share: the person tells. */
        from: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
      }),
    ),
  ),
  /** A saved password Scient didn't type: the person can have it typed (its username, or ""). */
  useSaved: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  /** The card's Use saved, bound to the page it shows: a click sends it, and a newer card ends it. */
  useSavedRevision: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  /** The login has backup codes: one tap types the next (`BACKUP_CODE_ID`), never on its own. */
  backupCodes: Schema.optional(Schema.Literal(true)),
  /** The site refused the password last tried in this tab, the person's or Scient's. */
  refused: Schema.optional(Schema.Literal("password")),
  /** The page lists accounts, none of them the saved one: the person picks. */
  choose: Schema.optional(Schema.Literal("account")),
  /** The page shows nothing at all: it never loaded, so it is not a step to finish there. */
  notLoaded: Schema.optional(Schema.Literal(true)),
  startedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type AccountHandoff = typeof AccountHandoff.Type;

/** A sign-in under way in a tab: Scient typing, a person finishing, or waiting for a second factor. */
export const AccountSignInAttempt = Schema.Struct({
  attemptId: TrimmedNonEmptyString,
  threadId: ThreadId,
  tabId: PreviewTabId,
  accountId: AccountId,
  state: Schema.Literals(["typing", "person", "pending"]),
  /** The tab's profile: none of its sessions leaves it while the attempt lasts. */
  profileId: Schema.optional(BrowserProfileId),
});
export type AccountSignInAttempt = typeof AccountSignInAttempt.Type;

/** How the person's last sign-in to a row ended, kept for the server's life. No values. */
export const AccountSignInEnd = Schema.Struct({
  accountId: AccountId,
  outcome: Schema.Literals(["signed-in", "needs-you", "cancelled", "failed", "timed-out"]),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  at: IsoDateTime,
});
export type AccountSignInEnd = typeof AccountSignInEnd.Type;

export const AccountHandoffCancelInput = Schema.Struct({ handoffId: TrimmedNonEmptyString });
export const AccountHandoffUseSavedInput = Schema.Struct({
  handoffId: TrimmedNonEmptyString,
  /** The `useSavedRevision` of the card clicked. */
  revision: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});

/**
 * Something only the person can do, kept until it's done or they dismiss it: one per item, so it is
 * asked once. `needId` names the item (`sign-in:<accountId>`); a newer entry for it replaces the old.
 */
export const AccountNeedsYou = Schema.Struct({
  needId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** What it is about, such as the account's name. */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  /** What to do, in a few words. */
  detail: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** What answers it: signing in, allowing a use in its chat, or saving what a card asked for. */
  action: Schema.optional(Schema.Literals(["sign-in", "allow", "save"])),
  accountId: Schema.optional(AccountId),
  /** The chat it came from, when there is one. */
  threadId: Schema.optional(ThreadId),
  since: IsoDateTime,
});
export type AccountNeedsYou = typeof AccountNeedsYou.Type;
export const AccountNeedsYouDismissInput = Schema.Struct({ needId: TrimmedNonEmptyString });
/** The code id that asks for the login's next backup code instead of a found one. */
export const BACKUP_CODE_ID = "backup";
export const AccountHandoffInsertCodeInput = Schema.Struct({
  handoffId: TrimmedNonEmptyString,
  /** A found code's id, or `BACKUP_CODE_ID`. */
  codeId: TrimmedNonEmptyString,
});

/**
 * Which browser profile a tab opens in, as the user chose it: per project, and per conversation
 * (its profile and, per site, the profile the user switched that site's tab to).
 */
export const BrowserProfileChoices = Schema.Struct({
  projects: Schema.Record(ProjectId, BrowserProfileId),
  threads: Schema.Record(
    ThreadId,
    Schema.Struct({
      /** Absent while only sites were chosen; the project's profile then applies. */
      profileId: Schema.optional(BrowserProfileId),
      sites: Schema.Record(
        Schema.String,
        Schema.Struct({ profileId: BrowserProfileId, at: IsoDateTime }),
      ),
    }),
  ),
});
export type BrowserProfileChoices = typeof BrowserProfileChoices.Type;

export const BrowserProfileChoiceInput = Schema.Union([
  /**
   * The user switched a conversation's tab to this profile, on this page's site. Null clears the
   * conversation's own profile so the project's applies; its site switches stay.
   */
  Schema.Struct({
    threadId: ThreadId,
    profileId: Schema.NullOr(BrowserProfileId),
    url: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
    /** Only this page's site: the conversation's own profile stays as it is. */
    siteOnly: Schema.optional(Schema.Boolean),
  }),
  /** "Use in this project"; null clears it. */
  Schema.Struct({ projectId: ProjectId, profileId: Schema.NullOr(BrowserProfileId) }),
]);
export type BrowserProfileChoiceInput = typeof BrowserProfileChoiceInput.Type;

/** Get PDF on a source: fetched like an agent's request, saved in `papers/` and attached. */
export const AccountPaperForSourceInput = Schema.Struct({
  root: Schema.String.check(Schema.isMaxLength(4096)),
  sourceId: TrimmedNonEmptyString,
  expectedRevision: Schema.Int,
  doi: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
});
export type AccountPaperForSourceInput = typeof AccountPaperForSourceInput.Type;

export const AccountPaperForSourceResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("attached"),
    /** False for an accepted manuscript or preprint. */
    published: Schema.Boolean,
    /** The university it came through, and how. */
    through: Schema.optional(Schema.String),
    route: Schema.optional(PaperRoute),
  }),
  Schema.Struct({
    status: Schema.Literals(["not-found", "no-access", "needs-you", "waiting"]),
    message: Schema.String,
    landingUrl: Schema.optional(Schema.String),
  }),
]);

/** Which version of the work a PDF is; "unknown" when its repository did not say. */
export const PaperVersion = Schema.Literals(["published", "accepted", "preprint", "unknown"]);
export type PaperVersion = typeof PaperVersion.Type;

export const PaperItemState = Schema.Literals([
  "waiting",
  "saved",
  "needs-you",
  "not-found",
  "no-access",
]);
export type PaperItemState = typeof PaperItemState.Type;

/** A paper to fetch: by DOI or link, attached to its source when it came from one. */
export const PaperAsked = Schema.Struct({
  doi: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  source: Schema.optional(
    Schema.Struct({ sourceId: TrimmedNonEmptyString, expectedRevision: Schema.Int }),
  ),
  /** For the Library: the saved PDF goes on the paper's Source, which is added when missing. */
  library: Schema.optional(Schema.Boolean),
});
export type PaperAsked = typeof PaperAsked.Type;

const PaperNeed = {
  /** "access": a university is connected, but the conversation that asked may not use it. */
  kind: Schema.Literals(["university", "sign-in", "check", "terms", "access"]),
  site: Schema.optional(Schema.String),
  /** The university to sign in to, for a "sign-in", or to allow, for an "access". */
  accountId: Schema.optional(AccountId),
  openUrl: Schema.optional(Schema.String),
  profileId: Schema.optional(Schema.String),
  /** The live consent form: its SAML POST cannot be reconstructed from a URL. */
  tabId: Schema.optional(PreviewTabId),
} as const;

export const PaperItem = Schema.Struct({
  ...PaperAsked.fields,
  itemId: TrimmedNonEmptyString,
  state: PaperItemState,
  route: Schema.optional(Schema.Literals(["saved-before", "open-access", ...PaperRoute.literals])),
  /** False for an accepted manuscript or preprint. */
  published: Schema.optional(Schema.Boolean),
  version: Schema.optional(PaperVersion),
  path: Schema.optional(Schema.String),
  /** The Library source the PDF went on. */
  sourceId: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(Schema.String),
  /** What this paper waits on, while it is "needs-you". */
  needed: Schema.optional(Schema.Struct(PaperNeed)),
  /** The university it came through. */
  through: Schema.optional(Schema.String),
  /** Unreached, and put away by the person. */
  dismissed: Schema.optional(Schema.Boolean),
});
export type PaperItem = typeof PaperItem.Type;

/** One thing only the user can do, which releases every paper waiting on it. */
export const PaperRequest = Schema.Struct({
  ...PaperNeed,
  count: Schema.Int,
});
export type PaperRequest = typeof PaperRequest.Type;

/** A project's papers being fetched, as a band or a card shows them. */
export const PaperQueueSummary = Schema.Struct({
  root: Schema.String,
  /** The conversation that asked, whose card shows what it needs from the user. */
  threadId: Schema.optional(ThreadId),
  waiting: Schema.Int,
  saved: Schema.Int,
  failed: Schema.Int,
  requests: Schema.Array(PaperRequest),
  /** Publishers that asked Scient to slow down, with when each resumes. */
  paused: Schema.Array(Schema.Struct({ site: Schema.String, until: IsoDateTime })),
  /** The university the latest saved paper came through. */
  through: Schema.optional(Schema.String),
});
export type PaperQueueSummary = typeof PaperQueueSummary.Type;

export const PaperQueueRequestInput = Schema.Struct({
  root: Schema.String.check(Schema.isMaxLength(4096)),
  papers: Schema.Array(PaperAsked).check(Schema.isMinLength(1), Schema.isMaxLength(5000)),
});
export type PaperQueueRequestInput = typeof PaperQueueRequestInput.Type;

export const PaperQueueInput = Schema.Struct({
  root: Schema.String.check(Schema.isMaxLength(4096)),
});
export type PaperQueueInput = typeof PaperQueueInput.Type;

export const PaperQueueContinueInput = Schema.Struct({
  ...PaperQueueInput.fields,
  terms: Schema.optional(Schema.Struct({ site: Schema.String, profileId: Schema.String })),
  /** The papers no route reached: tried again, or put away. Older servers ignore these. */
  unreached: Schema.optional(Schema.Literals(["retry", "dismiss"])),
});
export type PaperQueueContinueInput = typeof PaperQueueContinueInput.Type;

export const UniversitySearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
/** The user's own sign-in to any website row, a university's included, in a tab beside `threadId`. */
export const AccountSignInAsPersonInput = Schema.Struct({
  accountId: AccountId,
  /** The conversation it opens beside. */
  threadId: ThreadId,
  /** A row made just for this sign-in goes again if it ends with nothing kept. */
  discardIfUnfinished: Schema.optional(Schema.Literal(true)),
  /** Sign in on this tab of the conversation, which the server runs, instead of a new one. */
  tabId: Schema.optional(PreviewTabId),
});
export type AccountSignInAsPersonInput = typeof AccountSignInAsPersonInput.Type;

/** What a page in the person's tab offers to keep, as the desktop saw it. */
export const AccountPageOffer = Schema.Literals(["two-factor-setup", "recovery-codes"]);
export type AccountPageOffer = typeof AccountPageOffer.Type;

/**
 * A 2FA setup page as the desktop read it in the person's tab: its `otpauth://` links, and each
 * square image, canvas or SVG as one bit per pixel (dark or light), within one budget.
 */
export const AccountSetupPage = Schema.Struct({
  uris: Schema.Array(Schema.String.check(Schema.isMaxLength(2048))).check(Schema.isMaxLength(4)),
  images: Schema.Array(
    Schema.Struct({
      width: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(400)),
      height: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(400)),
      bits: Schema.String.check(Schema.isMaxLength(48_000)),
    }),
  ).check(Schema.isMaxLength(6)),
});
export type AccountSetupPage = typeof AccountSetupPage.Type;

/**
 * What the person's tab shows (a 2FA setup, backup codes), held by the server as a private pending
 * record until the person saves it to a login. `sealed` is what the desktop read in `documentId`,
 * sealed in its main process with a key only it and its own backend derive (from the desktop's
 * bootstrap secret), once: the page's values never pass the app's own code.
 */
export const AccountPageKeepInput = Schema.Struct({
  offer: AccountPageOffer,
  documentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  sealed: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80_000)),
});
export type AccountPageKeepInput = typeof AccountPageKeepInput.Type;
const TotpPeriod = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(300));
export const AccountPageKeepResult = Schema.Struct({
  found: Schema.Boolean,
  pendingId: Schema.optional(TrimmedNonEmptyString),
  /**
   * A setup's current code, for the client to fill as autofill does: only into an empty box of
   * the same document. Like a fill's values, it goes only to the person's own client.
   */
  code: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{6,8}$/))),
  /** The code's period in seconds. */
  period: Schema.optional(TotpPeriod),
});
export type AccountPageKeepResult = typeof AccountPageKeepResult.Type;

/**
 * A secret Scient holds privately until it is settled: a 2FA key or backup codes the person's
 * tab showed, waiting to be saved to a login; or a new password a form sent, waiting for the
 * site's answer (`unclear` once that answer didn't come). It is on no login until then.
 */
export const AccountPendingSecret = Schema.Struct({
  pendingId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  kind: Schema.Literals(["totp", "recovery", "password"]),
  /** The page's origin. */
  site: Schema.String,
  profileId: Schema.optional(BrowserProfileId),
  /** The account the page named: a setup's label, or the username a form sent. */
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /**
   * The login it is for: a new password's own; for a factor, the one login its label names, else
   * the site's only saved login in its profile.
   */
  accountId: Schema.optional(AccountId),
  /** Logins on the site in its profile that could take a factor. */
  candidates: Schema.optional(Schema.Array(AccountId).check(Schema.isMaxLength(20))),
  /** A new password whose site gave no clear answer: kept until the person says. */
  unclear: Schema.optional(Schema.Literal(true)),
  /**
   * A new password answered as taken after its login got another one (or changed whose it is):
   * both are kept until the person says which.
   */
  conflict: Schema.optional(Schema.Literal(true)),
  since: IsoDateTime,
});
export type AccountPendingSecret = typeof AccountPendingSecret.Type;

const PendingId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
/**
 * A pending secret's steps: `reserve` holds a new password before its fill (refused when full);
 * `rotate` says its form sent it; `settle` gives the site's answer; `save` puts it on a login
 * (a factor or a `replace`: as seen at `updatedAt`); `discard` forgets it; `code` gives a code.
 */
export const AccountPendingInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("reserve"),
    origin: Schema.String.check(Schema.isMaxLength(2048)),
    profileId: Schema.optional(BrowserProfileId),
    password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
    accountId: Schema.optional(AccountId),
  }),
  Schema.Struct({
    type: Schema.Literal("rotate"),
    pendingId: Schema.optional(PendingId),
    origin: Schema.String.check(Schema.isMaxLength(2048)),
    profileId: Schema.optional(BrowserProfileId),
    username: Schema.String.check(Schema.isMaxLength(512)),
    password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
    accountId: Schema.optional(AccountId),
    login: Schema.optional(
      Schema.Struct({
        name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
        details: Schema.Struct({ kind: Schema.Literal("website"), ...WebsiteFields }),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("settle"),
    pendingId: PendingId,
    outcome: Schema.Literals(["accepted", "unclear"]),
  }),
  Schema.Struct({
    type: Schema.Literal("save"),
    pendingId: PendingId,
    accountId: Schema.optional(AccountId),
    updatedAt: Schema.optional(Schema.String),
    replace: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({ type: Schema.Literal("discard"), pendingId: PendingId }),
  Schema.Struct({ type: Schema.Literal("code"), pendingId: PendingId }),
]);
export type AccountPendingInput = typeof AccountPendingInput.Type;
export const AccountPendingResult = Schema.Struct({
  pendingId: Schema.optional(TrimmedNonEmptyString),
  accountId: Schema.optional(AccountId),
  /** Not saved: its login got another password or changed since; both are kept. */
  conflict: Schema.optional(Schema.Literal(true)),
  code: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{6,8}$/))),
  /** The code's period in seconds: the next one is due at the period's next boundary. */
  period: Schema.optional(TotpPeriod),
});
export type AccountPendingResult = typeof AccountPendingResult.Type;

/** A page the person opened, to bring in through their university when it is a journal article. */
export const UniversityBrowseInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  profileId: BrowserProfileId,
  url: Schema.String.check(Schema.isMaxLength(8192)),
});
export type UniversityBrowseInput = typeof UniversityBrowseInput.Type;

/** Signs one university membership out in its profiles: every row of it that `accountId` belongs to. */
/** One site or host a university Sign out clears in one profile. */
export const UniversitySignOutTarget = Schema.Struct({
  profileId: BrowserProfileId,
  site: TrimmedNonEmptyString,
});
export type UniversitySignOutTarget = typeof UniversitySignOutTarget.Type;

/**
 * Signs one university membership out in its profiles: every row of it that `accountId` belongs
 * to. With `opId`, reports which of that sign-out's targets the client cleared.
 */
export const UniversitySignOutInput = Schema.Struct({
  accountId: AccountId,
  opId: Schema.optional(TrimmedNonEmptyString),
  cleared: Schema.optional(Schema.Array(UniversitySignOutTarget)),
});
export type UniversitySignOutInput = typeof UniversitySignOutInput.Type;
/** What the client clears, the way a site's Sign out does, and the sign-out it belongs to. */
export const UniversitySignOutResult = Schema.Struct({
  opId: Schema.optional(TrimmedNonEmptyString),
  sites: Schema.Array(UniversitySignOutTarget),
});
export type UniversitySignOutResult = typeof UniversitySignOutResult.Type;

/**
 * A university Sign out whose targets aren't all cleared yet, in order (`seq`): a newer explicit
 * sign-in on any of its rows ends it, and an older one never acts after that.
 */
export const UniversitySignOut = Schema.Struct({
  opId: TrimmedNonEmptyString,
  seq: Schema.Int,
  accountIds: Schema.Array(AccountId),
  pending: Schema.Array(UniversitySignOutTarget),
});
export type UniversitySignOut = typeof UniversitySignOut.Type;

/** A secret sitting in a plain file: by name only, never its value. */
export const AccountPlainKey = Schema.Struct({
  file: Schema.String.check(Schema.isMaxLength(4096)),
  name: EnvironmentVariableName,
  kept: Schema.Boolean,
});
export type AccountPlainKey = typeof AccountPlainKey.Type;

export const AccountPlainKeysInput = Schema.Struct({
  roots: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(200)),
});

export const AccountPlainKeyInput = Schema.Struct({
  ...AccountPlainKeysInput.fields,
  file: AccountPlainKey.fields.file,
  name: AccountPlainKey.fields.name,
});
export type AccountPlainKeyInput = typeof AccountPlainKeyInput.Type;

/** A provider variable that takes its value from an API-key account, and follows it. */
export const AccountKeyLink = Schema.Struct({
  accountId: AccountId,
  instanceId: TrimmedNonEmptyString,
  variable: EnvironmentVariableName,
  /** Digests of the values the link last wrote there: any other value is the person's own. */
  copies: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(2))),
});
export type AccountKeyLink = typeof AccountKeyLink.Type;

/** Without an account, Scient keeps the variable's own key as an API key and links it to that. */
export const AccountLinkKeyInput = Schema.Struct({
  ...AccountKeyLink.fields,
  accountId: Schema.optional(AccountId),
});
export type AccountLinkKeyInput = typeof AccountLinkKeyInput.Type;

/** Kept keys (`keptFrom`) to put back into a newly added agent of the same kind. */
export const AccountRestoreKeptKeysInput = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  accountIds: Schema.Array(AccountId).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type AccountRestoreKeptKeysInput = typeof AccountRestoreKeptKeysInput.Type;

export const AccountKeyUnlinkInput = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  variable: EnvironmentVariableName,
});

/** Where Scient keeps a browser profile's Google session. */
export const GOOGLE_SITE = "google.com";

/** The Google accounts a browser profile holds, as Google reports them. */
export const AccountGoogleSessions = Schema.Struct({
  profileId: BrowserProfileId,
  sessions: Schema.Array(
    Schema.Struct({ email: Schema.String.check(Schema.isMaxLength(256)), valid: Schema.Boolean }),
  ),
});
export type AccountGoogleSessions = typeof AccountGoogleSessions.Type;

/** Where Scient may look for a sign-in code: Messages and Mail on the server's Mac. On by default. */
export const AccountCodeSources = Schema.Struct({
  messages: Schema.Boolean,
});
export type AccountCodeSources = typeof AccountCodeSources.Type;

export const AccountCodeSourcesResult = Schema.Struct({
  /** macOS refused to open Messages; Scient needs Full Disk Access. */
  messagesNeedAccess: Schema.Boolean,
});

/**
 * Accounts' protocol between a client and a server, which may run different builds; the server
 * reports the one it speaks, and a client gates each feature on the version that brought it.
 */
export const ACCOUNTS_PROTOCOL = 3;
/**
 * 1: imported sessions recorded (`sessionsSeen`), sign-ins received from another computer, sign-in
 * on any website row, and keeping what the user types in a sign-in Scient runs.
 */
export const ACCOUNTS_PROTOCOL_1 = 1;
/**
 * 2: Undo (`accounts.restore`); Needs you; hand-off codes and the codes setting; text generators'
 * Accounts keys; grouped logins, Show and Copy (`accounts.reveal`), Use saved, `neverAsk` and the
 * person's sign-in on a server-run tab; university sign-out and attempt ends; a new password's
 * Undo (`accounts.passwords.undo`).
 */
export const ACCOUNTS_PROTOCOL_2 = 2;
const AccountSpeechConsumer = Schema.Struct({
  accountId: AccountId,
  label: Schema.String,
  engineId: Schema.optionalKey(Schema.String),
});
export type AccountSpeechConsumer = typeof AccountSpeechConsumer.Type;

const AccountKeyConsumer = Schema.Struct({
  accountId: AccountId,
  kind: Schema.Literals(["custom-model", "transcription"]),
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type AccountKeyConsumer = typeof AccountKeyConsumer.Type;

/**
 * What Scient told the person's phone about a code it caused: kept as history, so a quick sign-in
 * adds "signed in" instead of taking the notice back before it reached them.
 */
export const AccountCodeNotice = Schema.Struct({
  noticeId: Schema.String,
  accountId: Schema.String,
  /** The notice, naming the site. */
  text: Schema.String,
  at: IsoDateTime,
  /** The relay took it for the phone. */
  delivered: Schema.optional(Schema.Literal(true)),
  /** How the sign-in it was about ended, and when. */
  settled: Schema.optional(Schema.Literals(["signed-in", "not-signed-in"])),
  settledAt: Schema.optional(IsoDateTime),
  /** The relay took these rows off the phone; the notice goes once every row it showed is off. */
  cleared: Schema.optional(Schema.Array(Schema.Literals(["notice", "settled"]))),
});
export type AccountCodeNotice = typeof AccountCodeNotice.Type;

export const AccountManagedElsewhereItem = Schema.Struct({
  kind: Schema.Literals(["github", "custom-model"]),
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
  href: Schema.Literals(["/settings/source-control", "/settings/custom-models"]),
  /** How Source Control holds a GitHub login: the gh CLI, the app sign-in, or a token. */
  via: Schema.optional(Schema.Literals(["gh", "app", "token"])),
});
export type AccountManagedElsewhereItem = typeof AccountManagedElsewhereItem.Type;

export const AccountsExternalIdentitiesResult = Schema.Struct({
  identities: Schema.Array(AccountManagedElsewhereItem),
  /** False when a provider credential lookup timed out or failed; clients may retry while open. */
  complete: Schema.optional(Schema.Boolean),
});
export type AccountsExternalIdentitiesResult = typeof AccountsExternalIdentitiesResult.Type;

export const AccountsSnapshot = Schema.Struct({
  /** Off turns every account and profile off for agents without changing their settings. */
  agentAccess: Schema.Boolean,
  accounts: Schema.Array(AccountSummary),
  profiles: Schema.Array(BrowserProfileRecord),
  profileChoices: Schema.optional(BrowserProfileChoices),
  codeSources: Schema.optional(AccountCodeSources),
  /**
   * "Renew sign-ins automatically", on unless the person turned it off. Absent from a server that
   * has no such setting.
   */
  renewAutomatically: Schema.optional(Schema.Boolean),
  codeNotices: Schema.optional(Schema.Array(AccountCodeNotice)),
  /** The server's Mac, where codes are read; absent when the server isn't a Mac. */
  codeSourcesHost: Schema.optional(
    Schema.Struct({ computer: TrimmedNonEmptyString, readable: Schema.Boolean }),
  ),
  /** Sites (`https://` origins) where the person said not to offer saving a sign-in. */
  neverAsk: Schema.optional(Schema.Array(Schema.String)),
  /**
   * How each recent Accounts card ended, by its request id: the card's own status says only that
   * it was answered or closed; this says whether Accounts kept the value, or why it closed.
   */
  cards: Schema.optional(
    Schema.Array(
      Schema.Struct({
        requestId: Schema.String,
        outcome: Schema.Literals(["saved", "failed", "declined", "cancelled", "timed_out"]),
        /** The row a saved card's value went into. */
        accountId: Schema.optional(AccountId),
      }),
    ),
  ),
  /**
   * The cards whose value Accounts is still keeping, from a server that tracks them: an answered
   * card in neither list has ended, its outcome no longer kept.
   */
  cardsSettling: Schema.optional(Schema.Array(Schema.String)),
  keyLinks: Schema.optional(Schema.Array(AccountKeyLink)),
  speechConsumers: Schema.optional(Schema.Array(AccountSpeechConsumer)),
  detachedKeyLinks: Schema.optional(Schema.Array(AccountKeyLink)),
  stores: AccountStoresStatus,
  approvals: Schema.Array(AccountApproval),
  /** Rows removed within the hour, which Undo can still bring back with their receipt. */
  removed: Schema.optional(
    Schema.Array(
      Schema.Struct({
        accountId: AccountId,
        name: Schema.String,
        removalId: Schema.String,
        /** The press that removed it: rows removed together come back with one Undo. */
        operationId: Schema.optional(Schema.String),
        /** An agent's removal: its chat (round 6c). */
        threadId: Schema.optional(ThreadId),
        until: IsoDateTime,
      }),
    ),
  ),
  handoffs: Schema.optional(Schema.Array(AccountHandoff)),
  needsYou: Schema.optional(Schema.Array(AccountNeedsYou)),
  paperQueues: Schema.optional(Schema.Array(PaperQueueSummary)),
  recentActivity: Schema.Array(AccountActivityEntry),
  customModelKeys: Schema.Array(AccountCustomModelKey),
  keyConsumers: Schema.optional(Schema.Array(AccountKeyConsumer)),
  unavailableCustomModelKeyIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  keyConsumersIncomplete: Schema.optional(Schema.Boolean),
  /** Uses whose provider refused the key's current value. */
  keyRefusals: Schema.optional(Schema.Array(AccountKeyRefusal)),
  /** Secrets Scient holds privately until they are settled; an older client ignores them. */
  pendingSecrets: Schema.optional(Schema.Array(AccountPendingSecret)),
  /**
   * What this server's pending secrets take (protocol 3's `accounts.pending`, by feature): a made
   * password held from before its fill (`reserve`), page secrets the desktop sealed for it
   * (`page-seal`). A client uses a step only on a server that lists it.
   */
  pendingFeatures: Schema.optional(Schema.Array(Schema.Literals(["reserve", "page-seal"]))),
  /**
   * Logins whose new password just worked and was saved: each copy's own Undo, for the hour. With
   * `field`, a 2FA key Scient kept itself instead (older clients read it as a password).
   */
  passwordUpdates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        undoId: TrimmedNonEmptyString,
        accountId: AccountId,
        name: Schema.String,
        until: IsoDateTime,
        field: Schema.optional(Schema.Literals(["totp", "recovery"])),
      }),
    ),
  ),
  /** What agents changed, newest last; an older client ignores it. */
  changes: Schema.optional(Schema.Array(AccountChange)),
  /** Profile operations of the hour, with their Undo; an older client ignores them. */
  profileOperations: Schema.optional(Schema.Array(ProfileOperation)),
  /** API-key rows holding the same value, which pickers show as one entry. Never the value. */
  sameKeys: Schema.optional(Schema.Array(Schema.Array(AccountId))),
  /**
   * Saved passwords with something wrong, checked on this server: seen in a breach (by a 5-hex
   * hash prefix only), used on another login, or weak. Never a value or a hash.
   */
  passwordHealth: Schema.optional(
    Schema.Array(
      Schema.Struct({
        accountId: AccountId,
        finding: Schema.Literals(["leaked", "reused", "weak"]),
      }),
    ),
  ),
  managedElsewhere: Schema.optional(Schema.Array(AccountManagedElsewhereItem)),
  /** What this server can do that an older one can't, so a newer client offers only that. */
  /** What this server's Accounts speaks; absent on a server older than `ACCOUNTS_PROTOCOL_1`. */
  accountsProtocol: Schema.optional(Schema.Int),
  /** Sign-ins Scient is running, by tab; no values. Agents can't read these tabs meanwhile. */
  attempts: Schema.optional(Schema.Array(AccountSignInAttempt)),
  /**
   * How each row's last sign-in by the person ended, while this server runs. Present, even empty,
   * on a server that also signs universities out and retries or puts away unreached papers.
   */
  signInEnds: Schema.optional(Schema.Array(AccountSignInEnd)),
  /** University sign-outs still clearing: their targets stay on offer until cleared. */
  universitySignOuts: Schema.optional(Schema.Array(UniversitySignOut)),
});
export type AccountsSnapshot = typeof AccountsSnapshot.Type;

const SecretValue = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536));

/** How a save changes one secret field. Omitted fields are kept. */
export const AccountSecretInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("scient"),
    value: SecretValue,
    /** An import's own date for this password, kept on the saved row as `changedAt`. */
    changedAt: Schema.optional(IsoDateTime),
    /** Backup codes written one per line (a code may hold a space); else split at any space. */
    lines: Schema.optional(Schema.Literal(true)),
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
  /** The saved account as Accounts lists it, for a client to show before its next snapshot. */
  account: Schema.optional(AccountSummary),
  warnings: Schema.optional(Schema.Array(Schema.String)),
  /** The Undo this save's new password got, so a client can take it back itself. */
  undoId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
});
export type AccountSaveResult = typeof AccountSaveResult.Type;

export const AccountPasswordUndoInput = Schema.Struct({
  undoId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
});
/** Copies given back their own earlier password, and copies changed since, left as they are. */
export const AccountPasswordUndoResult = Schema.Struct({
  restored: Schema.Number,
  changed: Schema.Number,
  /** Keychain or 1Password copies that couldn't take the earlier password back: they keep the newer one. */
  mirrorsLeft: Schema.optional(Schema.Array(Schema.String)),
});

export const AccountRemoveInput = Schema.Struct({
  accountId: AccountId,
  /** The row as the person last saw it: Remove refuses a version edited since. */
  updatedAt: Schema.optional(Schema.String),
  /** One press's removal of several rows, such as a university's, for its one Undo. */
  operationId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});

/** A receipt for this removal; Undo names it, so an old Undo never brings back a later removal. */
export const AccountRemoveResult = Schema.Struct({ removalId: Schema.optional(Schema.String) });

export const AccountRestoreInput = Schema.Struct({
  accountId: AccountId,
  removalId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});

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

/** "Renew sign-ins automatically": off, renewal only looks and never signs in by itself. */
export const AccountsSetRenewAutomaticallyInput = Schema.Struct({ enabled: Schema.Boolean });

/** Sent by the client that imported or edited a profile; `null` clears a field. */
export const BrowserProfileRecordUpdateInput = Schema.Struct({
  profileId: BrowserProfileId,
  picture: Schema.optional(Schema.NullOr(ProfilePictureDataUri)),
  color: Schema.optional(Schema.NullOr(ProfileColor)),
  source: Schema.optional(Schema.NullOr(BrowserProfileSource)),
  madeInScient: Schema.optional(IsoDateTime),
});
export type BrowserProfileRecordUpdateInput = typeof BrowserProfileRecordUpdateInput.Type;

export const BrowserProfileRecordRemoveInput = Schema.Struct({ profileId: BrowserProfileId });

/** A client's profiles, by id and the name it lists them under; the server keeps the name. */
export const BrowserProfilesReportInput = Schema.Struct({
  profiles: Schema.Array(
    Schema.Struct({ profileId: BrowserProfileId, name: FoldedProfileName }),
  ).check(Schema.isMaxLength(100)),
  /** A desktop's browser profiles, replacing what it reported before. */
  computer: Schema.optional(ReportingComputer),
  sources: Schema.optional(Schema.Array(BrowserSourceProfile).check(Schema.isMaxLength(100))),
});

/**
 * The fold merges a profile into Main: its rows and choices name Main and its record is marked
 * retired, its jar untouched. Undo clears the mark for good; rows and choices stay on Main.
 */
export const BrowserProfileRetireInput = Schema.Union([
  Schema.Struct({ profileId: BrowserProfileId, name: FoldedProfileName }),
  Schema.Struct({ profileId: BrowserProfileId, undo: Schema.Literal(true) }),
]);

/** A row's sign-in was copied into Main, or Main already held the same one. */
export const AccountMainFilledInput = Schema.Struct({
  accountId: AccountId,
  /** The source profile's name, for "Copied from …". */
  profileName: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});

/** One case of the dev-only check that a computer's browser copies sign-ins exactly. */
export const AccountsQualifyCase = Schema.Struct({
  case: Schema.Int,
  name: Schema.String,
  ok: Schema.Boolean,
  detail: Schema.optional(Schema.String),
});
export type AccountsQualifyCase = typeof AccountsQualifyCase.Type;

/** Profiles whose sessions the one-time back-fill has copied into Main; empty when there were none. */
export const AccountMainBackfilledInput = Schema.Struct({
  profileIds: Schema.Array(BrowserProfileId).check(Schema.isMaxLength(64)),
});

/** The one-time fold of profiles made in Scient into Main ran; the names of those merged. */
export const AccountMainFoldedInput = Schema.Struct({
  profiles: Schema.Array(FoldedProfileName).check(Schema.isMaxLength(64)),
});

const SessionSite = TrimmedNonEmptyString.check(Schema.isMaxLength(253));

/** Accounts' Sign out in a profile, recorded before the cookies go; Main also keeps the site out. */
export const AccountProfileSignedOutInput = Schema.Struct({
  profileId: BrowserProfileId,
  site: SessionSite,
});

/** Main gave back a restricted profile's copy: other computers take back theirs of it. */
export const AccountMainWithdrawnInput = Schema.Struct({ sites: SessionUnitSites });

export const AccountProfileSendLogInput = Schema.Struct({ profileId: BrowserProfileId });

/** A whole-jar revision: after an import or a refresh into the profile, or Send again. */
export const AccountProfileResendInput = Schema.Struct({
  profileId: BrowserProfileId,
  why: Schema.Literals(["import", "send-again"]),
  /** An agent's refresh: sent only while it still stands, checked where it commits (6k). */
  operationId: Schema.optional(ProfileOperationId),
});

export const AccountProfileRevision = Schema.Struct({ revision: SessionRevision });

/**
 * A computer this desktop no longer sends to: its deletions no longer wait for it. Its key goes
 * only once it confirmed the withdrawal; kept, a later link proves the same sender again.
 */
export const AccountProfileUnsharedInput = Schema.Struct({
  environmentId: EnvironmentId,
  forgetKey: Schema.optional(Schema.Literal(true)),
});

/** On a remote, its owner forgets a desktop: its copies and its registration go. */
export const AccountSessionsForgetInput = Schema.Struct({ source: EnvironmentId });

export const AccountProfileSharedInput = Schema.Struct({
  profileId: BrowserProfileId,
  share: ProfileSharedWith,
});

const SENT_COOKIES_LIMIT = 1_000;

/** The key a computer issued this desktop as a sender; only its hash is kept there. */
const SenderKey = Schema.RedactedFromValue(TrimmedNonEmptyString.check(Schema.isMaxLength(128)));

/** A desktop proves it is the sender it was: with its key, or for the first time, without one. */
export const AccountSessionsBindInput = Schema.Struct({
  source: EnvironmentId,
  label: ComputerLabel,
  key: Schema.optional(SenderKey),
});

/** A new sender's key, given once. */
export const AccountSessionsBindResult = Schema.Struct({ key: Schema.optional(SenderKey) });

export const AccountSenderKeyInput = Schema.Struct({ environmentId: EnvironmentId });
export const AccountSenderKey = Schema.Struct({ key: Schema.optional(SenderKey) });
export const AccountKeepSenderKeyInput = Schema.Struct({
  environmentId: EnvironmentId,
  key: SenderKey,
});

const SessionsBatch = Schema.Struct({
  source: EnvironmentId,
  key: SenderKey,
  label: ComputerLabel,
  profileId: BrowserProfileId,
  controls: SentProfileControls,
  mode: Schema.Literals(["fill", "replace"]),
  units: Schema.Array(
    Schema.Struct({
      sites: SessionUnitSites,
      revision: SessionRevision,
      kind: Schema.Literals(["copy", "delete"]),
      copyOnly: Schema.optional(Schema.Literal(true)),
      cookies: Schema.optional(
        Schema.Array(SentSessionCookie).check(Schema.isMaxLength(SENT_COOKIES_LIMIT)),
      ),
    }),
  ).check(Schema.isMaxLength(100)),
  sentAt: IsoDateTime,
});

/** One batch from a desktop: at most 100 units and 1,000 cookies, never a split unit. */
export const AccountSessionsReceiveInput = SessionsBatch.check(
  Schema.makeFilter(
    (input: typeof SessionsBatch.Type) =>
      input.units.reduce((total, unit) => total + (unit.cookies?.length ?? 0), 0) <=
      SENT_COOKIES_LIMIT,
  ),
);
export type AccountSessionsReceiveInput = typeof AccountSessionsReceiveInput.Type;

export const SessionReceiveOutcome = Schema.Literals([
  "copied",
  "same",
  "kept",
  "deleted",
  "stale",
  "busy",
  "blocked",
  "failed",
  "restore-failed",
]);
export type SessionReceiveOutcome = typeof SessionReceiveOutcome.Type;

export const AccountSessionsReceiveResult = Schema.Struct({
  units: Schema.Array(
    Schema.Struct({
      sites: SessionUnitSites,
      revision: SessionRevision,
      outcome: SessionReceiveOutcome,
    }),
  ),
});
export type AccountSessionsReceiveResult = typeof AccountSessionsReceiveResult.Type;

export const AccountSessionsAppliedInput = Schema.Struct({
  source: EnvironmentId,
  key: SenderKey,
  profileId: BrowserProfileId,
});

/** Names and numbers only. `bound`: this sender has delivered to the profile before. */
export const AccountSessionsApplied = Schema.Struct({
  bound: Schema.Boolean,
  withdrawn: Schema.optional(SessionRevision),
  units: Schema.Array(ReceivedUnit),
});
export type AccountSessionsApplied = typeof AccountSessionsApplied.Type;

export const AccountSessionsWithdrawInput = Schema.Struct({
  source: EnvironmentId,
  key: SenderKey,
  profileId: Schema.optional(BrowserProfileId),
  all: Schema.optional(Schema.Literal(true)),
  revision: Schema.optional(SessionRevision),
});

export const AccountSessionsWithdrawResult = Schema.Struct({ deleted: NonNegativeInt });

export const AccountSessionsListInput = Schema.Struct({ profileId: BrowserProfileId });

export const AccountSessionsList = Schema.Struct({
  sites: Schema.Array(Schema.Struct({ site: SessionSite, cookies: NonNegativeInt })),
});
export type AccountSessionsList = typeof AccountSessionsList.Type;

export const AccountSessionsSignOutLocalInput = Schema.Struct({
  profileId: BrowserProfileId,
  site: SessionSite,
});

export const AccountSessionsSignOutLocalResult = Schema.Struct({ signedOut: Schema.Boolean });

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

/**
 * A password export file's text (CSV), or Google Authenticator export addresses
 * (`otpauth-migration://`, one per line). The client reads the file; the server never sees its path.
 */
export const PasswordImportInput = Schema.Struct({
  format: PasswordImportFormat,
  content: Schema.String.check(Schema.isMaxLength(10_000_000)),
  profileId: Schema.optional(BrowserProfileId),
  /** From a browser import or refresh: logins the person removed are left out. */
  origin: Schema.optional(Schema.Literal("browser")),
  /** A browser profile's Refresh: logins the person removed stay removed. */
  refresh: Schema.optional(Schema.Literal(true)),
  /** An agent's import, by its operation: refused once that no longer stands (round 6c). */
  operationId: Schema.optional(ProfileOperationId),
});
export type PasswordImportInput = typeof PasswordImportInput.Type;

export const PasswordImportResult = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  skipped: NonNegativeInt,
  /** Authenticator keys no saved login or named site took, by issuer. */
  unmatched: Schema.optional(Schema.Array(Schema.String)),
});
export type PasswordImportResult = typeof PasswordImportResult.Type;

/**
 * Round 6f: what only the desktop's main process asks its own backend, with its own session:
 * a browser's saved passwords, read there and handed straight to this backend's Accounts (no page
 * ever holds them), and whether an operation still stands at the moment its desktop part writes.
 */
export const ACCOUNTS_DESKTOP_PASSWORDS_PATH = "/api/scient/accounts/v1/desktop/passwords";
export const ACCOUNTS_DESKTOP_WRITE_CHECK_PATH = "/api/scient/accounts/v1/desktop/write-check";
export const DesktopPasswordImportReply = Schema.Struct({
  result: Schema.optional(PasswordImportResult),
  refused: Schema.optional(Schema.String),
});
export type DesktopPasswordImportReply = typeof DesktopPasswordImportReply.Type;
export const DesktopWriteCheckInput = Schema.Struct({
  operationId: ProfileOperationId,
  phase: Schema.Literals(["do", "undo"]),
  /** Another desktop's own part of a sign-out, by its computer. */
  computer: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
});
export type DesktopWriteCheckInput = typeof DesktopWriteCheckInput.Type;
export const DesktopWriteCheckResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String),
});
export type DesktopWriteCheckResult = typeof DesktopWriteCheckResult.Type;

/** The user's own sign-in on a page they are viewing; refused unless `origin` matches the account. */
export const AccountFilledTab = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  /** The site that was filled, by origin; the tab stays closed to agents that may not use it until it changes. */
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});
export type AccountFilledTab = typeof AccountFilledTab.Type;

export const AccountFillValuesInput = Schema.Struct({
  accountId: AccountId,
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  tab: Schema.optional(AccountFilledTab),
  /**
   * The client would submit the form by itself: the server says whether the site's budget allows
   * it (`AccountFillValues.submit`), and counts it if so.
   */
  autoSubmit: Schema.optional(Schema.Literal(true)),
});

export const AccountFillValues = Schema.Struct({
  username: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
  otp: Schema.optional(Schema.String),
  /** This fill's one-time name for its sign-in's result (`AccountSignInSeenInput`). */
  attempt: Schema.optional(Schema.String),
  /** The form may be submitted by itself, counted against the site's budget. */
  submit: Schema.optional(Schema.Literal(true)),
});
export type AccountFillValues = typeof AccountFillValues.Type;

/** "Don't ask for this site": `add` origins, or ask again on `remove`. */
export const AccountNeverAskInput = Schema.Struct({
  add: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))).check(
      Schema.isMaxLength(500),
    ),
  ),
  remove: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
});

/**
 * The person's own Show or Copy of a saved website password, the one it replaced, or one of its
 * earlier versions (`version`, from `AccountSecretSummary.history`).
 */
export const AccountRevealInput = Schema.Struct({
  accountId: AccountId,
  field: Schema.Literals(["password", "previous", "version"]),
  version: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export const AccountRevealResult = Schema.Struct({ value: Schema.String });

/** The person puts one of a login's earlier passwords (`version`) back as its password. */
export const AccountUsePasswordInput = Schema.Struct({
  accountId: AccountId,
  version: Schema.String.check(Schema.isMaxLength(64)),
});
export type AccountUsePasswordInput = typeof AccountUsePasswordInput.Type;
/**
 * The person removes one of a login's earlier passwords (`version`, as `AccountUsePasswordInput`):
 * nothing else ever does. Undo (`undoId`) brings it back within the hour.
 */
export const AccountRemovePasswordVersionResult = Schema.Struct({ undoId: Schema.String });
export const AccountRestorePasswordVersionInput = Schema.Struct({
  undoId: Schema.String.check(Schema.isMaxLength(64)),
});

export const AccountMatchSignInInput = Schema.Struct({
  origin: AccountFillValuesInput.fields.origin,
  /** The page's path when the form was sent: the route a saved tenant is matched by. */
  path: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  username: Schema.String.check(Schema.isMaxLength(256)),
  password: SecretValue,
  profileId: Schema.optional(BrowserProfileId),
});
export type AccountMatchSignInInput = typeof AccountMatchSignInInput.Type;
export const AccountMatchSignInResult = Schema.Struct({
  result: Schema.Literals(["new", "password-changed", "same"]),
  accountId: Schema.optional(AccountId),
  /** Saved tenants of this site and username the page could belong to: the person picks one. */
  choices: Schema.optional(Schema.Array(AccountId)),
});
export type AccountMatchSignInResult = typeof AccountMatchSignInResult.Type;

/** A session in a browser profile: brought by an import, or a sign-in seen happening there. */
export const AccountSessionSeen = Schema.Struct({
  /** The registrable site, such as `github.com`. */
  site: AccountSite,
  how: Schema.Literals(["imported", "signed-in"]),
  /** Where an import came from, such as "Chrome · Yaacov". */
  from: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
});
export type AccountSessionSeen = typeof AccountSessionSeen.Type;

export const AccountSessionsSeenInput = Schema.Struct({
  profileId: BrowserProfileId,
  sessions: Schema.Array(AccountSessionSeen).check(Schema.isMaxLength(200)),
});
export type AccountSessionsSeenInput = typeof AccountSessionsSeenInput.Type;

/** The rows made for sessions that had none. */
export const AccountSessionsSeenResult = Schema.Struct({ created: Schema.Array(AccountId) });

/**
 * What the user typed in a sign-in Scient runs, on that attempt's tab. Scient keeps it only once
 * the sign-in is proven, and only the password the site accepted.
 */
export const AccountKeepTypedInput = Schema.Struct({
  attemptId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  threadId: ThreadId,
  tabId: PreviewTabId,
  origin: AccountFillValuesInput.fields.origin,
  path: Schema.String.check(Schema.isMaxLength(2048)),
  step: Schema.Literal("password"),
  username: Schema.String.check(Schema.isMaxLength(256)),
  password: SecretValue,
});
export type AccountKeepTypedInput = typeof AccountKeepTypedInput.Type;

/**
 * How a sign-in with this saved password on the user's own tab ended. `attempt`, from the fill,
 * names the password typed and the login it was for, and counts once; without it the result
 * orders none of the login's passwords. `limited`: the site is limiting sign-ins.
 */
export const AccountSignInSeenInput = Schema.Struct({
  accountId: AccountId,
  outcome: Schema.Literals(["signed-in", "password-rejected", "limited"]),
  attempt: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type AccountSignInSeenInput = typeof AccountSignInSeenInput.Type;

/** Every browser sign-in, or one. */
export const AccountsCheckInput = Schema.Struct({
  accountId: Schema.optional(AccountId),
  /**
   * Opening a university's menu (with `accountId`): only reads the site, never signs in, and skips
   * one looked at in the last two minutes. An older server ignores it and runs a full check.
   */
  glance: Schema.optional(Schema.Boolean),
});
export type AccountsCheckInput = typeof AccountsCheckInput.Type;

export const AccountsTestInput = Schema.Struct({ accountId: AccountId });
/** A key's Check: its service accepted it, refused it, or only its saved value could be read. */
export const AccountKeyCheck = Schema.Literals(["works", "refused", "readable"]);
export type AccountKeyCheck = typeof AccountKeyCheck.Type;

/** Why a connector tool failed: the connector runtime's reason, as an analytics code. */
export const ConnectorToolFailureClass = Schema.Literals([
  "not_found",
  "invalid_input",
  "unreachable",
  "not_an_mcp_server",
  "sign_in_failed",
  "registration_unsupported",
  "limit_reached",
  "state_unavailable",
  "unsupported",
  "provider_rejected",
]);
export type ConnectorToolFailureClass = typeof ConnectorToolFailureClass.Type;

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
  /** A connector tool's own reason, so analytics keep the real cause. */
  failureClass: Schema.optional(ConnectorToolFailureClass),
}) {}

/** Value-free desktop session observations; missing profiles mean unknown. */
export const AccountBrowserSessions = Schema.Array(
  Schema.Struct({
    profileId: Schema.String,
    cookies: Schema.Array(
      Schema.Struct({
        domain: Schema.String,
        expires: Schema.optional(Schema.Number),
        httpOnly: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
);
export type AccountBrowserSessions = typeof AccountBrowserSessions.Type;
