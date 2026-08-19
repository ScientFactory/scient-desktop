import type {
  ScientOverleafAccount,
  ScientOverleafCommitPolicy,
  ScientOverleafConnection,
  ScientOverleafConflictDetail,
  ScientOverleafOperationSnapshot,
  ScientOverleafReview,
} from "@t3tools/contracts";

export interface TreeFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly executable: boolean;
}

export interface TreeManifest {
  readonly files: ReadonlyArray<TreeFile>;
  readonly totalBytes: number;
}

export interface PersistedOverleafAccount extends ScientOverleafAccount {
  readonly secretRef: string;
}

export interface PersistedOverleafConnection extends ScientOverleafConnection {
  readonly workspaceBaselineManifest: TreeManifest;
  readonly pendingRemoteCommit: string | null;
  readonly activeOperationId: string | null;
}

export interface OperationContext {
  readonly workspaceRoot?: string;
  readonly relativeFolder?: string;
  readonly accountId?: string;
  readonly projectUrl?: string;
  readonly gitUrl?: string;
  readonly branch?: ScientOverleafConnection["branch"];
  readonly host?: string;
  readonly label?: string;
  readonly commitPolicy?: ScientOverleafCommitPolicy;
  readonly commitMessage?: string;
  readonly clickManifest?: TreeManifest;
  readonly remoteManifest?: TreeManifest;
  readonly candidateCommit?: string;
  readonly candidateTree?: string;
  readonly prePushBase?: string;
  readonly snapshotCommit?: string;
  readonly workspaceBaseCommit?: string;
  readonly initialMode?: "combine" | "replace-local" | "replace-overleaf";
  readonly conflicts?: ReadonlyArray<ScientOverleafConflictDetail>;
  readonly review?: ScientOverleafReview;
  readonly companionWrites?: ReadonlyArray<{
    readonly relativePath: string;
    readonly materialPath: string;
  }>;
  readonly disconnectAfterSync?: boolean;
  readonly localReconcile?: boolean;
  readonly suppressRenameAfterSuccess?: boolean;
}

export interface PersistedOverleafOperation {
  readonly snapshot: ScientOverleafOperationSnapshot;
  readonly context: OperationContext;
}

export const terminalOverleafPhases = new Set<ScientOverleafOperationSnapshot["phase"]>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export function projectFolder(
  connection: Pick<ScientOverleafConnection, "workspaceRoot" | "relativeFolder">,
) {
  return connection.relativeFolder.length === 0
    ? connection.workspaceRoot
    : `${connection.workspaceRoot.replace(/[\\/]$/u, "")}/${connection.relativeFolder}`;
}

export function manifestMap(manifest: TreeManifest): ReadonlyMap<string, TreeFile> {
  return new Map(manifest.files.map((file) => [file.path, file] as const));
}
