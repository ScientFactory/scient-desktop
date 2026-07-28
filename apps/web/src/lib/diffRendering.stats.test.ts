// FILE: diffRendering.stats.test.ts
// Purpose: Keep compact server-side patch totals identical to the renderer's full parse.
// Layer: Web/shared contract test

import { summarizeUnifiedPatchTotals } from "@synara/shared/unifiedPatchStats";
import { describe, expect, it } from "vitest";

import { summarizePatchTotals } from "./diffRendering";

const MODIFIED_FILE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const keep = 1;
-const removed = 2;
+const added = 2;
+const alsoAdded = 3;
 const tail = 4;
`;

const ADDED_FILE = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+line one
+line two
`;

const DELETED_FILE = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second
`;

const PURE_RENAME = `diff --git a/src/old.ts b/src/renamed.ts
similarity index 100%
rename from src/old.ts
rename to src/renamed.ts
`;

const BINARY_FILE = `diff --git a/assets/logo.png b/assets/logo.png
index 8888888..9999999 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

const NO_INDEX_FILE = `--- /dev/null
+++ b/notes.md
@@ -0,0 +1,2 @@
+# Notes
+Some text.
`;

const DIFF_SHAPED_CONTENT = `diff --git a/README.md b/README.md
index ccccccc..ddddddd 100644
--- a/README.md
+++ b/README.md
@@ -1,4 +1,4 @@
-diff --git a/x b/x
---- a/x
-+++ b/x
+diff --git a/y b/y
+--- a/y
++++ b/y
`;

const CASES: ReadonlyArray<readonly [name: string, patch: string]> = [
  ["a modified file", MODIFIED_FILE],
  ["an added file", ADDED_FILE],
  ["a deleted file", DELETED_FILE],
  ["a pure rename", PURE_RENAME],
  ["a binary file", BINARY_FILE],
  ["no-index output without a diff header", NO_INDEX_FILE],
  ["content lines that resemble patch metadata", DIFF_SHAPED_CONTENT],
  [
    "multiple file shapes concatenated",
    [MODIFIED_FILE, ADDED_FILE, DELETED_FILE, PURE_RENAME, BINARY_FILE].join(""),
  ],
];

describe("compact unified patch totals", () => {
  for (const [name, patch] of CASES) {
    it(`match the renderer for ${name}`, () => {
      expect(summarizeUnifiedPatchTotals(patch)).toEqual(summarizePatchTotals(patch));
    });
  }

  it("matches the renderer for empty patch states", () => {
    for (const empty of ["", "   \n  ", undefined]) {
      expect(summarizeUnifiedPatchTotals(empty)).toEqual(summarizePatchTotals(empty));
    }
  });
});
