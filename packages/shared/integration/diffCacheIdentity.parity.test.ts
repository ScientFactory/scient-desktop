import { describe, expect, it } from "vite-plus/test";
import { buildPatchCacheKey as buildScopedPatchCacheKey } from "@t3tools/shared/diffCacheKey";
import { buildPatchCacheKey, fnv1a32 } from "../../../apps/web/src/lib/diffRendering.ts";

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

describe("cross-client patch cache identity", () => {
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
