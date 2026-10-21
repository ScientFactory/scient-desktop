/**
 * Service boundaries of Scient Extensions. Each service has one owning module
 * that provides its `layer`; consumers depend only on these tags.
 * See docs/internals/scient-extensions.md.
 */
import type {
  ConnectorAddInput,
  ConnectorAddResult,
  ConnectorId,
  ConnectorRemoveInput,
  ConnectorStartSignInInput,
  ConnectorStartSignInResult,
  ConnectorSummary,
  ConnectorTestInput,
  ConnectorTestResult,
  ConnectorUpdateInput,
  DiscoverCatalog,
  DiscoverPage,
  DiscoverSearchInput,
  ExtensionDeliveryReceipt,
  ExtensionDeliverySkipReason,
  ExtensionsChangedEvent,
  ExtensionsDiagnostic,
  ExtensionsError,
  ProjectId,
  ProviderPluginActionInput,
  ProviderPluginActionResult,
  ScientPluginInstallInput,
  ScientPluginRemoveInput,
  ScientPluginSetEnabledInput,
  ScientPluginSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";

/** A connector eligible for a session before adapter transport checks. */
export interface EligibleConnector {
  readonly connectorId: ConnectorId;
  readonly serverName: string;
  readonly displayName: string;
}

export interface ConnectorDeliveryResolution {
  readonly eligible: ReadonlyArray<EligibleConnector>;
  readonly skipped: ReadonlyArray<
    EligibleConnector & { readonly reason: ExtensionDeliverySkipReason }
  >;
}

/** Headers the proxy forwards in either direction. Everything else is dropped. */
export const CONNECTOR_FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

export interface ConnectorForwardRequest {
  readonly connectorId: ConnectorId;
  readonly method: "GET" | "POST" | "DELETE";
  /** Lower-cased, already filtered to CONNECTOR_FORWARDED_REQUEST_HEADERS. */
  readonly headers: Readonly<Record<string, string>>;
  /** Buffered request body (POST only), bounded by the route. */
  readonly body: Uint8Array | undefined;
  /** Server-derived caller identity; never request-supplied. */
  readonly scope: McpInvocationScope;
}

export interface ConnectorForwardResponse {
  readonly status: number;
  /** Lower-cased response headers safe to return to the agent. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Stream.Stream<Uint8Array>;
}

export interface ConnectorSignInCallbackQuery {
  readonly state: string | undefined;
  readonly code: string | undefined;
  readonly error: string | undefined;
  readonly errorDescription: string | undefined;
}

export interface ConnectorSignInCallbackOutcome {
  readonly outcome: "connected" | "failed";
  readonly displayName: string | undefined;
  readonly message: string;
}

export interface ConnectorRuntimeShape {
  readonly list: () => Effect.Effect<{
    readonly revision: number;
    readonly connectors: ReadonlyArray<ConnectorSummary>;
    readonly diagnostics: ReadonlyArray<ExtensionsDiagnostic>;
  }>;
  /** Emits after every committed change to connectors (availability included). */
  readonly changes: Stream.Stream<ExtensionsChangedEvent>;
  readonly add: (input: ConnectorAddInput) => Effect.Effect<ConnectorAddResult, ExtensionsError>;
  /** Connector definitions contributed by an installed Scient plugin bundle. Never signs in. */
  readonly addFromPlugin: (input: {
    readonly pluginId: string;
    readonly url: string;
    readonly displayName: string;
    readonly description: string | undefined;
  }) => Effect.Effect<ConnectorId, ExtensionsError>;
  readonly removeByPlugin: (pluginId: string) => Effect.Effect<void, ExtensionsError>;
  readonly startSignIn: (
    input: ConnectorStartSignInInput,
  ) => Effect.Effect<ConnectorStartSignInResult, ExtensionsError>;
  readonly completeSignIn: (
    query: ConnectorSignInCallbackQuery,
  ) => Effect.Effect<ConnectorSignInCallbackOutcome>;
  /** `availability` project ids must exist; they are deduplicated before saving. */
  readonly update: (input: ConnectorUpdateInput) => Effect.Effect<void, ExtensionsError>;
  readonly remove: (input: ConnectorRemoveInput) => Effect.Effect<void, ExtensionsError>;
  readonly test: (input: ConnectorTestInput) => Effect.Effect<ConnectorTestResult, ExtensionsError>;
  /** Connectors a new session in this project may receive, plus user-facing skips. */
  readonly resolveDelivery: (input: {
    readonly projectId: ProjectId | undefined;
  }) => Effect.Effect<ConnectorDeliveryResolution>;
  /** Live grant re-check for each proxied request. */
  readonly isGranted: (input: {
    readonly connectorId: ConnectorId;
    readonly projectId: ProjectId | undefined;
  }) => Effect.Effect<boolean>;
  /** Forward one MCP HTTP exchange with the vendor credential applied. Never fails: errors become JSON-RPC responses. */
  readonly forward: (request: ConnectorForwardRequest) => Effect.Effect<ConnectorForwardResponse>;
}

export class ConnectorRuntime extends Context.Service<ConnectorRuntime, ConnectorRuntimeShape>()(
  "t3/scient/extensions/ExtensionsServices/ConnectorRuntime",
) {}

export interface ExtensionDeliveryReceiptsShape {
  /**
   * Records the receipt prepared for a credential. `withheld`, when given, is
   * the credential's latest settled registration outcome and is applied in the
   * same step; otherwise the previous report is kept only if the thread's
   * receipt already belonged to this credential.
   */
  readonly record: (
    receipt: ExtensionDeliveryReceipt,
    options?: {
      readonly withheld?: ReadonlyArray<{
        readonly serverName: string;
        readonly reason: ExtensionDeliverySkipReason;
      }>;
    },
  ) => Effect.Effect<void>;
  /**
   * A settled adapter connector registration for the credential
   * `providerSessionId`: the delivered connectors it left out (a
   * provider-native server owns the name, the agent's servers were unknown,
   * or registering failed). Replaces the previous report for that credential,
   * so connectors a later registration did register return to delivered.
   * Ignored while another credential owns the thread's receipt. Ordering
   * between overlapping registrations is the caller's: see
   * `ConnectorSessionDelivery.registrationTrackerFor`.
   */
  readonly reportRegistration: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
    readonly withheld: ReadonlyArray<{
      readonly serverName: string;
      readonly reason: ExtensionDeliverySkipReason;
    }>;
  }) => Effect.Effect<void>;
  readonly get: (threadId: ThreadId) => Effect.Effect<Option.Option<ExtensionDeliveryReceipt>>;
  /** Emits the thread whose visible receipt just changed. */
  readonly changes: Stream.Stream<ThreadId>;
}

