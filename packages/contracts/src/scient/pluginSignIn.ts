import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { ProviderThreadId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { SignInUrl } from "../providerSetup.ts";

export const PluginSignInAttemptId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const PluginSignInSlug = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/u),
);

/**
 * A plugin the agent could not use until the user signs in. The sign-in page stays on the
 * environment; the notice only names the attempt that can open it.
 */
export const OrchestrationV2PluginSignIn = Schema.Struct({
  attemptId: PluginSignInAttemptId,
  plugin: PluginSignInSlug,
  displayName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  /** Set on the notice that reports the plugin's next call succeeded. */
  signedIn: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2PluginSignIn = typeof OrchestrationV2PluginSignIn.Type;

export const PluginSignInOpenInput = Schema.Struct({
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  attemptId: PluginSignInAttemptId,
});
export type PluginSignInOpenInput = typeof PluginSignInOpenInput.Type;

export const PluginSignInOpenResult = Schema.Struct({
  /** The page the running agent waits on; it finishes the sign-in itself. */
  authorizationUrl: SignInUrl,
});
export type PluginSignInOpenResult = typeof PluginSignInOpenResult.Type;

/** Safe to show: never carries the sign-in URL. */
export class PluginSignInError extends Schema.TaggedError<PluginSignInError>()(
  "PluginSignInError",
  {
    reason: Schema.Literals(["expired", "unsupported", "failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_PLUGIN_SIGN_IN_WS_METHODS = {
  pluginSignInOpen: "scient.pluginSignIn.open",
} as const;

export const WsPluginSignInOpenRpc = Rpc.make(SCIENT_PLUGIN_SIGN_IN_WS_METHODS.pluginSignInOpen, {
  payload: PluginSignInOpenInput,
  success: PluginSignInOpenResult,
  error: Schema.Union([PluginSignInError, EnvironmentAuthorizationError]),
});
