import { useMemo } from "react";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";

import type { PendingSurfaceDepartureOptions } from "../../fileSurfaces/usePendingSurfaceDeparture";
import {
  markdownPersistenceRegistry,
  type MarkdownPersistenceRegistryState,
  type MarkdownPersistenceTarget,
} from "./markdownPersistenceRegistry";
import { useMarkdownPersistenceRegistrySnapshot } from "./useMarkdownPersistenceLease";

interface WorkspaceIdentity {
  readonly environmentId: EnvironmentId | undefined;
  readonly cwd: string | undefined;
}

type GuardScope =
  | { readonly kind: "global" }
  | (WorkspaceIdentity & { readonly kind: "path" | "surface" });

interface GuardRegistry {
  readonly getSnapshot: () => readonly MarkdownPersistenceRegistryState[];
  readonly flushTarget: (target: MarkdownPersistenceTarget) => Promise<boolean>;
}

function isWorkspaceFile(file: MarkdownPersistenceTarget, workspace: WorkspaceIdentity): boolean {
  return file.environmentId === workspace.environmentId && file.cwd === workspace.cwd;
}

function scopeFiles(files: readonly MarkdownPersistenceRegistryState[], scope: GuardScope) {
  return scope.kind === "global" ? files : files.filter((file) => isWorkspaceFile(file, scope));
}

function surfaceId(file: MarkdownPersistenceTarget, scope: GuardScope): string {
  switch (scope.kind) {
    case "global":
      return projectFileOperationKey(file);
    case "surface":
      return `file:${file.relativePath}`;
    case "path":
      return file.relativePath;
  }
}

/** Shared mapping for panel paths, thread surface IDs, and cross-project departure IDs. */
export function createMarkdownPersistenceGuards(input: {
  readonly files: readonly MarkdownPersistenceRegistryState[];
  readonly registry: GuardRegistry;
  readonly scope: GuardScope;
  readonly genericPendingIds: ReadonlySet<string>;
  readonly attentionWorkspace?: WorkspaceIdentity;
  readonly onAttention?: (surfaceId: string) => void;
}) {
  const select = (files: readonly MarkdownPersistenceRegistryState[]) => {
    const scoped = scopeFiles(files, input.scope);
    return {
      pendingSurfaceIds: new Set([
        ...input.genericPendingIds,
        ...scoped.filter((file) => file.pending).map((file) => surfaceId(file, input.scope)),
      ]),
      quietSurfaceIds: new Set(scoped.map((file) => surfaceId(file, input.scope))),
      attentionSurfaceIds: new Set(
        scoped.filter((file) => file.attention).map((file) => surfaceId(file, input.scope)),
      ),
    };
  };
  const snapshot = select(input.files);
  const departureOptions: PendingSurfaceDepartureOptions = {
    quietSurfaceIds: snapshot.quietSurfaceIds,
    attentionSurfaceIds: snapshot.attentionSurfaceIds,
    // Guards read synchronous truth, including edits made before the next React commit.
    getPendingSurfaceIds: () => select(input.registry.getSnapshot()).pendingSurfaceIds,
    getAttentionSurfaceIds: () => select(input.registry.getSnapshot()).attentionSurfaceIds,
    onFlush: (surfaceIds) => {
      const requested = new Set(surfaceIds);
      for (const file of scopeFiles(input.registry.getSnapshot(), input.scope)) {
        if (file.pending && requested.has(surfaceId(file, input.scope))) {
          void input.registry.flushTarget(file);
        }
      }
    },
    onAttention: (id) => {
      const file = scopeFiles(input.registry.getSnapshot(), input.scope).find(
        (candidate) => candidate.attention && surfaceId(candidate, input.scope) === id,
      );
      if (file === undefined) return;
      // Global guards retain every project, but may reveal a notice only in its
      // already-active owning workspace. Never open it in another thread/project.
      if (
        input.scope.kind === "global" &&
        (input.attentionWorkspace === undefined || !isWorkspaceFile(file, input.attentionWorkspace))
      )
        return;
      input.onAttention?.(
        input.scope.kind === "path" ? file.relativePath : `file:${file.relativePath}`,
      );
    },
  };
  return { ...snapshot, departureOptions };
}

export function useMarkdownPersistenceGuards(
  input: WorkspaceIdentity & {
    readonly idKind: "path" | "surface";
    readonly genericPendingIds: ReadonlySet<string>;
    readonly onAttention?: (surfaceId: string) => void;
  },
) {
  const files = useMarkdownPersistenceRegistrySnapshot();
  return useMemo(
    () =>
      createMarkdownPersistenceGuards({
        files,
        registry: markdownPersistenceRegistry,
        scope: { kind: input.idKind, environmentId: input.environmentId, cwd: input.cwd },
        genericPendingIds: input.genericPendingIds,
        ...(input.onAttention === undefined ? {} : { onAttention: input.onAttention }),
      }),
    [
      files,
      input.idKind,
      input.environmentId,
      input.cwd,
      input.genericPendingIds,
      input.onAttention,
    ],
  );
}

export function useMarkdownPersistenceNavigationGuards(
  input: WorkspaceIdentity & {
    readonly genericPendingByWorkspace: ReadonlyMap<string, ReadonlySet<string>>;
    readonly onAttention?: (surfaceId: string) => void;
  },
) {
  const files = useMarkdownPersistenceRegistrySnapshot();
  return useMemo(
    () =>
      createMarkdownPersistenceGuards({
        files,
        registry: markdownPersistenceRegistry,
        scope: { kind: "global" },
        genericPendingIds: new Set(
          [...input.genericPendingByWorkspace].flatMap(([workspaceKey, ids]) =>
            [...ids].map((id) => `${workspaceKey}:${id}`),
          ),
        ),
        attentionWorkspace: { environmentId: input.environmentId, cwd: input.cwd },
        ...(input.onAttention === undefined ? {} : { onAttention: input.onAttention }),
      }),
    [files, input.genericPendingByWorkspace, input.environmentId, input.cwd, input.onAttention],
  );
}
