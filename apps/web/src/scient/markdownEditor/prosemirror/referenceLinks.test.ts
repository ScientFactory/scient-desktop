import { describe, expect, it } from "vite-plus/test";
import { scientMarkdownSchema } from "./schema";
import { ScientProseMirrorSession } from "./session";
import { closeHistory } from "prosemirror-history";
import { runScientMarkdownCommand } from "./commands";

function editWikiLabel(session: ScientProseMirrorSession) {
  session.state.doc.descendants((node, position) => {
    if (node.type.name === "wiki_link") {
      session.applyTransaction(
        session.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, label: "Edited" }),
        "user",
      );
      return false;
    }
  });
}

function editDefinition(session: ScientProseMirrorSession, source: string) {
  const position = session.state.doc.firstChild!.nodeSize;
  const node = session.state.doc.nodeAt(position)!;
  session.applyTransaction(
    closeHistory(session.state.tr).setNodeMarkup(position, undefined, { ...node.attrs, source }),
    "user",
  );
}

function targets(session: ScientProseMirrorSession) {
  const destinations: string[] = [];
  session.state.doc.descendants((node) => {
    if (node.type.name === "image") destinations.push(node.attrs.src);
    for (const mark of node.marks)
      if (mark.type.name === "link") destinations.push(mark.attrs.href);
  });
  return destinations;
}

describe("reference dependencies survive block serialization", () => {
  it("preserves reference identity through edit, definition change, undo, and redo", () => {
    const source = "[[target|Label]] and [Methods][m].\n\n[m]: old.md\n";
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    editWikiLabel(session);
    editDefinition(session, "[m]: new.md");
    const edited = session.session.draftSource;
    runScientMarkdownCommand("undo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(targets(session)).toEqual(["old.md"]);
    runScientMarkdownCommand("undo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe(source);
    runScientMarkdownCommand("redo", session.state, (tr) => session.applyTransaction(tr, "user"));
    runScientMarkdownCommand("redo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe(edited);
    expect(targets(session)).toEqual(["new.md"]);
  });
  it.each([
    ["[Methods][m]", "m"],
    ["[m][]", "m"],
    ["[m]", "m"],
    ["[Methods][My METHOD]", "My METHOD"],
    ["[Méthode 😀]", "Méthode 😀"],
    ["[bracket\\]]", "bracket\\]"],
    ["![Methods][m]", "m"],
    ["![m][]", "m"],
    ["![m]", "m"],
  ])("keeps %s bound when an adjacent wiki label changes", (reference, label) => {
    const session = new ScientProseMirrorSession({
      source: `[[target|Label]] and ${reference}.\n\n[${label}]: old.md "Old title"\n`,
      revision: "r0",
    });
    editWikiLabel(session);
    expect(session.session.draftSource).toContain(`][${label}]`);
    expect(session.session.draftSource).not.toContain("](old.md");
    editDefinition(session, `[${label}]: new.md "New title"`);
    expect(targets(session)).toEqual(["new.md"]);
    const reopened = new ScientProseMirrorSession({
      source: session.session.draftSource,
      revision: "r1",
    });
    expect(targets(reopened)).toEqual(["new.md"]);
  });

  it.each([
    "[[target|Label]] and [Methods][m].",
    "> [[target|Label]] and [Methods][m].",
    "- [[target|Label]] and [Methods][m].",
    "| A | B |\n| --- | --- |\n| [[target\\|Label]] | [Methods][m] |",
  ])("preserves dependencies in a rewritten container: %s", (block) => {
    const session = new ScientProseMirrorSession({
      source: `${block}\n\n[m]: old.md\n`,
      revision: "r0",
    });
    expect(targets(session)).toEqual(["old.md"]);
    editWikiLabel(session);
    editDefinition(session, "[m]: new.md");
    expect(targets(session)).toEqual(["new.md"]);
  });

  it("keeps a shortcut's original definition when its visible text is formatted or edited", () => {
    const session = new ScientProseMirrorSession({
      source: "[Methods]\n\n[Methods]: old.md\n",
      revision: "r0",
    });
    session.applyTransaction(session.state.tr.insertText("New ", 3), "user");
    session.applyTransaction(
      session.state.tr.addMark(1, 12, scientMarkdownSchema.marks.strong!.create()),
      "user",
    );
    expect(session.session.draftSource).toContain("][Methods]");
    editDefinition(session, "[Methods]: new.md");
    expect([...new Set(targets(session))]).toEqual(["new.md"]);
  });

  it.each(["link", "image"])("respects an explicit %s destination edit", (kind) => {
    const source = `${kind === "image" ? "!" : ""}[Methods][m]\n\n[m]: old.md\n`;
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    const node = session.state.doc.firstChild!.firstChild!;
    const transaction =
      kind === "image"
        ? session.state.tr.setNodeMarkup(1, undefined, { ...node.attrs, src: "chosen.md" })
        : session.state.tr.addMark(
            1,
            8,
            scientMarkdownSchema.marks.link!.create({ href: "chosen.md" }),
          );
    session.applyTransaction(transaction, "user");
    expect(session.session.draftSource).toContain("](chosen.md)");
    editDefinition(session, "[m]: new.md");
    expect(targets(session)).toEqual(["chosen.md"]);
  });

  it("does not turn inline links or autolinks into references", () => {
    const session = new ScientProseMirrorSession({
      source:
        "[[target|Label]] [inline](chosen.md) <https://example.org> ![alt](plot.png)\n\n[m]: old.md\n",
      revision: "r0",
    });
    editWikiLabel(session);
    expect(session.session.draftSource).toContain("[inline](chosen.md)");
    expect(session.session.draftSource).toContain("<https://example.org>");
    expect(session.session.draftSource).toContain("![alt](plot.png)");
  });
});
