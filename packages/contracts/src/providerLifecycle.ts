import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Provider-owned connection methods that Scient can currently orchestrate.
 *
 * Credentials never cross this contract. A method only identifies an
 * official provider flow that the server is allowed to start.
 */
export const ProviderConnectionMethod = Schema.Literals([
  "codex_browser",
  "codex_device_code",
  "claude_subscription",
  "claude_console",
  "antigravity_google",
  "antigravity_credentials",
  "grok_account",
  "grok_device_code",
  "droid_device_pairing",
  "cursor_browser",
  "scient_agent_account",
]);
export type ProviderConnectionMethod = typeof ProviderConnectionMethod.Type;

/**
 * One entry of a provider's own sign-in list, for a provider that connects to
 * several model accounts (Scient Agent). The provider reports the list; Scient
 * does not curate it.
 */
export const ProviderConnectionAccountId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._-]+$/),
);
export type ProviderConnectionAccountId = typeof ProviderConnectionAccountId.Type;

export const ProviderConnectionAccount = Schema.Struct({
  id: ProviderConnectionAccountId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** `account` signs in through a browser or device flow; `key` asks for a pasted API key. */
  kind: Schema.Literals(["account", "key"]),
  /** Usable now, from a stored sign-in or from the provider's environment. */
  connected: Schema.Boolean,
  /** A sign-in is stored for it, so signing out has something to remove. */
  canDisconnect: Schema.Boolean,
  /**
   * Another entry of the list whose account this one signs in to: the two keep
   * one stored sign-in (ChatGPT's browser and device flows), so they share
   * their status and their sign-out, and the account is shown once.
   */
  sameAccountAs: Schema.optionalKey(ProviderConnectionAccountId),
});
export type ProviderConnectionAccount = typeof ProviderConnectionAccount.Type;

export const ProviderConnectionOperationStatus = Schema.Literals([
  "starting",
  "waiting_for_browser",
  "waiting_for_device_code",
  "verifying",
  "connected",
  "failed",
  "cancelled",
]);
export type ProviderConnectionOperationStatus = typeof ProviderConnectionOperationStatus.Type;

/**
 * How Scient should treat a provider-supplied authorization URL.
 *
 * Primary URLs are opened by the host as part of the normal connection flow.
 * Manual fallback URLs are retained for explicit user recovery only because
 * the provider process owns the normal browser launch and callback.
 */
export const ProviderAuthorizationUrlKind = Schema.Literals(["primary", "manual_fallback"]);
export type ProviderAuthorizationUrlKind = typeof ProviderAuthorizationUrlKind.Type;

export const ProviderConnectionOperation = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  method: ProviderConnectionMethod,
  status: ProviderConnectionOperationStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  message: TrimmedNonEmptyString,
  authorizationUrl: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(8_192))),
  authorizationUrlKind: Schema.optionalKey(ProviderAuthorizationUrlKind),
  /** True only while the live provider process can accept a pasted one-time code. */
  acceptsAuthorizationCode: Schema.optionalKey(Schema.Boolean),
  /** The provider may require a complete OAuth redirect URL instead of a code. */
  authorizationResponseKind: Schema.optionalKey(Schema.Literals(["code", "callback_url"])),
  userCode: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9-]+$/)),
  ),
  /** Which entry of the provider's sign-in list this operation is for. */
  account: Schema.optionalKey(ProviderConnectionAccountId),
  /** What the provider asks the user to do or paste, in its own words. */
  instructions: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type ProviderConnectionOperation = typeof ProviderConnectionOperation.Type;

export const ProviderRuntimeSource = Schema.Literals([
  "custom",
  "system",
  "scient_managed",
  "missing",
  "unknown",
]);
export type ProviderRuntimeSource = typeof ProviderRuntimeSource.Type;

