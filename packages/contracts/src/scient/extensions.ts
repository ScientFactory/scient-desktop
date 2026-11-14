import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "../providerInstance.ts";
import { ServerProviders } from "../server.ts";
import { ExtensionIconDataUri } from "./extensionIcon.ts";
import { ProviderStoreApp } from "./providerStore.ts";
import { ExtensionAgentStores } from "./extensionAudience.ts";
export {
  ExtensionAudience,
  ExtensionAgentStores,
  supportsScientClaudePlugins,
} from "./extensionAudience.ts";

export * from "./providerStore.ts";
export { storeCategories } from "./storeCategories.ts";
export * from "./pluginContents.ts";
export * from "./pluginKeys.ts";

import { GrantScope, VaultSecretRef } from "./secrets.ts";

/**
 * Scient Extensions: connected services (remote MCP servers whose credentials
 * Scient holds), Scient plugins, and the provider-owned inventory shown beside
 * them. See docs/internals/scient-extensions.md.
 */

/** How a secret is presented to an upstream server. Shared with the Secrets vault. */
export const CredentialStrategy = Schema.Literals(["bearer", "header", "basic"]);
export type CredentialStrategy = typeof CredentialStrategy.Type;

export const ConnectorId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^con_[A-Za-z0-9_-]{8,64}$/),
).pipe(Schema.brand("ConnectorId"));
export type ConnectorId = typeof ConnectorId.Type;

/** MCP server name delivered to agents. Safe in `mcp__<name>__<tool>` positions. */
export const ConnectorServerName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,47}$/),
);
export type ConnectorServerName = typeof ConnectorServerName.Type;

/** Server names Scient reserves for its own MCP endpoint across providers. */
const RESERVED_CONNECTOR_SERVER_NAMES: Readonly<Record<string, true>> = {
  scient: true,
  "t3-code": true,
  t3_code: true,
  t3code: true,
};

export const isReservedConnectorServerName = (name: string): boolean =>
  RESERVED_CONNECTOR_SERVER_NAMES[name] === true;

export const ScientPluginId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
);
export type ScientPluginId = typeof ScientPluginId.Type;

export const ConnectorSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("registry"),
    name: TrimmedNonEmptyString,
    version: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("url") }),
  Schema.Struct({ type: Schema.Literal("plugin"), pluginId: ScientPluginId }),
  /** A program Scient runs on the environment's computer (see `LocalConnectorSummary`). */
  Schema.Struct({
    type: Schema.Literal("local"),
    /** The MCP Registry entry a `package` connector was added from. */
    registry: Schema.optional(
      Schema.Struct({ name: TrimmedNonEmptyString, version: TrimmedNonEmptyString }),
    ),
  }),
]);
export type ConnectorSource = typeof ConnectorSource.Type;

/**
 * How a local connector came in: an MCP Bundle file or folder, a command the user typed, an npm
 * or PyPI package from the MCP Registry, or a server another app on that computer already runs.
 */
export const LocalConnectorKind = Schema.Literals(["bundle", "command", "package", "import"]);
export type LocalConnectorKind = typeof LocalConnectorKind.Type;

/** One thing a local connector needs, from its manifest's `user_config`. */
export const LocalBundleField = Schema.Struct({
  key: TrimmedNonEmptyString,
  type: Schema.Literals(["string", "number", "boolean", "directory", "file"]),
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  required: Schema.Boolean,
  /** A key: kept as a linked Accounts API-key account, never on the connector. */
  sensitive: Schema.Boolean,
  multiple: Schema.Boolean,
  /** With `${HOME}` and the other directory variables already filled in. */
  default: Schema.optional(
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]),
  ),
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  /** The variable a key is passed in, used to offer a matching Accounts key. */
  envName: Schema.optional(TrimmedNonEmptyString),
});
export type LocalBundleField = typeof LocalBundleField.Type;

/** A field with what the connector has for it now. Key values never appear. */
export const LocalConnectorSetupItem = Schema.Struct({
  field: LocalBundleField,
  value: Schema.optional(
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]),
  ),
  /** The linked Accounts key's name. */
  account: Schema.optional(TrimmedNonEmptyString),
});
export type LocalConnectorSetupItem = typeof LocalConnectorSetupItem.Type;

