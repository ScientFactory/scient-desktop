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

/**
 * Host-managed servers, and user-configured native ones that broke, earn badge prominence. A
 * missing sign-in stays quiet until the agent asks for it in the chat; plugins and claude.ai stay
 * inspectable.
 */
export const isProminentThreadMcpIssue = (server: ThreadMcpServerObservation): boolean =>
  isActionableThreadMcpStatus(server.status) &&
  (server.source === "managed" ||
    (server.source === "native" && server.status !== "needs-sign-in"));

const LEGACY_MCP_STARTUP_NATIVE_PREFIXES = ["mcp-startup-failed:", "mcp-sign-in:"] as const;

/** A Sign in row the agent asked for when it needed the server; it stays in the chat. */
export const MCP_SIGN_IN_REQUEST_NATIVE_PREFIX = "mcp-sign-in-request:";

/** A Sign in row the agent asked for, as opposed to a startup notice. */
export const isMcpSignInRequestNotice = (item: {
  readonly mcpSignIn?: unknown;
  readonly nativeItemRef?: { readonly nativeId: string | null } | null | undefined;
}): boolean =>
  item.mcpSignIn !== undefined &&
  item.nativeItemRef?.nativeId?.startsWith(MCP_SIGN_IN_REQUEST_NATIVE_PREFIX) === true;

/**
 * Whether a requested sign-in still has something to do: its live session still reports the
 * server needs one. Completion is otherwise only known to the client that signed in.
 */
export const requestedMcpSignInIsOpen = (
  snapshot: Pick<ThreadMcpStatusSnapshot, "servers"> | null | undefined,
  request: { readonly server: string; readonly providerThreadId: string | null },
): boolean =>
  snapshot?.servers.some(
    (server) =>
      server.source !== "managed" &&
      server.name === request.server &&
      server.status === "needs-sign-in" &&
      server.sessionActive &&
      server.providerThreadId === request.providerThreadId,
  ) === true;

/** Startup and sign-in notices older adapters wrote into the transcript; clients no longer show them. */
export const isLegacyMcpStartupNotice = (item: {
  readonly mcpSignIn?: unknown;
  readonly nativeItemRef?: { readonly nativeId: string | null } | null | undefined;
}): boolean => {
  const nativeId = item.nativeItemRef?.nativeId;
  if (typeof nativeId === "string" && nativeId.startsWith(MCP_SIGN_IN_REQUEST_NATIVE_PREFIX))
    return false;
  if (item.mcpSignIn !== undefined) return true;
  return (
    typeof nativeId === "string" &&
    LEGACY_MCP_STARTUP_NATIVE_PREFIXES.some((prefix) => nativeId.startsWith(prefix))
  );
};
