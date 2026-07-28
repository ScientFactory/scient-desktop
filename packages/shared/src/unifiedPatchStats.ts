// FILE: unifiedPatchStats.ts
// Purpose: Count additions, deletions, and files from a unified patch without building a
//          parsed representation of it.
// Layer: Shared git utility

export interface UnifiedPatchTotals {
  additions: number;
  deletions: number;
  fileCount: number;
}

/**
 * Summarize a unified patch by scanning it once, line by line.
 *
 * The counting rules mirror the fully parsed patch totals used by the renderer:
 *
 * - Content lines beginning with `+` or `-` count only while inside a hunk.
 * - Each `diff --git` section counts as one file, including binary files and pure renames.
 * - Patch metadata outside hunks never contributes line counts.
 */
export function summarizeUnifiedPatchTotals(
  patch: string | null | undefined,
): UnifiedPatchTotals | null {
  if (!patch) return null;
  const trimmed = patch.trim();
  if (trimmed.length === 0) return null;

  let additions = 0;
  let deletions = 0;
  let fileCount = 0;
  let insideHunk = false;

  let lineStart = 0;
  while (lineStart <= trimmed.length) {
    let lineEnd = trimmed.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = trimmed.length;
    const firstChar = lineStart < lineEnd ? trimmed.charCodeAt(lineStart) : -1;

    if (firstChar === 100 /* d */ && startsWith(trimmed, lineStart, lineEnd, "diff --git ")) {
      fileCount += 1;
      insideHunk = false;
    } else if (firstChar === 64 /* @ */ && startsWith(trimmed, lineStart, lineEnd, "@@")) {
      insideHunk = true;
    } else if (insideHunk) {
      if (firstChar === 43 /* + */) {
        additions += 1;
      } else if (firstChar === 45 /* - */) {
        deletions += 1;
      }
    }

    lineStart = lineEnd + 1;
  }

  // A patch without `diff --git` headers can still contain one file's hunks (for example,
  // no-index output). Preserve the renderer's one-file result for that shape.
  if (fileCount === 0) {
    if (additions === 0 && deletions === 0) return null;
    fileCount = 1;
  }

  return { additions, deletions, fileCount };
}

function startsWith(source: string, lineStart: number, lineEnd: number, prefix: string): boolean {
  if (lineEnd - lineStart < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (source.charCodeAt(lineStart + index) !== prefix.charCodeAt(index)) return false;
  }
  return true;
}