/**
 * `missing`: no Accounts sign-in is linked. `linked`: Scient hands the program the site's session.
 * `needs-user`: signing in again needs the person (a captcha, a text-message code).
 */
export const LocalConnectorSignIn = Schema.Struct({
  site: TrimmedNonEmptyString,
  state: Schema.Literals(["missing", "linked", "needs-user"]),
  accountId: Schema.optional(TrimmedNonEmptyString),
  /** The linked Accounts sign-in's name. */
  account: Schema.optional(TrimmedNonEmptyString),
});
export type LocalConnectorSignIn = typeof LocalConnectorSignIn.Type;

export const LocalConnectorSummary = Schema.Struct({
  kind: LocalConnectorKind,
  /** The folder holding the connector's `manifest.json`, on the environment's computer. */
  directory: TrimmedNonEmptyString,
  /** How the program starts, for display; key values never appear in it. */
  commandLine: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  author: Schema.optional(TrimmedNonEmptyString),
  setup: Schema.Array(LocalConnectorSetupItem),
  /** Titles of required settings and keys that are missing: the row shows Needs setup. */
  missing: Schema.Array(TrimmedNonEmptyString),
  /** Set when the manifest can no longer be read. */
  problem: Schema.optional(TrimmedNonEmptyString),
  /** Copies running now, one per agent session that uses it. */
  running: NonNegativeInt,
  /** Scient keeps the folder (removed with the connector); false for a bundle used in place. */
  owned: Schema.Boolean,
  /** Who made the last change to its folder. */
  changedBy: Schema.optional(Schema.Literals(["you", "agent"])),
  /** The bundle this is the user's own copy of, by name, after an agent changed it. */
  forkedFrom: Schema.optional(TrimmedNonEmptyString),
  /** The last change to its folder can be undone. */
  canUndo: Schema.Boolean,
  /** The website it signs in to with the user's saved sign-in from Accounts. */
  signIn: Schema.optional(LocalConnectorSignIn),
});
export type LocalConnectorSummary = typeof LocalConnectorSummary.Type;

/** Public view of how a connector authenticates. Never carries credential material. */
export const ConnectorAuthSummary = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    issuer: Schema.optional(TrimmedNonEmptyString),
    scopes: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    /** The user supplied their own OAuth client instead of dynamic registration. */
    usesOwnClient: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("credential"),
    strategy: CredentialStrategy,
    /** Header name for the `header` strategy; `Authorization` otherwise. */
    headerName: Schema.optional(TrimmedNonEmptyString),
    /** `owned`: entered for this connector only. `bound`: a user secret from Secrets. */
    storage: Schema.Literals(["owned", "bound"]),
  }),
  /** Source Control's own credential for `host`, only while it still belongs to `account`. */
  Schema.Struct({
    type: Schema.Literal("source-control"),
    host: TrimmedNonEmptyString,
    /** The login the host reported for the credential when it was connected. */
    account: TrimmedNonEmptyString,
  }),
]);
export type ConnectorAuthSummary = typeof ConnectorAuthSummary.Type;

/**
 * `needs-auth`: OAuth sign-in required. `needs-credential`: the bound, owned or Source Control
 * credential is gone (for example unbound in Settings → Secrets); never falls back.
 */
export const ConnectorStatus = Schema.Literals(["connected", "needs-auth", "needs-credential"]);
export type ConnectorStatus = typeof ConnectorStatus.Type;

/**
 * An extension logo as an inline image. Clients never load remote images, so
 * icons travel only as base64 `data:` URIs of PNG, JPEG, WebP or SVG, at most
 * 64 KiB of image (about 87,400 base64 characters).
 */
export { ExtensionIconDataUri, isExtensionIconDataUri } from "./extensionIcon.ts";

export const ConnectorSummary = Schema.Struct({
  connectorId: ConnectorId,
  serverName: ConnectorServerName,
  displayName: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  url: TrimmedNonEmptyString,
  source: ConnectorSource,
  auth: ConnectorAuthSummary,
  status: ConnectorStatus,
  enabled: Schema.Boolean,
  /**
   * Credential generation changes even if auth presentation is identical. Tool lists and other
   * derived evidence bind that revision, not merely connected status.
   */
  authRevision: NonNegativeInt,
  /** Projects whose sessions receive this connector. Shared model with Secrets. */
  availability: GrantScope,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Most recent user-facing failure, cleared by the next success. */
  lastError: Schema.optional(TrimmedNonEmptyString),
  /** Logo of the curated server this connector points at. */
  iconUrl: Schema.optional(ExtensionIconDataUri),
  /** Present when Scient runs this connector as a program instead of reaching a URL. */
  local: Schema.optional(LocalConnectorSummary),
});
export type ConnectorSummary = typeof ConnectorSummary.Type;

