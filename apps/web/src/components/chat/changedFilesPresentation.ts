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

export function resolveChangedFilesExpanded(input: {
  files: ReadonlyArray<TurnDiffFileChange>;
  isCurrentChange: boolean;
  userOverride?: boolean | undefined;
}): boolean {
  return input.userOverride ?? shouldAutoExpandChangedFiles(input.files, input.isCurrentChange);
}
