import { describe, expect, it } from "vite-plus/test";

import { companionFiles } from "./documentTemplates";
import { type CreatedCompanion, syncCompanionFiles } from "./newDocumentCompanions";

function disk(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  let next = 0;
  return {
    files,
    create: async (path: string) => {
      if (files.has(path)) return "exists" as const;
      const revision = `r${++next}`;
      files.set(path, revision);
      return { revision };
    },
    remove: async (file: CreatedCompanion) => {
      if (files.get(file.relativePath) !== file.revision) return false;
      files.delete(file.relativePath);
      return true;
    },
  };
}

const withBibliography = "\\bibliographystyle{plainnat}\n\\bibliography{references}\n";

describe("companion files", () => {
  it("reads the bibliography files a source names", () => {
    expect(companionFiles(withBibliography)).toEqual(["references.bib"]);
    expect(companionFiles("\\addbibresource{refs.bib}\n\\bibliography{a, b}")).toEqual([
      "refs.bib",
      "a.bib",
      "b.bib",
    ]);
    expect(companionFiles("% \\bibliography{commented}\n")).toEqual([]);
    expect(companionFiles("\\bibliography{../outside}")).toEqual([]);
  });

  it("creates the bibliography beside the document, or uses the one already there", async () => {
    const fresh = disk();
    const created = await syncCompanionFiles({
      folder: "papers/",
      source: withBibliography,
      created: [],
      ...fresh,
    });
    expect(created).toEqual([{ relativePath: "papers/references.bib", revision: "r1" }]);

    const existing = disk({ "references.bib": "theirs" });
    expect(
      await syncCompanionFiles({ folder: "", source: withBibliography, created: [], ...existing }),
    ).toEqual([]);
    expect(existing.files.get("references.bib")).toBe("theirs");
  });

  it("removes only its own unchanged file when a template no longer needs it", async () => {
    const files = disk();
    const created = await syncCompanionFiles({
      folder: "",
      source: withBibliography,
      created: [],
      ...files,
    });
    expect(await syncCompanionFiles({ folder: "", source: "", created, ...files })).toEqual([]);
    expect(files.files.has("references.bib")).toBe(false);

    const again = await syncCompanionFiles({
      folder: "",
      source: withBibliography,
      created: [],
      ...files,
    });
    files.files.set("references.bib", "edited");
    expect(await syncCompanionFiles({ folder: "", source: "", created: again, ...files })).toEqual(
      [],
    );
    expect(files.files.get("references.bib")).toBe("edited");
  });
});