/** Whether a provider instance can receive connectors at all. */
export const ConnectorProviderSupport = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: TrimmedNonEmptyString,
  status: Schema.Literals(["supported", "conditional", "unsupported"]),
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ConnectorProviderSupport = typeof ConnectorProviderSupport.Type;

export const ExtensionComponent = Schema.Struct({
  type: Schema.Literals(["skill", "mcp-tools", "connector", "settings", "panel"]),
  name: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ExtensionComponent = typeof ExtensionComponent.Type;

export const ScientPluginSummary = Schema.Struct({
  pluginId: ScientPluginId,
  version: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  publisher: TrimmedNonEmptyString,
  origin: Schema.Literals(["built-in", "bundle"]),
  /** SHA-256 of the installed bundle snapshot. Built-ins have none. */
  digest: Schema.optional(TrimmedNonEmptyString),
  components: Schema.Array(ExtensionComponent),
  enabled: Schema.Boolean,
  /** Built-ins are controlled by their existing settings, not by a plugin switch. */
  canSetEnabled: Schema.Boolean,
  canRemove: Schema.Boolean,
  installedAt: Schema.optional(IsoDateTime),
  /** In-app settings route that controls this plugin's behavior. */
  settingsPath: Schema.optional(TrimmedNonEmptyString),
  connectorIds: Schema.Array(ConnectorId),
});
export type ScientPluginSummary = typeof ScientPluginSummary.Type;

export const ExtensionsDiagnostic = Schema.Struct({
  code: Schema.Literals([
    "state-unreadable",
    "connector-record-unreadable",
    "plugin-invalid",
    "provider-inventory-unavailable",
  ]),
  message: TrimmedNonEmptyString,
  subject: Schema.optional(TrimmedNonEmptyString),
});
export type ExtensionsDiagnostic = typeof ExtensionsDiagnostic.Type;

export const ExtensionsListInput = Schema.Struct({});
export type ExtensionsListInput = typeof ExtensionsListInput.Type;

export const ExtensionsInventory = Schema.Struct({
  revision: Schema.Number,
  connectors: Schema.Array(ConnectorSummary),
  providerSupport: Schema.Array(ConnectorProviderSupport),
  plugins: Schema.Array(ScientPluginSummary),
  diagnostics: Schema.Array(ExtensionsDiagnostic),
});
export type ExtensionsInventory = typeof ExtensionsInventory.Type;

export const ExtensionsChangedEvent = Schema.Struct({ revision: Schema.Number });
export type ExtensionsChangedEvent = typeof ExtensionsChangedEvent.Type;

/** OAuth client the user registered with the vendor themselves. */
export const ConnectorOAuthClientInput = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  /** Confidential clients only. Held as connector-owned credential material. */
  clientSecret: Schema.optional(Schema.String),
});
export type ConnectorOAuthClientInput = typeof ConnectorOAuthClientInput.Type;

/** User- and registry-supplied text is bounded: it is persisted for every connector. */
const ConnectorNameInput = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const ConnectorDescriptionInput = TrimmedNonEmptyString.check(Schema.isMaxLength(1_000));
const ConnectorUrlInput = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));

const LocalPathInput = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const LocalTextInput = Schema.String.check(Schema.isMaxLength(4_096));

/** Environment variable names are portable shell names. */
export const LocalEnvironmentName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
);

/** A key for a local connector: an existing Accounts API-key account, or a value to save as one. */
export const LocalKeyInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("account"), ref: VaultSecretRef }),
  Schema.Struct({
    type: Schema.Literal("value"),
    value: TrimmedNonEmptyString.check(Schema.isMaxLength(65_536)),
  }),
]);
export type LocalKeyInput = typeof LocalKeyInput.Type;

