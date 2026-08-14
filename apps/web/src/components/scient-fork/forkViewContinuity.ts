/**
 * Scient-owned continuity for durable right-panel views across a conversation
 * fork. Live resource ids (terminal sessions and browser tabs) never cross the
 * thread boundary. The generic T3 panel store only receives the sanitized
 * destination state through one narrow restore action.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import {
  type RightPanelSurface,
  type ThreadRightPanelState,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { resolvePathLinkTarget } from "~/terminal-links";
import { workspacePdfSourceForPreview } from "~/scient/pdf/pdfSource";
import {
  pdfReaderSessionDocumentKey,
  pdfReaderSessionStore,
} from "~/scient/pdf/pdfReaderSessionStore";

const CONTINUITY_STORAGE_KEY = "scient:fork-view-continuity:v1";
const MAX_PENDING_CONTINUITY = 20;
const PENDING_CONTINUITY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PDF_RELATIVE_PATH_LENGTH = 2_048;

interface PendingPdfContinuity {
  readonly environmentId: string;
  readonly destinationThreadId: string;
  readonly originWorkspaceRoot: string;
  readonly pdfRelativePaths: ReadonlyArray<string>;
  readonly createdAt: number;
}

function isPortableScientSurface(surface: Extract<RightPanelSurface, { kind: "scient" }>): boolean {
  if (surface.module !== "artifact") return true;
  return (
    surface.artifact.resource._tag !== "workspace-file" &&
    surface.artifact.resource._tag !== "attachment"
  );
}

function portableSurface(surface: RightPanelSurface): RightPanelSurface | null {
  if (surface.kind === "terminal") return null;
  if (surface.kind === "preview") {
    return { id: "browser:new", kind: "preview", resourceId: null };
  }
  if (surface.kind === "scient" && !isPortableScientSurface(surface)) return null;
  return surface;
}

export function forkRightPanelState(source: ThreadRightPanelState): ThreadRightPanelState {
  const surfaces: RightPanelSurface[] = [];
  const sourceIndexByDestinationId = new Map<string, number>();
  for (const [index, sourceSurface] of source.surfaces.entries()) {
    const portable = portableSurface(sourceSurface);
    if (portable === null || surfaces.some((surface) => surface.id === portable.id)) continue;
    surfaces.push(portable);
    sourceIndexByDestinationId.set(portable.id, index);
  }
  if (surfaces.length === 0) {
    return { isOpen: false, activeSurfaceId: null, surfaces: [] };
  }

  const sourceActive = source.surfaces.find((surface) => surface.id === source.activeSurfaceId);
  const mappedActive = sourceActive ? portableSurface(sourceActive)?.id : null;
  const sourceActiveIndex = Math.max(
    0,
    source.surfaces.findIndex((surface) => surface.id === source.activeSurfaceId),
  );
  const activeSurfaceId =
    mappedActive && surfaces.some((surface) => surface.id === mappedActive)
      ? mappedActive
      : surfaces.toSorted(
          (left, right) =>
            Math.abs((sourceIndexByDestinationId.get(left.id) ?? 0) - sourceActiveIndex) -
            Math.abs((sourceIndexByDestinationId.get(right.id) ?? 0) - sourceActiveIndex),
        )[0]!.id;

  return { isOpen: source.isOpen, activeSurfaceId, surfaces };
}

function isPortablePdfRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PDF_RELATIVE_PATH_LENGTH &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    /\.pdf(?:[?#].*)?$/iu.test(value)
  );
}

function readPending(): ReadonlyArray<PendingPdfContinuity> {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(CONTINUITY_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    const oldestAccepted = Date.now() - PENDING_CONTINUITY_TTL_MS;
    return value.flatMap((entry): ReadonlyArray<PendingPdfContinuity> => {
      if (!entry || typeof entry !== "object") return [];
      const candidate = entry as Partial<PendingPdfContinuity>;
      return typeof candidate.environmentId === "string" &&
        typeof candidate.destinationThreadId === "string" &&
        typeof candidate.originWorkspaceRoot === "string" &&
        Array.isArray(candidate.pdfRelativePaths) &&
        candidate.pdfRelativePaths.every(
          (path) => typeof path === "string" && isPortablePdfRelativePath(path),
        ) &&
        typeof candidate.createdAt === "number" &&
        Number.isFinite(candidate.createdAt) &&
        candidate.createdAt >= oldestAccepted
        ? [candidate as PendingPdfContinuity]
        : [];
    });
  } catch {
    return [];
  }
}

function writePending(entries: ReadonlyArray<PendingPdfContinuity>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CONTINUITY_STORAGE_KEY,
      JSON.stringify(
        entries.toSorted((a, b) => b.createdAt - a.createdAt).slice(0, MAX_PENDING_CONTINUITY),
      ),
    );
  } catch {
    // Panel continuity is best-effort and must never block a successful fork.
  }
}

export function stageForkViewContinuity(input: {
  readonly originRef: ScopedThreadRef;
  readonly destinationThreadId: ThreadId;
  readonly originWorkspaceRoot: string | undefined;
}): void {
  const destinationRef = scopeThreadRef(input.originRef.environmentId, input.destinationThreadId);
  const panel = useRightPanelStore.getState();
  const originState = selectThreadRightPanelState(panel.byThreadKey, input.originRef);
  const destinationState = forkRightPanelState(originState);
  panel.restoreThreadState(destinationRef, destinationState);

  if (input.originWorkspaceRoot === undefined) return;
  const pdfRelativePaths = destinationState.surfaces.flatMap((surface) =>
    surface.kind === "file" && isPortablePdfRelativePath(surface.relativePath)
      ? [surface.relativePath]
      : [],
  );
  if (pdfRelativePaths.length === 0) return;
  const current = readPending().filter(
    (entry) =>
      entry.environmentId !== input.originRef.environmentId ||
      entry.destinationThreadId !== input.destinationThreadId,
  );
  writePending([
    ...current,
    {
      environmentId: input.originRef.environmentId,
      destinationThreadId: input.destinationThreadId,
      originWorkspaceRoot: input.originWorkspaceRoot,
      pdfRelativePaths,
      createdAt: Date.now(),
    },
  ]);
}

export function restoreForkPdfContinuity(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly destinationWorkspaceRoot: string | undefined;
}): void {
  if (input.destinationWorkspaceRoot === undefined) return;
  const pending = readPending();
  const match = pending.find(
    (entry) =>
      entry.environmentId === input.environmentId && entry.destinationThreadId === input.threadId,
  );
  if (match === undefined) return;

  for (const relativePath of match.pdfRelativePaths) {
    const originPath = resolvePathLinkTarget(relativePath, match.originWorkspaceRoot);
    const destinationPath = resolvePathLinkTarget(relativePath, input.destinationWorkspaceRoot);
    const source = workspacePdfSourceForPreview({
      absolutePath: originPath,
      environmentId: input.environmentId,
      relativePath,
      threadId: match.destinationThreadId,
    });
    const destination = workspacePdfSourceForPreview({
      absolutePath: destinationPath,
      environmentId: input.environmentId,
      relativePath,
      threadId: input.threadId,
    });
    if (source === null || destination === null) continue;
    pdfReaderSessionStore.copy(
      pdfReaderSessionDocumentKey(source),
      pdfReaderSessionDocumentKey(destination),
    );
  }
  writePending(pending.filter((entry) => entry !== match));
}
