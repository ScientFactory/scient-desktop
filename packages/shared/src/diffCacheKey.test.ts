import { describe, expect, it } from "vite-plus/test";
import { buildPatchCacheKey, fnv1a32 } from "./diffCacheKey.ts";

const legacyVectors = [
  { patch: "", scope: "scope", key: "scope:0:ztntfp:17wdrqx" },
  { patch: " \t\n", scope: "", key: ":0:ztntfp:17wdrqx" },
  { patch: "hello", scope: "review:thread:α", key: "review:thread:α:5:m3bicr:1up0ksn" },
  { patch: "  café 🚀\n+שלום\n", scope: "scope:δ", key: "scope:δ:13:8n539:1t2kjih" },
  { patch: "a\u0000b\ud800", scope: " raw scope ", key: " raw scope :4:zv0knq:y1piy2" },
  { patch: "\ufeffline\r\nnext\ufeff", scope: "scope", key: "scope:10:qkwoad:kn5atl" },
];

describe("diff cache identity compatibility", () => {
  it.each(legacyVectors)("retains the previous key '$key'", ({ patch, scope, key }) => {
    expect(buildPatchCacheKey(patch, scope)).toBe(key);
  });

  it("retains the exported hash defaults, UTF-16 units and explicit seed/multiplier", () => {
    expect(fnv1a32("hello")).toBe(1335831723);
    expect(fnv1a32("a\u0000b\ud800")).toBe(2168411030);
    expect(fnv1a32("hello", 0)).toBe(406904376);
    expect(fnv1a32("hello", -1, -3)).toBe(30165);
    expect(fnv1a32("llo", fnv1a32("he"))).toBe(fnv1a32("hello"));
  });
});