/** Keys by field key (a bundle's `user_config` key, or a variable name). */
export const LocalKeysInput = Schema.Record(
  TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  LocalKeyInput,
);
export type LocalKeysInput = typeof LocalKeysInput.Type;

/** A variable for a typed command or a registry package; a `secret` one is passed as `key`. */
export const LocalEnvironmentInput = Schema.Struct({
  name: LocalEnvironmentName,
  value: LocalTextInput,
  secret: Schema.Boolean,
  /** For a secret variable: an existing Accounts key instead of `value`. */
  account: Schema.optional(VaultSecretRef),
});
export type LocalEnvironmentInput = typeof LocalEnvironmentInput.Type;

/** Plain answers by field key. Keys go in `LocalKeysInput`, never here. */
export const LocalBundleSettingsInput = Schema.Record(
  TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  Schema.Union([
    LocalTextInput,
    Schema.Number,
    Schema.Boolean,
    Schema.Array(LocalTextInput).check(Schema.isMaxLength(64)),
  ]),
);
export type LocalBundleSettingsInput = typeof LocalBundleSettingsInput.Type;

const LocalEnvironmentListInput = Schema.Array(LocalEnvironmentInput).check(Schema.isMaxLength(64));

/** An npm or PyPI package of an MCP Registry entry that runs locally over stdio. */
export const LocalPackage = Schema.Struct({
  runner: Schema.Literals(["npx", "uvx"]),
  identifier: TrimmedNonEmptyString.check(
    Schema.isMaxLength(214),
    Schema.isPattern(/^(?:@[a-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/),
  ),
  version: TrimmedNonEmptyString.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9][\w.+-]*$/),
  ),
  /** Fixed arguments the registry declares, after the package. */
  args: Schema.Array(LocalTextInput).check(Schema.isMaxLength(64)),
  environment: Schema.Array(
    Schema.Struct({
      name: LocalEnvironmentName,
      description: Schema.optional(Schema.String),
      required: Schema.Boolean,
      secret: Schema.Boolean,
      default: Schema.optional(Schema.String),
    }),
  ).check(Schema.isMaxLength(64)),
});
export type LocalPackage = typeof LocalPackage.Type;

/** An MCP Bundle (`.mcpb`) an MCP Registry entry publishes by https address and SHA-256. */
export const LocalBundleDownload = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048), Schema.isPattern(/^https:\/\//)),
  sha256: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type LocalBundleDownload = typeof LocalBundleDownload.Type;

/** Where a server set up in another app was found. */
export const LocalImportSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("app"),
    app: Schema.Literals(["claude-desktop", "claude-code", "codex", "cursor"]),
    /** Claude Code's servers for one folder. */
    folder: Schema.optional(LocalPathInput),
  }),
  /** A `.mcp.json` in a folder the user chose. */
  Schema.Struct({ type: Schema.Literal("file"), path: LocalPathInput }),
]);
export type LocalImportSource = typeof LocalImportSource.Type;

/** A local server another app runs. Variable values stay on the server. */
export const LocalImportableServer = Schema.Struct({
  source: LocalImportSource,
  /** "Claude Desktop", "Claude Code", "Codex", "Cursor", or the folder's name. */
  sourceLabel: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  commandLine: TrimmedNonEmptyString,
  /** Variables that look like keys; they become Accounts keys when added. */
  keys: Schema.Array(TrimmedNonEmptyString),
  installedConnectorId: Schema.optional(ConnectorId),
});
export type LocalImportableServer = typeof LocalImportableServer.Type;

