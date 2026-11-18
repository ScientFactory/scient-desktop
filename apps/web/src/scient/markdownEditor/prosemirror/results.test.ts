import { describe, expect, it } from "vite-plus/test";

import { editorResultReferences, updateResults } from "./results";
import { ScientProseMirrorSession } from "./session";

const OLD = "r0123456789ab";
const NEW = "rzyxwvutsrqpo";

const source = [
  "# Results",
  "",
  `Of *all* patients, [1204](scient-result:${OLD}/values.json#/cohort/n) were included (HR [\\<0.72](scient-result:${OLD}/values.json#/hr)).`,
  "",
  `[![Survival](assets/results/km-${OLD}.png)](scient-result:${OLD}/km.png)`,
  "",
].join("\n");

describe("linked results in the Markdown editor", () => {
  it("reads values and figures, and keeps the file's bytes until they change", () => {
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    const references = editorResultReferences(session.state.doc);
    expect(references.map((reference) => [reference.kind, reference.pointer])).toEqual([
      ["value", "/cohort/n"],
      ["value", "/hr"],
      ["figure", null],
    ]);
    expect(references[1]).toMatchObject({ kind: "value", text: "<0.72" });
    const caret = `[\\^1](scient-result:${OLD}/values.json#/note)\n`;
    const footnoteLike = new ScientProseMirrorSession({ source: caret, revision: "r0" });
    expect(editorResultReferences(footnoteLike.state.doc)).toMatchObject([{ text: "^1" }]);
    expect(session.session.draftSource).toBe(source);
  });

  it("moves every result to a new revision in one change, leaving the prose alone", () => {
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    const updates = editorResultReferences(session.state.doc).map((reference) =>
      reference.kind === "value"
        ? {
            kind: "value" as const,
            position: reference.position,
            href: reference.href.replace(OLD, NEW),
            text: reference.pointer === "/hr" ? "0.70" : "1198",
          }
        : {
            kind: "figure" as const,
            position: reference.position,
            href: reference.href.replace(OLD, NEW),
            src: `assets/results/km-${NEW}.png`,
          },
    );
    const transaction = updateResults(session.state, updates);
    if (transaction === null) throw new Error("Nothing was updated.");
    session.applyTransaction(transaction, "user");
    expect(session.session.draftSource).toBe(
      source.replaceAll(OLD, NEW).replace("1204", "1198").replace("\\<0.72", "0.70"),
    );
    const reopened = new ScientProseMirrorSession({
      source: session.session.draftSource,
      revision: "r1",
    });
    expect(
      editorResultReferences(reopened.state.doc).map((reference) => reference.revision),
    ).toEqual([NEW, NEW, NEW]);
  });
});
