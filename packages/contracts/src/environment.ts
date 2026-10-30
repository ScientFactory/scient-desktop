import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleOptional,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_VERSION_TEXT = "2";
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ENVIRONMENT_MACHINE_KINDS = [
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
] as const;
export const EnvironmentMachineKind = Schema.Literals(ENVIRONMENT_MACHINE_KINDS);
export type EnvironmentMachineKind = typeof EnvironmentMachineKind.Type;
export const isEnvironmentMachineKind = Schema.is(EnvironmentMachineKind);

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  machine: ForwardCompatibleOptional(EnvironmentMachineKind),
});

// Kept outside settings.ts to avoid an orchestration import cycle.
export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const WorktreeSubmodules = Schema.Literals(["recursive", "top-level", "none"]);
export type WorktreeSubmodules = typeof WorktreeSubmodules.Type;
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn", "desktop-app"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

export const ServerInstallation = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["npx", "pnpm-dlx", "bunx"]) }),
  Schema.Struct({ kind: Schema.Literal("npm-global"), prefix: TrimmedNonEmptyString }),
]);
export type ServerInstallation = typeof ServerInstallation.Type;

/** What update path a client should offer for a server: one of the RPC
self-update methods above, or "desktop-managed" when the backend's
version belongs to the Scient desktop app supervising it — updating the
app on that machine is the only way to update the server. */
export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  attachmentUploads: Schema.optionalKey(Schema.Boolean),
  questionAttachments: Schema.optionalKey(Schema.Boolean),
  fileAttachments: Schema.optionalKey(
    Schema.Struct({
      maxUploadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
  pullRequests: Schema.optionalKey(Schema.Boolean),
  pullRequestChecks: Schema.optionalKey(Schema.Boolean),
  /** Every protocol-2 server sends this; older mobile builds still read it. */
  inlineMessageContext: Schema.optionalKey(Schema.Boolean),
  /** Queue operations retain typed context independently of immediate-turn support. */
  threadQueueMessageContext: Schema.optionalKey(Schema.Boolean),
  /** Server can explicitly send one waiting queue item after a failed or stopped turn. */
  threadQueueExplicitSend: Schema.optionalKey(Schema.Boolean),
  // SCIENT-FORK:START
  /** Overrides legacy Scient's threadQueueExplicitSend queue.resume(runId) form.
  Unmodified upstream v2 hosts already use queued-run.start without either flag. */
  queuedRunStart: Schema.optionalKey(Schema.Boolean),
  // SCIENT-FORK:END
  requiredWorktreeBootstrap: Schema.optionalKey(Schema.Boolean),
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlement: Schema.optionalKey(Schema.Boolean),
  storageCleanup: Schema.optionalKey(Schema.Boolean),
  storageCleanupRun: Schema.optionalKey(Schema.Boolean),

  databaseStorage: Schema.optionalKey(Schema.Boolean),

  otlpEndpointCheck: Schema.optionalKey(Schema.Boolean),
  projectWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  settledWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  worktreesDirectory: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlementScope: Schema.optionalKey(Schema.Boolean),
  threadRestartContinuation: Schema.optionalKey(Schema.Boolean),
  projectSettingsOverrides: Schema.optionalKey(Schema.Boolean),
  /** Hide the switch when absent; older servers silently drop per-project provider patches. */
  projectProviderInstanceOverrides: Schema.optionalKey(Schema.Boolean),
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** Serves `orchestration.forceStopThread`; hide Force stop where it is absent. */
  threadForceStop: Schema.optionalKey(Schema.Boolean),
  /** Every protocol-2 server sends this; older mobile builds still read it. */
  environmentThemes: Schema.optionalKey(Schema.Boolean),
  usageLimitSources: Schema.optionalKey(Schema.Boolean),
  /** Honors `workspaceSnapshotsOnDemand`; older servers send every snapshot and drop them in the stream. */
  providerWorkspaceSnapshotsOnDemand: Schema.optionalKey(Schema.Boolean),
  usagePriceOverrides: Schema.optionalKey(Schema.Boolean),
  /** Server can store provider billing credentials and report authoritative spend. */
  usageAccounting: Schema.optionalKey(Schema.Boolean),
  usageModelAliases: Schema.optionalKey(Schema.Boolean),
  threadPinning: Schema.optionalKey(Schema.Boolean),
  threadPinReorder: Schema.optionalKey(Schema.Boolean),
  threadActiveReorder: Schema.optionalKey(Schema.Boolean),
  // SCIENT-FORK:START — server accepts thread.section.set and projects sectionId.
  threadSections: Schema.optionalKey(Schema.Boolean),
  // SCIENT-FORK:END
  threadAutoSettleOptOut: Schema.optionalKey(Schema.Boolean),
  threadProjectFromScratch: Schema.optionalKey(Schema.Boolean),
  threadTitleRegeneration: Schema.optionalKey(Schema.Boolean),
  threadVisitedTracking: Schema.optionalKey(Schema.Boolean),
  /** Server understands titleOverride on thread.fork. Absent on older
  servers, so clients keep the proposed fork title read-only and never
  send an override. */
  threadForkTitleOverride: Schema.optionalKey(Schema.Boolean),
  threadForkRecovery: Schema.optionalKey(Schema.Boolean),
  /** Server supports legacy linkedPullRequest updates through thread.meta.update.
  Independent of threadPullRequests; servers supporting both advertise both. */
  threadPullRequestLinking: Schema.optionalKey(Schema.Boolean),
  threadStop: Schema.optionalKey(Schema.Boolean),
  /** Absent on older servers and on Windows hosts, which cannot stop a discovered server. */
  localServerStop: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.pull-request.link / .unlink, exposes `pullRequests` on
  threads, and routes PullRequestRef.host across projects on the same host. Same
  version-skew contract as threadSettlement. */
  threadPullRequests: Schema.optionalKey(Schema.Boolean),
  threadPullRequestWatch: Schema.optionalKey(Schema.Boolean),
  pullRequestStackActions: Schema.optionalKey(Schema.Boolean),
  /** Server resolves command context and validates identified rollback readiness. */
  serverResolvedCommandContext: Schema.optionalKey(Schema.Boolean),
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  /** Manual commands must update this install, not the host's default global prefix. */
  serverInstallation: ForwardCompatibleOptional(ServerInstallation),
  serverSelfUpdateProgress: Schema.optionalKey(Schema.Boolean),
  serverUpdateThreadContinuation: Schema.optionalKey(Schema.Boolean),
  /** Only explicit false skips Live Activity seeding; older servers may still publish. */
  agentActivityPublishing: Schema.optionalKey(Schema.Boolean),
  projectCloneTracking: Schema.optionalKey(Schema.Boolean),
  /** Server answers projects.listIgnoredFiles. */
  ignoredFileListing: Schema.optionalKey(Schema.Boolean),
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  desktopAppUpdate: Schema.optionalKey(Schema.Boolean),
  /** The desktop app switches update tracks when a server update request names one. */
  desktopAppChannelSwitch: Schema.optionalKey(Schema.Boolean),
  /** Subscribe to command output only when advertised; older servers never send it. */
  commandOutputStreaming: Schema.optionalKey(Schema.Boolean),
  /** Hosts headless Chromium tabs streamed over /api/preview-stream for clients without a local runtime. */
  serverBrowser: Schema.optionalKey(Schema.Boolean),
  /** Prints an existing server browser page and publishes its PDF in this environment. */
  serverBrowserPdfExport: Schema.optionalKey(Schema.Boolean),
  /** Server links to other environments (`PeerLink`) and its agents can work
      in them. Absent on servers from before linking, which clients must not
      offer linking for. */
  peerLinks: Schema.optionalKey(Schema.Boolean),
  /** Server's `/mcp` narrows an OAuth client's modes from `T3-Mode-Limit`, so
      a linked environment's calls keep its agent's limits. Another environment
      links to this one only when it is set. */
  mcpModeLimitHeader: Schema.optionalKey(Schema.Boolean),
  /** Work a linked environment starts here stays within its link
      (`linkOrigin`). Another environment links to this one only when it is
      set, since without it that work could change the user's own threads. */
  linkFence: Schema.optionalKey(Schema.Boolean),
  /** Server answers server.prepareTriage. */
  triage: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  /** Missing metadata denotes protocol 1. Bump this for breaking wire changes. */
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  /** Highest migration this server's database holds; absent on older servers. */
  databaseMigration: Schema.optionalKey(Schema.Int),
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryOrigin = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  remoteUrl: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryOrigin = typeof RepositoryOrigin.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  webUrl: Schema.optionalKey(TrimmedNonEmptyString),
  /** Work tree root, or the git dir for a bare repository. */
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(SourceControlProviderKind),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  origin: Schema.optionalKey(RepositoryOrigin),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export function repositoryGroupingKeyOf(identity: RepositoryIdentity): string {
  return identity.origin?.canonicalKey ?? identity.canonicalKey;
}

export function repositoryGroupingDisplayNameOf(identity: RepositoryIdentity): string | undefined {
  return identity.origin
    ? (identity.origin.displayName ?? identity.origin.canonicalKey)
    : identity.displayName;
}

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;
