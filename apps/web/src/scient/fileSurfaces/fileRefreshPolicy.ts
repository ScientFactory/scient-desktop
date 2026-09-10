import type { ProjectReadFileResult } from "@t3tools/contracts";

/**
 * A refreshed query can arrive while an optimistic editor buffer is masking
 * it. Only different contents at a different revision are a real conflict;
 * the file watcher also observes Scient's own successful atomic save.
 */
export function hasExternalFileConflict(input: {
  readonly authoritative: ProjectReadFileResult | null;
  readonly optimistic: ProjectReadFileResult | null;
  readonly lastConfirmedSave?: { readonly contents: string; readonly revision: string } | null;
  readonly pending: boolean;
}): boolean {
  return (
    input.pending &&
    input.authoritative !== null &&
    input.optimistic !== null &&
    !(
      input.lastConfirmedSave?.revision === input.authoritative.revision &&
      input.lastConfirmedSave.contents === input.authoritative.contents
    ) &&
    input.authoritative.revision !== input.optimistic.revision &&
    input.authoritative.contents !== input.optimistic.contents
  );
}

/**
 * A confirmed optimistic value remains visible until its verification read
 * completes. During that short window the older authoritative cache entry is
 * not a new disk event and must not roll a clean editor back. A dirty editor,
 * however, still needs the authoritative snapshot for conflict detection.
 */
export function authoritativeFileSnapshotForEditor(input: {
  readonly authoritative: ProjectReadFileResult | null;
  readonly optimistic: ProjectReadFileResult | null;
  readonly pending: boolean;
}): ProjectReadFileResult | null {
  if (input.authoritative === null) return null;
  if (
    !input.pending &&
    input.optimistic !== null &&
    (input.optimistic.revision !== input.authoritative.revision ||
      input.optimistic.contents !== input.authoritative.contents)
  ) {
    return null;
  }
  return input.authoritative;
}