export class ExtensionDeliveryReceipts extends Context.Service<
  ExtensionDeliveryReceipts,
  ExtensionDeliveryReceiptsShape
>()("t3/scient/extensions/ExtensionsServices/ExtensionDeliveryReceipts") {}

export interface ExtensionsDiscoverShape {
  readonly search: (input: DiscoverSearchInput) => Effect.Effect<DiscoverPage, ExtensionsError>;
  /** Curated home page: non-empty categories in fixed order, each with preview entries. */
  readonly catalog: () => Effect.Effect<DiscoverCatalog, ExtensionsError>;
  /**
   * Curated icons (`data:` URIs) for connector URLs that match a curated
   * server, keyed by the given URL. Never waits: icons still loading are left
   * out and announced on `changes` once they arrive.
   */
  readonly connectorIcons: (
    urls: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string>>;
  /** Emits when icons that earlier responses left out have become available. */
  readonly changes: Stream.Stream<void>;
}

export class ExtensionsDiscover extends Context.Service<
  ExtensionsDiscover,
  ExtensionsDiscoverShape
>()("t3/scient/extensions/ExtensionsServices/ExtensionsDiscover") {}

export interface ScientPluginRegistryShape {
  readonly list: () => Effect.Effect<{
    readonly plugins: ReadonlyArray<ScientPluginSummary>;
    readonly diagnostics: ReadonlyArray<ExtensionsDiagnostic>;
  }>;
  readonly install: (input: ScientPluginInstallInput) => Effect.Effect<void, ExtensionsError>;
  readonly remove: (input: ScientPluginRemoveInput) => Effect.Effect<void, ExtensionsError>;
  readonly setEnabled: (input: ScientPluginSetEnabledInput) => Effect.Effect<void, ExtensionsError>;
  /** Emits after install, removal, or enablement changes. */
  readonly changes: Stream.Stream<void>;
}

export class ScientPluginRegistry extends Context.Service<
  ScientPluginRegistry,
  ScientPluginRegistryShape
>()("t3/scient/extensions/ExtensionsServices/ScientPluginRegistry") {}

export interface ProviderPluginManagementShape {
  readonly act: (
    input: ProviderPluginActionInput,
  ) => Effect.Effect<ProviderPluginActionResult, ExtensionsError>;
}

export class ProviderPluginManagement extends Context.Service<
  ProviderPluginManagement,
  ProviderPluginManagementShape
>()("t3/scient/extensions/ExtensionsServices/ProviderPluginManagement") {}