export const ProviderRuntimeSupportTier = Schema.Literals([
  "fully_assisted",
  "external_runtime_supported",
  "manual_or_advanced_only",
  "unsupported",
]);
export type ProviderRuntimeSupportTier = typeof ProviderRuntimeSupportTier.Type;

export const ProviderManagedRuntimeAction = Schema.Literals([
  "install",
  "update",
  "repair",
  "remove",
]);
export type ProviderManagedRuntimeAction = typeof ProviderManagedRuntimeAction.Type;

export const ProviderRuntimeOperationStatus = Schema.Literals([
  "preparing",
  "downloading",
  "verifying",
  "installing",
  "testing",
  "activating",
  "removing",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ProviderRuntimeOperationStatus = typeof ProviderRuntimeOperationStatus.Type;

export const ProviderRuntimeOperation = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  action: ProviderManagedRuntimeAction,
  status: ProviderRuntimeOperationStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  message: TrimmedNonEmptyString,
  downloadedBytes: Schema.optionalKey(NonNegativeInt),
  totalBytes: Schema.optionalKey(PositiveInt),
  /**
   * The new runtime is ready but not yet active: switching stops the provider's
   * sessions, so it waits for their running turns to finish. Optional so older
   * clients keep decoding the operation.
   */
  waitingForIdle: Schema.optionalKey(Schema.Boolean),
});
export type ProviderRuntimeOperation = typeof ProviderRuntimeOperation.Type;

/**
 * Scient-owned launch diagnostics for assisted recovery. Never includes
 * credentials; executable/home are display-only coordinates.
 */
export const ProviderRuntimeDiagnostics = Schema.Struct({
  executable: TrimmedNonEmptyString,
  version: Schema.NullOr(TrimmedNonEmptyString),
  homePath: Schema.NullOr(TrimmedNonEmptyString),
  backend: TrimmedNonEmptyString,
});
export type ProviderRuntimeDiagnostics = typeof ProviderRuntimeDiagnostics.Type;

export const ProviderRuntimeSummary = Schema.Struct({
  source: ProviderRuntimeSource,
  supportTier: ProviderRuntimeSupportTier,
  target: TrimmedNonEmptyString,
  actions: Schema.Array(ProviderManagedRuntimeAction),
  managedVersion: Schema.NullOr(TrimmedNonEmptyString),
  /** Latest qualified catalog version when `update` is currently available. */
  availableManagedVersion: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  previousManagedVersion: Schema.NullOr(TrimmedNonEmptyString),
  operation: Schema.NullOr(ProviderRuntimeOperation),
  message: TrimmedNonEmptyString,
  diagnostics: Schema.optionalKey(ProviderRuntimeDiagnostics),
});
export type ProviderRuntimeSummary = typeof ProviderRuntimeSummary.Type;

export const ProviderConnectionSummary = Schema.Struct({
  methods: Schema.Array(ProviderConnectionMethod),
  canDisconnect: Schema.Boolean,
  operation: Schema.NullOr(ProviderConnectionOperation),
  runtime: Schema.optionalKey(ProviderRuntimeSummary),
  /**
   * The provider's own sign-in list. Present only for a provider that connects
   * to several accounts; each sign-in and sign-out then names one entry.
   */
  accounts: Schema.optionalKey(Schema.Array(ProviderConnectionAccount)),
  /**
   * The sign-in to one of `accounts` that is running or last ended. It is
   * published here and never in `operation`.
   *
   * Both account fields are optional keys on purpose: a client that predates
   * them ignores them and keeps decoding the provider. For the same reason
   * such a provider leaves `methods` empty (its list is what says sign-in is
   * available), so the `scient_agent_account` method never reaches a field an
   * older client decodes.
   */
  accountOperation: Schema.optionalKey(Schema.NullOr(ProviderConnectionOperation)),
});

/** The sign-in a provider is in or last ended, whichever field carries it. */
export const publishedProviderConnectionOperation = (
  connection: ProviderConnectionSummary | undefined,
): ProviderConnectionOperation | null =>
  connection?.accountOperation ?? connection?.operation ?? null;
