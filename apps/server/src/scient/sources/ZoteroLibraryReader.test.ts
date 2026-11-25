import { describe, expect, it } from "@effect/vitest";

import { fakeZoteroTransport, zoteroItem } from "./Zotero.testkit.ts";
import { listZoteroLibraryWith, listZoteroScopeItemKeysWith } from "./ZoteroLibraryReader.ts";

describe("Zotero library browse", () => {
  it("counts a scope's references as its import brings them, without standalone notes or files", async () => {
    const transport = fakeZoteroTransport({
      items: new Map(
        [
          zoteroItem("ABCD2345", { title: "First" }),
          zoteroItem("BCDE2345", { title: "Second" }),
          zoteroItem("CDEF2345", { itemType: "note", note: "<p>A standalone note</p>" }),
          zoteroItem("DEFG2345", { itemType: "attachment", contentType: "application/pdf" }),
        ].map((item) => [item.key, { item, children: [] }]),
      ),
    });
    const scope = { kind: "library" } as const;

    const page = await listZoteroLibraryWith(transport, { scope, query: "", start: 0, limit: 50 });

    expect(page.total).toBe((await listZoteroScopeItemKeysWith(transport, scope)).length);
    expect(page.total).toBe(2);
  });
});
