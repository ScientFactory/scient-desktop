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
  "grok_account",
  "grok_device_code",
  "droid_device_pairing",
  "cursor_browser",
]);
export type ProviderConnectionMethod = typeof ProviderConnectionMethod.Type;

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
  userCode: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9-]+$/)),
  ),
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
});
export type ProviderConnectionSummary = typeof ProviderConnectionSummary.Type;

export const ProviderConnectionStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  method: ProviderConnectionMethod,
  mode: Schema.optional(Schema.Literals(["connect", "reauthenticate"])),
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
    Schema.isMaxLength(8_192),
    authorizationCodeHasNoControlCharacters,
  ),
});
export type ProviderConnectionSubmitAuthorizationCodeInput =
  typeof ProviderConnectionSubmitAuthorizationCodeInput.Type;

export const ProviderConnectionDisconnectInput = Schema.Struct({
  instanceId: ProviderInstanceId,
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
});
export type ProviderRuntimePlan = typeof ProviderRuntimePlan.Type;

export const ProviderRuntimeStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: ProviderManagedRuntimeAction,
  catalogRevision: TrimmedNonEmptyString,
});
export type ProviderRuntimeStartInput = typeof ProviderRuntimeStartInput.Type;

export const ProviderRuntimeCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  operationId: TrimmedNonEmptyString,
});
export type ProviderRuntimeCancelInput = typeof ProviderRuntimeCancelInput.Type;

export class ProviderConnectionError extends Schema.TaggedErrorClass<ProviderConnectionError>()(
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