export type ProviderConnectionSummary = typeof ProviderConnectionSummary.Type;

export const ProviderConnectionStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  method: ProviderConnectionMethod,
  mode: Schema.optional(Schema.Literals(["connect", "reauthenticate"])),
  /** Required when the provider lists accounts: the entry to sign in to. */
  account: Schema.optionalKey(ProviderConnectionAccountId),
});
export type ProviderConnectionStartInput = typeof ProviderConnectionStartInput.Type;

export const ProviderConnectionCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  operationId: TrimmedNonEmptyString,
});
export type ProviderConnectionCancelInput = typeof ProviderConnectionCancelInput.Type;

const authorizationCodeHasNoControlCharacters = Schema.makeFilter((value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return "Authorization code must not contain control characters.";
    }
  }
  return true;
});

export const ProviderConnectionSubmitAuthorizationCodeInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  operationId: TrimmedNonEmptyString,
  authorizationCode: TrimmedNonEmptyString.check(
    Schema.isMaxLength(16_384),
    authorizationCodeHasNoControlCharacters,
  ),
});
export type ProviderConnectionSubmitAuthorizationCodeInput =
  typeof ProviderConnectionSubmitAuthorizationCodeInput.Type;

export const ProviderConnectionDisconnectInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Required when the provider lists accounts: the entry to sign out of. */
  account: Schema.optionalKey(ProviderConnectionAccountId),
});
export type ProviderConnectionDisconnectInput = typeof ProviderConnectionDisconnectInput.Type;

export const ProviderRuntimePlanInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: ProviderManagedRuntimeAction,
});
export type ProviderRuntimePlanInput = typeof ProviderRuntimePlanInput.Type;

export const ProviderRuntimePlan = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: ProviderManagedRuntimeAction,
  target: TrimmedNonEmptyString,
  version: Schema.NullOr(TrimmedNonEmptyString),
  downloadBytes: Schema.NullOr(PositiveInt),
  sourceLabel: TrimmedNonEmptyString,
  catalogRevision: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  /**
   * Present when the action switches from a healthy system runtime to the
   * managed release: the system runtime's own release, null when Scient could
   * not read it. Optional so older clients and servers keep decoding the plan.
   */
  systemVersion: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  /**
   * Whether `version` is older than `systemVersion`. A switch to an older
   * release, or from a system runtime whose release is unknown (null), starts
   * only with `ProviderRuntimeStartInput.acceptOlderThanSystem`, after the
   * user saw what the plan says about both.
   */
  olderThanSystem: Schema.optionalKey(Schema.Boolean),
});
export type ProviderRuntimePlan = typeof ProviderRuntimePlan.Type;

export const ProviderRuntimeStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: ProviderManagedRuntimeAction,
  catalogRevision: TrimmedNonEmptyString,
  /** The user accepted a plan whose `olderThanSystem` is true or whose `systemVersion` is null. */
  acceptOlderThanSystem: Schema.optionalKey(Schema.Boolean),
});
export type ProviderRuntimeStartInput = typeof ProviderRuntimeStartInput.Type;

export const ProviderRuntimeCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  operationId: TrimmedNonEmptyString,
});
export type ProviderRuntimeCancelInput = typeof ProviderRuntimeCancelInput.Type;

export class ProviderConnectionError extends Schema.TaggedError<ProviderConnectionError>()(
  "ProviderConnectionError",
  {
    provider: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    reason: Schema.Literals([
      "unsupported_provider",
      "provider_not_installed",
      "invalid_method",
      "already_running",
      "operation_not_found",
      "authorization_code_not_supported",
      "provider_disabled",
      "connection_failed",
      "disconnect_failed",
      "runtime_unsupported",
      "invalid_runtime_action",
      "runtime_busy",
      "runtime_plan_stale",
      "runtime_operation_not_found",
      "runtime_operation_failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
