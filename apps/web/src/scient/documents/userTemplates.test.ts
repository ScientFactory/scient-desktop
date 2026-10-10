import "fake-indexeddb/auto";

import { describe, expect, it } from "vite-plus/test";

import {
  createNewDocumentSource,
  includedFiles,
  isDocumentTemplateId,
  isFolderTemplate,
  isUntouchedNewLatexDocument,
  templateCompanions,
  templateContents,
  templateName,
  withEmptyTitle,
} from "./documentTemplates";
import { normalizeNewDocumentTemplate } from "./documentPreferences";
import { userTemplates } from "./userTemplates";

const notes = `\\documentclass{article}
\\title{Weekly notes}
\\author{Ada}
\\begin{document}
\\maketitle
\\input{sections/summary}
% \\input{commented/out}
\\bibliography{references}
\\end{document}
`;

describe("the person's own templates", () => {
  it("keep a document with its title emptied and its included files", async () => {
    await userTemplates.ready();
    const saved = await userTemplates.save({
      name: "Weekly notes",
      source: withEmptyTitle(notes),
      files: { "sections/summary.tex": "Summary." },
      preview: null,
    });
    expect(saved.id.startsWith("user:")).toBe(true);
    expect(userTemplates.get(saved.id)?.source).toContain("\\title{}");
    expect(userTemplates.get(saved.id)?.source).toContain("\\author{Ada}");
    expect(isDocumentTemplateId(saved.id)).toBe(true);
    expect(normalizeNewDocumentTemplate(saved.id)).toBe(saved.id);
    expect(templateName(saved.id)).toBe("Weekly notes");

    // It includes a file, so a document started from it is a folder.
    expect(isFolderTemplate(saved.id)).toBe(true);
    const source = createNewDocumentSource({
      format: "latex",
      template: saved.id,
      language: "english",
    });
    expect(isUntouchedNewLatexDocument(source, saved.id, "english")).toBe(true);
    expect(templateCompanions(saved.id, source).map((file) => file.name)).toEqual([
      "sections/summary.tex",
      "references.bib",
    ]);

    await userTemplates.rename(saved.id, "Lab notes");
    expect(templateName(saved.id)).toBe("Lab notes");
    await userTemplates.remove(saved.id);
    expect(isDocumentTemplateId(saved.id)).toBe(false);
    expect(normalizeNewDocumentTemplate(saved.id)).toBe("blank");
  });

  it("rename without bringing back an older copy another window replaced", async () => {
    await userTemplates.ready();
    const saved = await userTemplates.save({
      name: "Notes",
      source: "old",
      files: {},
      preview: null,
    });
    // Another window updates the template; this window has not heard yet.
    const open = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("scient-document-templates", 1);
      request.addEventListener("success", () => resolve(request.result));
    });
    await new Promise<void>((resolve) => {
      const transaction = open.transaction("templates", "readwrite");
      transaction.objectStore("templates").put({ ...saved, source: "newer" });
      transaction.addEventListener("complete", () => resolve());
    });
    open.close();
    await userTemplates.rename(saved.id, "Lab notes");
    expect(userTemplates.get(saved.id)).toMatchObject({ name: "Lab notes", source: "newer" });
    await userTemplates.remove(saved.id);
  });

  it("copy a built-in template's source and files", () => {
    expect(templateContents("article").files).toEqual({});
    expect(Object.keys(templateContents("thesis").files)).toContain("chapters/introduction.tex");
  });

  it("read the files a source includes, inside its folder only", () => {
    expect(includedFiles(notes)).toEqual(["sections/summary.tex"]);
    expect(
      includedFiles("\\include{chapters/a}\n\\input{../outside}\n\\subfile{figure.tikz}"),
    ).toEqual(["chapters/a.tex", "figure.tikz"]);
  });
});
