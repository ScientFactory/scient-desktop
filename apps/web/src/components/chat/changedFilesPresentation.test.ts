import { describe, expect, it } from "vitest";

import {
  CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT,
  CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT,
  resolveChangedFilesExpanded,
  shouldAutoExpandChangedFiles,
} from "./changedFilesPresentation";

const file = (path: string, additions = 1, deletions = 0) => ({
  path,
  additions,
  deletions,
});

describe("changed-files presentation defaults", () => {
  it("auto-expands only the current small, low-churn change", () => {
    const smallChange = [file("src/a.ts", 80, 20), file("src/b.ts", 60, 20)];

    expect(shouldAutoExpandChangedFiles(smallChange, true)).toBe(true);
    expect(shouldAutoExpandChangedFiles(smallChange, false)).toBe(false);
  });

  it("collapses the current change above either bulk threshold", () => {
    expect(
      shouldAutoExpandChangedFiles(
        Array.from({ length: CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT + 1 }, (_, index) =>
          file(`src/${index}.ts`),
        ),
        true,
      ),
    ).toBe(false);
    expect(
      shouldAutoExpandChangedFiles(
        [file("src/large.ts", CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT + 1)],
        true,
      ),
    ).toBe(false);
  });

  it("keeps the documented limits inclusive", () => {
    expect(
      shouldAutoExpandChangedFiles(
        Array.from({ length: CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT }, (_, index) =>
          file(
            `src/${index}.ts`,
            CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT / CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT,
          ),
        ),
        true,
      ),
    ).toBe(true);
  });

  it("preserves an explicit user choice when the card later becomes older", () => {
    const files = [file("src/a.ts")];

    expect(resolveChangedFilesExpanded({ files, isCurrentChange: false, userOverride: true })).toBe(
      true,
    );
    expect(resolveChangedFilesExpanded({ files, isCurrentChange: true, userOverride: false })).toBe(
      false,
    );
  });
});
