// Scient plugin sign-in: the provider-side contract for opening a plugin's sign-in page that a
// session's notice offered. Re-exported from ProviderAdapter.ts; only Antigravity implements it.
import type {
  OrchestrationV2PluginSignIn,
  OrchestrationV2ProviderThread,
  PluginSignInError,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ScientPluginSignInRuntime {
  /** The validated page, only for the thread whose notice named the attempt, while it is live. */
  readonly open: (input: {
    readonly threadId: ThreadId;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly attemptId: string;
  }) => Effect.Effect<{ readonly authorizationUrl: string }, PluginSignInError>;
}

/** A typed notice an adapter shows after a tool call's row. */
export interface ScientToolNotice {
  readonly title: string;
  readonly message: string;
  readonly level: "info" | "warning";
  readonly pluginSignIn: OrchestrationV2PluginSignIn;
}