export const ConnectorAddInput = Schema.Struct({
  target: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("registry"),
      name: ConnectorNameInput,
      version: ConnectorNameInput,
      /** Which `streamable-http` remote of the registry entry to use. */
      url: ConnectorUrlInput,
    }),
    Schema.Struct({ type: Schema.Literal("url"), url: ConnectorUrlInput }),
    /** A `.mcpb` or `.zip` file, or a bundle folder, as a path on the environment's computer. */
    Schema.Struct({
      type: Schema.Literal("local-bundle"),
      path: LocalPathInput,
      settings: LocalBundleSettingsInput,
      keys: LocalKeysInput,
    }),
    /** A server another app runs, or one entry of a folder's `.mcp.json`. */
    Schema.Struct({
      type: Schema.Literal("local-import"),
      source: LocalImportSource,
      name: ConnectorNameInput,
    }),
    Schema.Struct({
      type: Schema.Literal("local-command"),
      command: LocalPathInput,
      args: Schema.Array(LocalTextInput).check(Schema.isMaxLength(64)),
      environment: LocalEnvironmentListInput,
    }),
    /** A registry entry's `localPackage`, as Discover returned it. */
    Schema.Struct({
      type: Schema.Literal("local-package"),
      name: ConnectorNameInput,
      version: ConnectorNameInput,
      package: LocalPackage,
      environment: LocalEnvironmentListInput,
    }),
    /** A registry entry's `localBundle`: downloaded, checked against its hash, unpacked. */
    Schema.Struct({
      type: Schema.Literal("registry-bundle"),
      name: ConnectorNameInput,
      version: ConnectorNameInput,
      bundle: LocalBundleDownload,
    }),
  ]),
  displayName: Schema.optional(ConnectorNameInput),
  /** Shown in Installed; from the Discover entry the connector was added from. */
  description: Schema.optional(ConnectorDescriptionInput),
  oauthClient: Schema.optional(ConnectorOAuthClientInput),
  /** API-key style servers. */
  credential: Schema.optional(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("entered"),
        strategy: CredentialStrategy,
        headerName: Schema.optional(TrimmedNonEmptyString),
        /** Token, header value, or `user:password` for `basic`. Stored connector-owned; never returned. */
        value: TrimmedNonEmptyString,
      }),
      Schema.Struct({
        type: Schema.Literal("bound"),
        strategy: CredentialStrategy,
        headerName: Schema.optional(TrimmedNonEmptyString),
        /** A user secret; adding the connector is the user's binding confirmation. */
        secretRef: VaultSecretRef,
      }),
      /** GitHub's own MCP server only: Source Control's GitHub account. */
      Schema.Struct({
        type: Schema.Literal("source-control"),
        /** One of Source Control's GitHub logins; Source Control's own choice when absent. */
        account: Schema.optional(TrimmedNonEmptyString),
      }),
    ]),
  ),
});
export type ConnectorAddInput = typeof ConnectorAddInput.Type;

export const ConnectorAddResult = Schema.Struct({
  connector: ConnectorSummary,
  /** `sign-in-required`: call `startSignIn` to obtain an authorization URL. */
  nextStep: Schema.Literals(["ready", "sign-in-required"]),
});
export type ConnectorAddResult = typeof ConnectorAddResult.Type;

export const ConnectorStartSignInInput = Schema.Struct({
  connectorId: ConnectorId,
  /**
   * Origin of the Scient server as reached by the requesting client
   * (`http://127.0.0.1:<port>`, `http://localhost:<port>` or `https://…`).
   * The OAuth redirect URI is `<callbackOrigin>/oauth/connectors/callback`.
   */
  callbackOrigin: TrimmedNonEmptyString,
});
export type ConnectorStartSignInInput = typeof ConnectorStartSignInInput.Type;

