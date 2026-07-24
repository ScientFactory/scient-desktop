// FILE: changedFilesPresentation.ts
// Purpose: Resolves the initial open state for settled-turn changed-files cards.
// Layer: Web chat presentation helper
// Exports: bounded, pure changed-files disclosure defaults

import type { TurnDiffFileChange } from "../../types";

// Five visible rows is already the transcript card's compact-list ceiling. Past
// that point, opening the outer card by default adds another disclosure control
// without making the whole change directly visible.
export const CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT = 5;

// A small file count can still represent a very large patch. Keep high-churn
// changes compact until the user asks to inspect them.
export const CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT = 200;

// A preview should orient the user without recreating the full list. Three
// representative rows fit the transcript density target while still showing
// changes across more than one part of a typical workspace.
export const CHANGED_FILES_PREVIEW_FILE_LIMIT = 3;

export type ChangedFilesPresentationState = "expanded" | "preview" | "collapsed";

export interface ChangedFilesPreviewItem {
  readonly file: TurnDiffFileChange;
  readonly label: string;
}

const GENERIC_PATH_SEGMENTS = new Set(["app", "apps", "components", "lib", "packages", "src"]);

function pathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function normalizedPath(pathValue: string): string {
  return pathSegments(pathValue).join("/");
}

function changedFileParent(pathValue: string): string {
  return pathSegments(pathValue).slice(0, -1).join("/");
}

export function compactChangedFilePath(pathValue: string, allPaths: ReadonlyArray<string>): string {
  const segments = pathSegments(pathValue);
  if (segments.length <= 1) {
    return segments[0] ?? pathValue;
  }

  const normalizedValue = segments.join("/");
  const normalizedPaths = allPaths.map(normalizedPath);
  const minimumDepth = Math.min(2, segments.length);

  for (let depth = minimumDepth; depth <= segments.length; depth += 1) {
    const candidateSegments = segments.slice(-depth);
    const candidate = candidateSegments.join("/");
    const hasCollision = normalizedPaths.some(
      (otherPath) =>
        otherPath !== normalizedValue &&
        pathSegments(otherPath).slice(-depth).join("/") === candidate,
    );
    if (hasCollision) {
      continue;
    }

    const parentSegment = candidateSegments.at(-2);
    if (
      depth < 3 &&
      depth < segments.length &&
      parentSegment !== undefined &&
      GENERIC_PATH_SEGMENTS.has(parentSegment.toLowerCase())
    ) {
      continue;
    }
    return candidate;
  }

  return normalizedValue;
}

export function selectChangedFilePreview(
  files: ReadonlyArray<TurnDiffFileChange>,
  limit = CHANGED_FILES_PREVIEW_FILE_LIMIT,
): ChangedFilesPreviewItem[] {
  const resolvedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (resolvedLimit === 0 || files.length === 0) {
    return [];
  }

  const selected: TurnDiffFileChange[] = [];
  const selectedPaths = new Set<string>();
  const selectedParents = new Set<string>();

  for (const file of files) {
    const path = normalizedPath(file.path);
    const parent = changedFileParent(path);
    if (selectedPaths.has(path) || selectedParents.has(parent)) {
      continue;
    }
    selected.push(file);
    selectedPaths.add(path);
    selectedParents.add(parent);
    if (selected.length === resolvedLimit) {
      break;
    }
  }

  if (selected.length < resolvedLimit) {
    for (const file of files) {
      const path = normalizedPath(file.path);
      if (selectedPaths.has(path)) {
        continue;
      }
      selected.push(file);
      selectedPaths.add(path);
      if (selected.length === resolvedLimit) {
        break;
      }
    }
  }

  const allPaths = files.map((file) => file.path);
  return selected.map((file) => ({
    file,
    label: compactChangedFilePath(file.path, allPaths),
  }));
}

export function shouldAutoExpandChangedFiles(
  files: ReadonlyArray<TurnDiffFileChange>,
  isCurrentChange: boolean,
): boolean {
  if (!isCurrentChange || files.length > CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT) {
    return false;
  }

  let changedLineCount = 0;
  for (const file of files) {
    changedLineCount += Math.max(0, file.additions ?? 0) + Math.max(0, file.deletions ?? 0);
    if (changedLineCount > CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT) {
      return false;
    }
  }
  return true;
}

export function resolveChangedFilesPresentation(input: {
  files: ReadonlyArray<TurnDiffFileChange>;
  isCurrentChange: boolean;
  userOverride?: boolean | undefined;
}): ChangedFilesPresentationState {
  if (input.files.length === 0) {
    return "collapsed";
  }
  if (input.userOverride !== undefined) {
    return input.userOverride ? "expanded" : "collapsed";
  }
  if (!input.isCurrentChange) {
    return "collapsed";
  }
  return shouldAutoExpandChangedFiles(input.files, true) ? "expanded" : "preview";
}
