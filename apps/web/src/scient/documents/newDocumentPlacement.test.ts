import { describe, expect, it } from "vite-plus/test";

import { createNewDocumentSource } from "./documentTemplates";
import type { CreatedCompanion } from "./newDocumentCompanions";
import {
  type FolderEntry,
  filesUnder,
  freeFolderName,
  newDocumentBase,
  placeNewDocument,
  untitledStem,
} from "./newDocumentPlacement";

/** A project held in memory: paths to revisions. */
function project(paths: readonly string[] = []) {
  const files = new Map(paths.map((path) => [path, "existing"]));
  let next = 0;
  const commands = {
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
    list: async (folder: string): Promise<FolderEntry[]> => {
      const names = new Map<string, boolean>();
      for (const path of files.keys()) {
        if (!path.startsWith(folder)) continue;
        const [name, ...rest] = path.slice(folder.length).split("/");
        names.set(name!, rest.length > 0 || names.get(name!) === true);
      }
      return [...names].map(([name, folder]) => ({ name, folder }));
    },
  };
  return { files, commands };
}

const thesis = createNewDocumentSource({
  format: "latex",
  template: "thesis",
  language: "english",
});
const article = createNewDocumentSource({
  format: "latex",
  template: "article",
  language: "english",
});

describe("placing a new document", () => {
  it("numbers the name past files that exist or hold leftover work", async () => {
    const { commands } = project(["untitled.tex"]);
    const placed = await placeNewDocument({
      format: "latex",
      base: "",
      stem: "untitled",
      template: "article",
      source: article,
      commands,
      skip: (path) => path === "untitled-2.tex",
    });
    expect(placed?.relativePath).toBe("untitled-3.tex");
    expect(placed?.companions.map((file) => file.relativePath)).toEqual(["references.bib"]);
  });

  it("gives a thesis a folder of its own, with its chapters and bibliography", async () => {
    const { files, commands } = project(["thesis/notes.md", "Thesis-2"]);
    const placed = await placeNewDocument({
      format: "latex",
      base: "",
      stem: untitledStem("latex", "thesis"),
      template: "thesis",
      source: thesis,
      commands,
    });
    // `thesis` holds someone's notes and `Thesis-2` is a file: neither is used.
    expect(placed?.relativePath).toBe("thesis-3/main.tex");
    expect([...files.keys()].filter((path) => path.startsWith("thesis-3/")).sort()).toEqual([
      "thesis-3/chapters/appendix.tex",
      "thesis-3/chapters/background.tex",
      "thesis-3/chapters/conclusion.tex",
      "thesis-3/chapters/discussion.tex",
      "thesis-3/chapters/introduction.tex",
      "thesis-3/chapters/methods.tex",
      "thesis-3/chapters/results.tex",
      "thesis-3/main.tex",
      "thesis-3/references.bib",
    ]);
    expect(newDocumentBase(placed!.relativePath, "thesis")).toBe("");
    expect(newDocumentBase("papers/thesis/main.tex", "thesis")).toBe("papers/");
    expect(newDocumentBase("papers/untitled.tex", "article")).toBe("papers/");
  });

  it("finds a free folder name and lists every file under a folder", async () => {
    const { commands } = project(["heat/a.tex", "heat/chapters/b.tex", "heat-2/c.tex"]);
    expect(await freeFolderName(commands, "", "heat")).toBe("heat-3");
    expect([...(await filesUnder(commands, "heat/"))!].sort()).toEqual([
      "heat/a.tex",
      "heat/chapters/b.tex",
    ]);
  });

  it("keeps Markdown documents to a single file", async () => {
    const { commands } = project();
    const placed = await placeNewDocument({
      format: "markdown",
      base: "notes/",
      stem: "untitled",
      template: "thesis",
      source: "# \n",
      commands,
    });
    expect(placed).toEqual({ relativePath: "notes/untitled.md", revision: "r1", companions: [] });
  });

  it("makes nothing when a file of the template's own cannot be written", async () => {
    const { files, commands } = project();
    const failing = {
      ...commands,
      create: async (path: string, contents: string) =>
        path.endsWith("chapters/methods.tex") ? null : commands.create(path, contents),
    };
    const placed = await placeNewDocument({
      format: "latex",
      base: "",
      stem: "thesis",
      template: "thesis",
      source: thesis,
      commands: failing,
    });
    expect(placed).toBeNull();
    expect([...files.keys()]).toEqual([]);
  });
});