export const ConnectorStartSignInResult = Schema.Struct({
  authorizationUrl: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ConnectorStartSignInResult = typeof ConnectorStartSignInResult.Type;

export const ConnectorUpdateInput = Schema.Struct({
  connectorId: ConnectorId,
  displayName: Schema.optional(ConnectorNameInput),
  enabled: Schema.optional(Schema.Boolean),
  availability: Schema.optional(GrantScope),
  /** Local connectors: stop every running copy; agents start a fresh one on their next request. */
  restart: Schema.optional(Schema.Literal(true)),
  /** Local connectors: change settings and keys; running copies restart. */
  localSetup: Schema.optional(
    Schema.Struct({
      settings: LocalBundleSettingsInput,
      keys: LocalKeysInput,
      /** The Accounts website or university sign-in it uses for its `signIn` site. */
      signIn: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ConnectorUpdateInput = typeof ConnectorUpdateInput.Type;

/** Undoes the last change to a local connector's folder, or brings a removed one back. */
export const ConnectorUndoInput = Schema.Struct({ connectorId: ConnectorId });
export type ConnectorUndoInput = typeof ConnectorUndoInput.Type;

export const ConnectorExportInput = Schema.Struct({ connectorId: ConnectorId });
export type ConnectorExportInput = typeof ConnectorExportInput.Type;

/** A local connector as an MCP Bundle (`.mcpb`), to share. */
export const ConnectorExport = Schema.Struct({
  fileName: TrimmedNonEmptyString,
  base64: Schema.String,
});
export type ConnectorExport = typeof ConnectorExport.Type;

export const LocalBundleInspectInput = Schema.Struct({ path: LocalPathInput });
export type LocalBundleInspectInput = typeof LocalBundleInspectInput.Type;

export const LocalBundleInspection = Schema.Struct({
  kind: Schema.Literal("bundle"),
  name: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  author: Schema.optional(TrimmedNonEmptyString),
  runtime: Schema.Literals(["node", "python", "binary", "uv"]),
  fields: Schema.Array(LocalBundleField),
  tools: Schema.Array(
    Schema.Struct({ name: TrimmedNonEmptyString, description: Schema.optional(Schema.String) }),
  ),
  /** Set when this computer cannot run the bundle, for example a missing `uv`. */
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
});
export type LocalBundleInspection = typeof LocalBundleInspection.Type;

/** What a picked file or folder holds: a bundle, or servers listed in its `.mcp.json`. */
export const LocalInspection = Schema.Union([
  LocalBundleInspection,
  Schema.Struct({ kind: Schema.Literal("servers"), servers: Schema.Array(LocalImportableServer) }),
  /** A Scient plugin folder (`scient.plugin.json`), installed as a plugin instead. */
  Schema.Struct({ kind: Schema.Literal("plugin"), displayName: Schema.String }),
]);
export type LocalInspection = typeof LocalInspection.Type;

export const LocalImportablesResult = Schema.Struct({
  servers: Schema.Array(LocalImportableServer),
});
export type LocalImportablesResult = typeof LocalImportablesResult.Type;

export const ConnectorRemoveInput = Schema.Struct({ connectorId: ConnectorId });
export type ConnectorRemoveInput = typeof ConnectorRemoveInput.Type;

export const ConnectorTestInput = Schema.Struct({ connectorId: ConnectorId });
export type ConnectorTestInput = typeof ConnectorTestInput.Type;

export const ConnectorToolSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  readOnly: Schema.optional(Schema.Boolean),
  destructive: Schema.optional(Schema.Boolean),
  parameters: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
        type: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
        required: Schema.Boolean,
        description: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
      }),
    ).check(Schema.isMaxLength(50)),
  ),
});
export type ConnectorToolSummary = typeof ConnectorToolSummary.Type;

export const ConnectorTestResult = Schema.Struct({
  connectorId: ConnectorId,
  outcome: Schema.Literals(["ok", "needs-auth", "needs-setup", "unreachable", "error"]),
  checkedAt: IsoDateTime,
  serverName: Schema.optional(TrimmedNonEmptyString),
  serverVersion: Schema.optional(TrimmedNonEmptyString),
  tools: Schema.Array(ConnectorToolSummary),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ConnectorTestResult = typeof ConnectorTestResult.Type;

/** Scient-curated catalog sections. Registry servers without curation appear only under "all". */
export const ExtensionCategory = Schema.Literals([
  "most-used",
  "papers",
  "biology",
  "code",
  "data",
  "physics-math",
  "files",
  "communication",
  "projects",
  "figures",
  "chemistry",
  "earth",
  "social-science",
]);
export type ExtensionCategory = typeof ExtensionCategory.Type;

/**
 * `curated`: Scient's catalog, answered locally without the network.
 * `registry`: the MCP Registry, without the servers the same curated query returns.
 */
export const DiscoverSearchScope = Schema.Literals(["curated", "registry"]);
export type DiscoverSearchScope = typeof DiscoverSearchScope.Type;

export const DiscoverSearchInput = Schema.Struct({
  scope: DiscoverSearchScope,
  query: Schema.optional(Schema.String),
  /** Curated membership or server-owned Registry keyword searches. */
  category: Schema.optional(ExtensionCategory),
  /** `registry` only: the registry's paging cursor. */
  cursor: Schema.optional(TrimmedNonEmptyString),
  /** `registry` only: page size, 1 to 100. */
  limit: Schema.optional(Schema.Number),
});
export type DiscoverSearchInput = typeof DiscoverSearchInput.Type;

export const DiscoverRemote = Schema.Struct({
  type: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  /** Headers or URL variables the user must supply; such remotes are not one-click installable. */
  requiresInput: Schema.Boolean,
});
export type DiscoverRemote = typeof DiscoverRemote.Type;

export const DiscoverEntry = Schema.Struct({
  agentStores: Schema.optional(ExtensionAgentStores),
  accountRequired: Schema.optional(Schema.Boolean),
  oauthClientRequired: Schema.optional(Schema.Boolean),
  hosting: Schema.optional(TrimmedNonEmptyString),
  paidPlan: Schema.optional(Schema.Boolean),
  beta: Schema.optional(Schema.Boolean),
  accessNote: Schema.optional(TrimmedNonEmptyString),
  apiKey: Schema.optional(
    Schema.Struct({
      strategy: CredentialStrategy,
      headerName: Schema.optional(TrimmedNonEmptyString),
      fieldLabel: TrimmedNonEmptyString,
      helpUrl: TrimmedNonEmptyString,
    }),
  ),
  address: Schema.optional(
    Schema.Struct({
      urlTemplate: TrimmedNonEmptyString,
      fieldLabel: TrimmedNonEmptyString,
      placeholder: TrimmedNonEmptyString,
    }),
  ),
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  /** One line for list rows; curated entries always have one. */
  tagline: Schema.optional(TrimmedNonEmptyString),
  /** Logo from the curated catalog, inlined; uncurated registry entries have none. */
  iconUrl: Schema.optional(ExtensionIconDataUri),
  /** Curated categories this entry belongs to; empty for uncurated registry entries. */
  categories: Schema.Array(ExtensionCategory),
  websiteUrl: Schema.optional(TrimmedNonEmptyString),
  repositoryUrl: Schema.optional(TrimmedNonEmptyString),
  remotes: Schema.Array(DiscoverRemote),
  /** A registry package Scient can run locally; offered only when no remote is installable. */
  localPackage: Schema.optional(LocalPackage),
  /** A registry bundle Scient can download and run; offered when nothing above is. */
  localBundle: Schema.optional(LocalBundleDownload),
  installable: Schema.Boolean,
  /** Why the entry cannot be installed as a connector (for example local packages only). */
  unsupportedReason: Schema.optional(TrimmedNonEmptyString),
  publishedAt: Schema.optional(IsoDateTime),
  /** A connector created from this entry already exists. */
  installedConnectorId: Schema.optional(ConnectorId),
});
export type DiscoverEntry = typeof DiscoverEntry.Type;

export const DiscoverCatalogSection = Schema.Struct({
  category: ExtensionCategory,
  title: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  /** Preview entries for the home page, in curated order. */
  entries: Schema.Array(DiscoverEntry),
  total: Schema.Number,
});
export type DiscoverCatalogSection = typeof DiscoverCatalogSection.Type;

export const DiscoverCatalog = Schema.Struct({
  sections: Schema.Array(DiscoverCatalogSection),
  fetchedAt: IsoDateTime,
});
export type DiscoverCatalog = typeof DiscoverCatalog.Type;

/** Exact lookup of one curated or registry entry by name; fails with `not-found`. */
export const DiscoverEntryInput = Schema.Struct({ name: TrimmedNonEmptyString });
export type DiscoverEntryInput = typeof DiscoverEntryInput.Type;

export const DiscoverPage = Schema.Struct({
  message: Schema.optional(Schema.String),
  entries: Schema.Array(DiscoverEntry),
  nextCursor: Schema.optional(TrimmedNonEmptyString),
  fetchedAt: IsoDateTime,
});
export type DiscoverPage = typeof DiscoverPage.Type;

export const ScientPluginInstallInput = Schema.Struct({
  /** Absolute path on the server host to a bundle directory containing `scient.plugin.json`. */
  path: TrimmedNonEmptyString,
});
export type ScientPluginInstallInput = typeof ScientPluginInstallInput.Type;

export const ScientPluginRemoveInput = Schema.Struct({ pluginId: ScientPluginId });
export type ScientPluginRemoveInput = typeof ScientPluginRemoveInput.Type;

export const ScientPluginSetEnabledInput = Schema.Struct({
  pluginId: ScientPluginId,
  enabled: Schema.Boolean,
});
export type ScientPluginSetEnabledInput = typeof ScientPluginSetEnabledInput.Type;

export const ExtensionDeliverySkipReason = Schema.Literals([
  "needs-auth",
  "needs-credential",
  "disabled",
  "project-deselected",
  "transport-unsupported",
  "name-collision",
  /** The agent could not say which MCP servers it already has, so no connector name was safe. */
  "native-servers-unknown",
  /** The agent was given the connector but could not register or connect it. */
  "registration-failed",
]);
export type ExtensionDeliverySkipReason = typeof ExtensionDeliverySkipReason.Type;

/**
 * One thing a provider session can reach. Discriminated by `kind` so other
 * owners (Secrets: `secret-binding`) append variants without changing this one.
 */
export const ExtensionDeliveryEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("connector"),
    connectorId: ConnectorId,
    serverName: ConnectorServerName,
    displayName: TrimmedNonEmptyString,
  }),
]);
export type ExtensionDeliveryEntry = typeof ExtensionDeliveryEntry.Type;

