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
export * from "./pluginContents.ts";

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
]);
export type ConnectorSource = typeof ConnectorSource.Type;

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
]);
export type ConnectorAuthSummary = typeof ConnectorAuthSummary.Type;

/**
 * `needs-auth`: OAuth sign-in required. `needs-credential`: the bound or owned
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
});
export type ConnectorUpdateInput = typeof ConnectorUpdateInput.Type;

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
  outcome: Schema.Literals(["ok", "needs-auth", "unreachable", "error"]),
  checkedAt: IsoDateTime,
  serverName: Schema.optional(TrimmedNonEmptyString),
  serverVersion: Schema.optional(TrimmedNonEmptyString),
  tools: Schema.Array(ConnectorToolSummary),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ConnectorTestResult = typeof ConnectorTestResult.Type;

/** Scient-curated catalog sections. Registry servers without curation appear only under "all". */
export const ExtensionCategory = Schema.Literals([
  "featured",
  "research",
  "data",
  "code",
  "writing",
  "communication",
  "design",
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
  /** Restrict a `curated` search to one category; invalid with `registry`. */
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
