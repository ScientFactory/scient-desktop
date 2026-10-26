/**
 * Scient's optional per-instance seams on `ProviderInstance`: voice transcript
 * correction, native skill activation, native plugin management, assisted
 * account connection and app-managed runtime actions. Drivers that leave them
 * absent keep pure T3 behaviour.
 */
import type {
  ExtensionPluginContents,
  ExtensionSkillDocument,
  ModelSelection,
  ProviderStoreInstallResult,
  ProviderStoreEntry,
  ProviderStorePage,
  ProviderStoreSearchInput,
  ProviderAuthorizationUrlKind,
  ProviderConnectionMethod,
  ProviderManagedRuntimeAction,
  ProviderRuntimeOperationStatus,
  ProviderRuntimePlan,
  ProviderRuntimeSummary,
  ServerProviderMcpServer,
  ServerProviderPlugin,
  VoiceTranscriptionLanguage,
  VoiceTranscriptCorrectionError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

/** Optional, tightly sandboxed one-shot cleanup for local voice transcripts. */
export interface ProviderVoiceTranscriptCorrection {
  readonly correct: (input: {
    readonly transcript: string;
    readonly language?: VoiceTranscriptionLanguage;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<{ readonly text: string }, VoiceTranscriptCorrectionError>;
}

export interface ProviderSkillActionFailure {
  readonly message: string;
  readonly cause?: unknown;
}

export interface ProviderSkillActions {
  readonly setEnabled: (input: {
    readonly name: string;
    readonly path: string;
    readonly scope?: string | undefined;
    readonly enabled: boolean;
  }) => Effect.Effect<{ readonly effectiveEnabled: boolean }, ProviderSkillActionFailure>;
}

export interface ProviderPluginActionFailure {
  readonly message: string;
  readonly cause?: unknown;
}

/** A provider-owned MCP server sign-in waiting for the user's browser. */
export interface ProviderMcpSignInAttempt {
  readonly authorizationUrl: string;
  /**
   * Settles when the provider reports the sign-in finished. The provider
   * process that receives the browser callback lives in the scope the attempt
   * was started in, so the caller keeps that scope open until this settles.
   */
  readonly waitForCompletion: Effect.Effect<void, ProviderPluginActionFailure>;
}

/**
 * Reads and mutations a provider exposes for its own plugins and MCP servers.
 * One object belongs to one instance generation: every member reads or
 * changes the configuration that generation was created with.
 */
export interface ProviderPluginActions {
  readonly store?:
    | {
        readonly contents?:
          | ((id: string) => Effect.Effect<ExtensionPluginContents, ProviderPluginActionFailure>)
          | undefined;
        readonly skillDocument?:
          | ((
              id: string,
              skillId: string,
            ) => Effect.Effect<ExtensionSkillDocument, ProviderPluginActionFailure>)
          | undefined;
        readonly changes?: Stream.Stream<void> | undefined;
        readonly marketplaceSource?:
          | ((entryId: string) => Effect.Effect<string, ProviderPluginActionFailure>)
          | undefined;
        readonly ensureMarketplace?:
          | ((input: {
              readonly name: string;
              readonly source: string;
            }) => Effect.Effect<void, ProviderPluginActionFailure>)
          | undefined;
        readonly search: (
          input: Omit<ProviderStoreSearchInput, "instanceId">,
        ) => Effect.Effect<ProviderStorePage, ProviderPluginActionFailure>;
        readonly entry: (
          entryId: string,
        ) => Effect.Effect<ProviderStoreEntry, ProviderPluginActionFailure>;
        readonly install: (
          entryId: string,
        ) => Effect.Effect<void | ProviderStoreInstallResult, ProviderPluginActionFailure>;
        readonly addOfficialStore?:
          | (() => Effect.Effect<void, ProviderPluginActionFailure>)
          | undefined;
      }
    | undefined;
  readonly refreshInventory?:
    | ((input: {
        readonly force: boolean;
        readonly connectionsOnly?: boolean | undefined;
      }) => Effect.Effect<void, ProviderPluginActionFailure>)
    | undefined;
  /**
   * A fresh listing of the plugins this generation sees, in `cwd` when given.
   * Fails unless the provider listed every plugin source.
   */
  readonly listPlugins: (input: {
    readonly cwd?: string | undefined;
  }) => Effect.Effect<ProviderPluginListing, ProviderPluginActionFailure>;
  /** Fresh status of one configured MCP server; `undefined` when it is not configured. */
  readonly readMcpServer: (input: {
    readonly serverName: string;
  }) => Effect.Effect<ServerProviderMcpServer | undefined, ProviderPluginActionFailure>;
  readonly setEnabled?:
    | ((input: {
        readonly pluginId: string;
        readonly enabled: boolean;
        readonly cwd?: string | undefined;
      }) => Effect.Effect<void, ProviderPluginActionFailure>)
    | undefined;
  readonly uninstall: (input: {
    readonly pluginId: string;
    /** Workspace whose provider inventory lists the plugin. */
    readonly cwd?: string | undefined;
  }) => Effect.Effect<void, ProviderPluginActionFailure>;
  readonly startMcpSignIn: (input: {
    readonly serverName: string;
  }) => Effect.Effect<ProviderMcpSignInAttempt, ProviderPluginActionFailure, Scope.Scope>;
  /** Whether this generation was rebuilt, disabled, or removed. */
  readonly isRetired: Effect.Effect<boolean>;
  /** Completes when this generation is retired. */
  readonly whenRetired: Effect.Effect<void>;
}

/** A complete plugin listing and when it began, as `nextInventoryReadSequence` orders reads. */
export interface ProviderPluginListing {
  readonly plugins: ReadonlyArray<ServerProviderPlugin>;
  readonly sequence: number;
}

/**
 * Provider-native inventory reported outside the status probe: by live
 * sessions or by bounded inventory enrichment. A report carries only the
 * fields the provider listed completely; absent fields keep the last report.
 * With `cwd`, the report is the plugins of that one workspace.
 */
export interface ProviderNativeInventory {
  readonly cwd?: string | undefined;
  readonly plugins?: ReadonlyArray<ServerProviderPlugin>;
  readonly mcpServers?: ReadonlyArray<ServerProviderMcpServer>;
  /**
   * When the read began (`nextInventoryReadSequence`). A field is applied
   * only if no read of the same scope that began later was applied already.
   * Absent means the report is current as it arrives, as live sessions are.
   */
  readonly sequence?: number | undefined;
}

/**
 * Workspace plugin listing that runs after a workspace scan is published, so
 * a slow listing never delays the scan. Owned by the instance; its reports
 * arrive on the instance's native inventory stream with `cwd` set.
 */
export interface ProviderWorkspaceInventory {
  /** A newer scan of `cwd` started: stop any listing still running for it. */
  readonly cancel: (cwd: string) => Effect.Effect<void>;
  /** Start a bounded listing of `cwd` in the background, replacing a running one. */
  readonly refresh: (cwd: string) => Effect.Effect<void>;
  /**
   * Stop every queued or running listing of a workspace outside `current`,
   * the workspaces whose snapshots are published now. `current` is read
   * under the lock that starts listings, so concurrent scans cannot race it.
   */
  readonly retain: (current: Effect.Effect<ReadonlySet<string>>) => Effect.Effect<void>;
}

export interface ProviderConnectionActionFailure {
  readonly message: string;
  readonly cause?: unknown;
  /**
   * An account sign-out failed without the provider saying it kept the
   * sign-in (its process ended, or never answered). The manager then treats
   * the sign-in as possibly removed.
   */
  readonly signInMayBeRemoved?: boolean | undefined;
  /** The provider accepted the sign-in; the failure came while finishing its setup. */
  readonly afterSignIn?: boolean | undefined;
}

export interface ProviderConnectionAttempt {
  /** Present only when the provider exposes a browser URL to Scient. */
  readonly authorizationUrl?: string | undefined;
  /** Explicitly declares whether the client should open this URL automatically. */
  readonly authorizationUrlKind?: ProviderAuthorizationUrlKind | undefined;
  /** Explicit initial state; never inferred from method names, URLs, or codes. */
  readonly initialStatus: "waiting_for_browser" | "waiting_for_device_code" | "verifying";
  readonly userCode?: string | undefined;
  /** What the provider asks the user to do or paste, shown as written. */
  readonly instructions?: string | undefined;
  readonly authorizationResponseKind?: "code" | "callback_url" | undefined;
  /**
   * Some official browser flows return a code or redirect URL that must be handed
   * back to the provider CLI. The response is written directly to the live
   * provider process and is never persisted in Scient state.
   */
  readonly submitAuthorizationCode?:
    | ((code: string) => Effect.Effect<void, ProviderConnectionActionFailure>)
    | undefined;
  /**
   * After each provider question, re-arm this wait so the manager can republish answer
   * availability; some flows ask again after the link or a submitted answer.
   */
  readonly nextQuestion?:
    | Effect.Effect<{
        readonly instructions?: string | undefined;
        readonly submitAuthorizationCode: (
          code: string,
        ) => Effect.Effect<void, ProviderConnectionActionFailure>;
      }>
    | undefined;
  readonly waitForCompletion: Effect.Effect<void, ProviderConnectionActionFailure>;
  readonly cancel: Effect.Effect<void, ProviderConnectionActionFailure>;
}

/**
 * Minimal optional driver SPI for official provider-owned account flows.
 * Drivers retain credential ownership; the registry only supervises state.
 */
export interface ProviderConnectionActions {
  readonly methods: ReadonlyArray<ProviderConnectionMethod>;
  /** Shown while `start` runs, for a provider whose start can take noticeably long. */
  readonly startingMessage?: string | undefined;
  /**
   * `account` names an entry of the provider's own sign-in list. The manager
   * passes it only for a provider whose snapshot lists accounts, and only an
   * id from that list.
   */
  readonly start: (
    method: ProviderConnectionMethod,
    account?: string,
  ) => Effect.Effect<ProviderConnectionAttempt, ProviderConnectionActionFailure, Scope.Scope>;
  readonly disconnect: Effect.Effect<void, ProviderConnectionActionFailure, Scope.Scope>;
  /**
   * The provider signs in to accounts from its own list, never to a single
   * account. The manager then starts nothing, and publishes nothing, without
   * an account from that list.
   */
  readonly requiresAccount?: boolean | undefined;
  /** Signs out of one entry of the provider's sign-in list. */
  readonly disconnectAccount?:
    | ((account: string) => Effect.Effect<void, ProviderConnectionActionFailure, Scope.Scope>)
    | undefined;
}

export interface ProviderManagedRuntimeProgress {
  readonly status: ProviderRuntimeOperationStatus;
  readonly message: string;
  readonly downloadedBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
  readonly waitingForIdle?: boolean | undefined;
}

export interface ProviderManagedRuntimeActions {
  readonly getSummary: Effect.Effect<ProviderRuntimeSummary, ProviderConnectionActionFailure>;
  readonly plan: (
    action: ProviderManagedRuntimeAction,
  ) => Effect.Effect<Omit<ProviderRuntimePlan, "instanceId">, ProviderConnectionActionFailure>;
  /**
   * Downloads and staging may run while the provider is busy, but awaitActivationWindow must finish
   * immediately before live runtime mutation. The manager waits for work and stops sessions; only
   * direct callers such as tests may omit it.
   */
  readonly run: (
    action: ProviderManagedRuntimeAction,
    catalogRevision: string,
    report: (progress: ProviderManagedRuntimeProgress) => Effect.Effect<void>,
    awaitActivationWindow?: Effect.Effect<void, ProviderConnectionActionFailure>,
  ) => Effect.Effect<void, ProviderConnectionActionFailure>;
  /**
   * Whether a fresh check would select a different runtime than the one this
   * instance launches, for providers whose selection can fall back. The owner
   * reloads the instance when it returns true.
   */
  readonly selectionChanged?: Effect.Effect<boolean>;
}
