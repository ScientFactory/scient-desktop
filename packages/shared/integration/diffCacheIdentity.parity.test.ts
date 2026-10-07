import { describe, expect, it } from "vite-plus/test";
import { buildPatchCacheKey as buildScopedPatchCacheKey } from "@t3tools/shared/diffCacheKey";
import { buildReviewParsedDiff } from "../../../apps/mobile/src/features/review/reviewModel.ts";
import {
  buildPatchCacheKey,
  fnv1a32,
  getRenderablePatch,
} from "../../../apps/web/src/lib/diffRendering.ts";

function patchWithContent(content: string) {
  return [
    "diff --git a/alpha.ts b/alpha.ts",
    "index 1111111..2222222 100644",
    "--- a/alpha.ts",
    "+++ b/alpha.ts",
    "@@ -1 +1 @@",
    "-before",
    `+${content}`,
    "diff --git a/beta.ts b/beta.ts",
    "index 3333333..4444444 100644",
    "--- a/beta.ts",
    "+++ b/beta.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
}

const vectors = [
  { scope: "review:thread:run", content: "const after = 2;", outer: "\n" },
  { scope: "", content: "café 🚀 שלום", outer: "\uFEFF\t\r\n" },
  { scope: " raw scope:δ ", content: "left  \tright", outer: " \t" },
];

describe("cross-client patch cache identity", () => {
  it.each(vectors)(
    "keeps parsed file and row identities aligned for scope '$scope'",
    ({ scope, content, outer }) => {
      const patch = patchWithContent(content);
      const padded = `${outer}${patch}${outer}`;
      const web = getRenderablePatch(padded, scope);
      const mobile = buildReviewParsedDiff(padded, scope);
      expect(web?.kind).toBe("files");
      expect(mobile.kind).toBe("files");
      if (web?.kind !== "files" || mobile.kind !== "files")
        throw new Error("Parity vector did not parse");
      const keys = web.files.map((file) => file.cacheKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
      expect(keys).toEqual(mobile.files.map((file) => file.cacheKey));
      expect(mobile.files.map((file) => file.id)).toEqual(keys);
      for (const file of mobile.files) {
        expect(file.rows.length).toBeGreaterThan(0);
        expect(file.rows.every((row) => row.id.startsWith(`${file.cacheKey}:`))).toBe(true);
      }
      expect(buildPatchCacheKey(padded, scope)).toBe(buildScopedPatchCacheKey(patch, scope));
    },
  );

  it("keeps the web default and separates changed content and explicit scopes", () => {
    const patch = patchWithContent("after");
    expect(fnv1a32("hello")).toBe(1335831723);
    expect(fnv1a32("hello", 0)).toBe(406904376);
    expect(fnv1a32("hello", -1, -3)).toBe(30165);
    expect(buildPatchCacheKey(patch)).toBe(buildScopedPatchCacheKey(patch, "diff-panel"));
    expect(buildPatchCacheKey(patch, "")).toBe(buildScopedPatchCacheKey(patch, ""));
    expect(buildPatchCacheKey(patch, "")).not.toBe(buildPatchCacheKey(patch));
    expect(buildPatchCacheKey(patch, "scope")).not.toBe(
      buildPatchCacheKey(patchWithContent("changed"), "scope"),
    );
    expect(buildPatchCacheKey(patch, "scope ")).not.toBe(buildPatchCacheKey(patch, "scope"));
  });
});
