import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProviderThreadId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Ephemeral live health of MCP servers observed on a thread. Never persisted to history. */
export const ThreadMcpServerStatusKind = Schema.Literals([
  "checking",
  "ready",
  "needs-sign-in",
  "credential-rejected",
  "permissions-required",
  "unreachable",
  "unavailable",
  "unknown",
]);
export type ThreadMcpServerStatusKind = typeof ThreadMcpServerStatusKind.Type;

export const ThreadMcpServerSource = Schema.Literals([
  "native",
  "native-plugin",
  "claudeai",
  "managed",
]);
export type ThreadMcpServerSource = typeof ThreadMcpServerSource.Type;

export const ThreadMcpServerActionKind = Schema.Literals([
  "sign-in",
  "retry",
  "manage",
  "settings",
]);
export type ThreadMcpServerActionKind = typeof ThreadMcpServerActionKind.Type;

export const ThreadMcpServerObservation = Schema.Struct({
  /** `source:name`; a name is as long as a sign-in may name it (256). */
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(272)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  source: ThreadMcpServerSource,
  status: ThreadMcpServerStatusKind,
  observedAt: IsoDateTime,
  detail: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
  action: Schema.optional(ThreadMcpServerActionKind),
  /** Opaque host-managed identifier when `source === "managed"` (e.g. a Scient ConnectorId). */
  managedId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  /** Present when live native sign-in targets this provider thread. */
  providerThreadId: Schema.optional(ProviderThreadId),
  sessionActive: Schema.Boolean,
});
export type ThreadMcpServerObservation = typeof ThreadMcpServerObservation.Type;

export const ThreadMcpStatusInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadMcpStatusInput = typeof ThreadMcpStatusInput.Type;

export const ThreadMcpStatusSnapshot = Schema.Struct({
  threadId: ThreadId,
  revision: NonNegativeInt,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  providerThreadId: Schema.optional(ProviderThreadId),
  sessionActive: Schema.Boolean,
  servers: Schema.Array(ThreadMcpServerObservation).check(Schema.isMaxLength(256)),
});
export type ThreadMcpStatusSnapshot = typeof ThreadMcpStatusSnapshot.Type;

export const isActionableThreadMcpStatus = (status: ThreadMcpServerStatusKind): boolean =>
  status === "needs-sign-in" ||
  status === "credential-rejected" ||
  status === "permissions-required" ||
  status === "unreachable" ||
  status === "unavailable";

/** User-configured native and host-managed servers earn badge prominence; ambient plugins/claude.ai stay inspectable. */
export const isProminentThreadMcpIssue = (server: ThreadMcpServerObservation): boolean =>
  isActionableThreadMcpStatus(server.status) &&
  (server.source === "managed" || server.source === "native");

const LEGACY_MCP_STARTUP_NATIVE_PREFIXES = ["mcp-startup-failed:", "mcp-sign-in:"] as const;

/** Startup and sign-in notices older adapters wrote into the transcript; clients no longer show them. */
export const isLegacyMcpStartupNotice = (item: {
  readonly mcpSignIn?: unknown;
  readonly nativeItemRef?: { readonly nativeId: string | null } | null | undefined;
}): boolean => {
  if (item.mcpSignIn !== undefined) return true;
  const nativeId = item.nativeItemRef?.nativeId;
  return (
    typeof nativeId === "string" &&
    LEGACY_MCP_STARTUP_NATIVE_PREFIXES.some((prefix) => nativeId.startsWith(prefix))
  );
};
