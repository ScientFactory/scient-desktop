/**
 * Scient's optional per-instance seams on `ProviderInstance`: voice transcript
 * correction, native skill activation, assisted account connection and
 * app-managed runtime actions. Drivers that leave them absent keep pure T3
 * behaviour.
 */
import type {
  ModelSelection,
  ProviderAuthorizationUrlKind,
  ProviderConnectionMethod,
  ProviderManagedRuntimeAction,
  ProviderRuntimeOperationStatus,
  ProviderRuntimePlan,
  ProviderRuntimeSummary,
  VoiceTranscriptionLanguage,
  VoiceTranscriptCorrectionError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
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

export interface ProviderConnectionActionFailure {
  readonly message: string;
  readonly cause?: unknown;
  /**
   * An account sign-out failed without the provider saying it kept the
   * sign-in (its process ended, or never answered). The manager then treats
   * the sign-in as possibly removed.
   */
  readonly signInMayBeRemoved?: boolean | undefined;
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
   * For a flow whose first question can come after the attempt is described:
   * resolves when the provider asks it. The manager then republishes the
   * operation as accepting an answer. Absent when a question already arrived
   * or the flow never asks one.
   */
  readonly laterQuestion?:
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
   * Runs a planned action. Download, verification, and staging may proceed
   * while the provider is in use; `awaitActivationWindow` must complete
   * immediately before the live runtime changes. The runtime manager always
   * supplies it: it waits for the provider's running work to finish and then
   * stops its sessions. Direct callers such as tests may omit it.
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
