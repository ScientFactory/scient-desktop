import { describe, expect, it } from "vite-plus/test";

import { companionFiles, templateCompanions } from "./documentTemplates";
import { type CreatedCompanion, syncCompanionFiles } from "./newDocumentCompanions";

function disk(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  let next = 0;
  return {
    stored: files,
    create: async (path: string, _contents: string) => {
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
const bibliography = templateCompanions("blank", withBibliography);

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
      files: bibliography,
      created: [],
      ...fresh,
    });
    expect(created).toEqual([{ relativePath: "papers/references.bib", revision: "r1" }]);

    const existing = disk({ "references.bib": "theirs" });
    expect(
      await syncCompanionFiles({ folder: "", files: bibliography, created: [], ...existing }),
    ).toEqual([]);
    expect(existing.stored.get("references.bib")).toBe("theirs");
  });

  it("retains a bibliography another document may already share", async () => {
    const files = disk();
    const created = await syncCompanionFiles({
      folder: "",
      files: bibliography,
      created: [],
      ...files,
    });
    await syncCompanionFiles({ folder: "", files: [], created, ...files });
    expect(files.stored.has("references.bib")).toBe(true);
  });

  it("refreshes same-name private companions only while their revision is unchanged", async () => {
    const files = disk();
    const created = await syncCompanionFiles({
      folder: "",
      files: [{ name: "chapter.tex", contents: "old" }],
      created: [],
      ...files,
    });
    const replace = async (file: CreatedCompanion, contents: string) => {
      if (files.stored.get(file.relativePath) !== file.revision) return null;
      files.stored.set(file.relativePath, contents);
      return { revision: contents };
    };
    const changed = await syncCompanionFiles({
      folder: "",
      files: [{ name: "chapter.tex", contents: "new" }],
      created,
      ...files,
      replace,
    });
    expect(files.stored.get("chapter.tex")).toBe("new");
    files.stored.set("chapter.tex", "user work");
    await syncCompanionFiles({
      folder: "",
      files: [{ name: "chapter.tex", contents: "other" }],
      created: changed,
      ...files,
      replace,
    });
    expect(files.stored.get("chapter.tex")).toBe("user work");
  });

  it("removes only its own unchanged private file when a template no longer needs it", async () => {
    const bibliography = [{ name: "chapter.tex", contents: "chapter" }];
    const files = disk();
    const created = await syncCompanionFiles({
      folder: "",
      files: bibliography,
      created: [],
      ...files,
    });
    expect(await syncCompanionFiles({ folder: "", files: [], created, ...files })).toEqual([]);
    expect(files.stored.has("chapter.tex")).toBe(false);

    const again = await syncCompanionFiles({
      folder: "",
      files: bibliography,
      created: [],
      ...files,
    });
    files.stored.set("chapter.tex", "edited");
    expect(await syncCompanionFiles({ folder: "", files: [], created: again, ...files })).toEqual(
      [],
    );
    expect(files.stored.get("chapter.tex")).toBe("edited");
  });
});