export const ExtensionDeliveryReceipt = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  issuedAt: IsoDateTime,
  delivered: Schema.Array(ExtensionDeliveryEntry),
  skipped: Schema.Array(
    Schema.Struct({ entry: ExtensionDeliveryEntry, reason: ExtensionDeliverySkipReason }),
  ),
});
export type ExtensionDeliveryReceipt = typeof ExtensionDeliveryReceipt.Type;

export const ExtensionDeliveryReceiptInput = Schema.Struct({ threadId: ThreadId });
export type ExtensionDeliveryReceiptInput = typeof ExtensionDeliveryReceiptInput.Type;

export const ExtensionDeliveryReceiptResult = Schema.Struct({
  receipt: Schema.optional(ExtensionDeliveryReceipt),
});
export type ExtensionDeliveryReceiptResult = typeof ExtensionDeliveryReceiptResult.Type;

export const ProviderPluginActionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("refresh-inventory"),
      connectionsOnly: Schema.optional(Schema.Boolean),
    }),
    Schema.Struct({
      type: Schema.Literal("install"),
      entryId: TrimmedNonEmptyString,
      sourceInstanceId: Schema.optional(ProviderInstanceId),
    }),
    Schema.Struct({ type: Schema.Literal("add-official-store") }),
    Schema.Struct({
      type: Schema.Literal("set-enabled"),
      pluginId: TrimmedNonEmptyString,
      enabled: Schema.Boolean,
    }),
    Schema.Struct({ type: Schema.Literal("uninstall"), pluginId: TrimmedNonEmptyString }),
    Schema.Struct({ type: Schema.Literal("mcp-sign-in"), serverName: TrimmedNonEmptyString }),
  ]),
  /** Workspace whose provider snapshot lists the plugin, for workspace-scoped plugins. */
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderPluginActionInput = typeof ProviderPluginActionInput.Type;

export const ProviderPluginActionResult = Schema.Struct({
  appsNeedingAuth: Schema.optional(Schema.Array(ProviderStoreApp)),
  authPolicy: Schema.optional(Schema.String),
  /** Provider-owned sign-in page to open in the user's browser. */
  authorizationUrl: Schema.optional(TrimmedNonEmptyString),
  providers: ServerProviders,
});
export type ProviderPluginActionResult = typeof ProviderPluginActionResult.Type;

export class ExtensionsError extends Schema.TaggedError<ExtensionsError>()("ExtensionsError", {
  reason: Schema.Literals([
    "not-found",
    "invalid-input",
    "unreachable",
    "not-an-mcp-server",
    "sign-in-failed",
    "registration-unsupported",
    "limit-reached",
    "state-unavailable",
    "unsupported",
    "provider-rejected",
  ]),
  message: TrimmedNonEmptyString,
}) {}

/** Match a single tenant label without credentials or extra URL components. */
export function matchesExtensionAddressTemplate(value: string, template: string): boolean {
  try {
    const url = new URL(value.trim());
    const expected = new URL(template.replace("<tenant>", "tenant"));
    const suffix = expected.hostname.slice("tenant".length);
    const tenant = url.hostname.slice(0, -suffix.length);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname === expected.pathname &&
      url.hostname.endsWith(suffix) &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tenant)
    )
      return true;
  } catch {
    // Invalid URLs cannot match a template.
  }
  return false;
}
