import { closeHistory } from "prosemirror-history";
import { NodeSelection } from "prosemirror-state";
import { describe, expect, it, vi } from "vite-plus/test";

import { runScientMarkdownCommand } from "./commands";
import { ScientProseMirrorSession } from "./session";

describe("Markdown image attributes", () => {
  it.each([
    ["A *bold* and `code`", "A bold and code"],
    ["*bold* then **strong** and ~~old~~", "bold then strong and old"],
    ["a\\]b &amp; c &#x1f600;", "a]b & c 😀"],
    ["outer ![inner *label*](inner.png) end", "outer inner label end"],
    ["[linked words](other.md)", "linked words"],
    ["תמונה **אחת** image", "תמונה אחת image"],
    ["first\nsecond", "first\nsecond"],
    ["first<br>second", "first\nsecond"],
    ["[[file|Label]] [^note] [@paper] $x^2$", "Label [^note] [@paper] x^2"],
  ])("preserves complete alternative text after editing a caption: %s", (label, alternative) => {
    const source = `![${label}](plot.png "Old caption")\n\nUntouched  paragraph.\n`;
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    expect(session.state.doc.nodeAt(1)?.attrs.alt).toBe(alternative);
    expect(session.session.draftSource).toBe(source);

    session.applyTransaction(session.state.tr.setNodeAttribute(1, "title", "New caption"), "user");
    const reopened = new ScientProseMirrorSession({
      source: session.session.draftSource,
      revision: "r1",
    });
    expect(reopened.state.doc.nodeAt(1)?.attrs.alt).toBe(alternative);
    expect(reopened.state.doc.nodeAt(1)?.attrs.title).toBe("New caption");
    expect(session.session.draftSource).toContain("\n\nUntouched  paragraph.\n");
    runScientMarkdownCommand("undo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe(source);
  });

  it("updates image and wrapping link references without losing selection or earlier undo", () => {
    const source =
      '[![Alt][figure]][link]\n\n[figure]: old.png "Old caption"\n\n[link]: old.md "Old link"\n';
    const onUserSourceChange = vi.fn();
    const session = new ScientProseMirrorSession({ source, revision: "r0", onUserSourceChange });
    session.applyTransaction(
      session.state.tr.setSelection(NodeSelection.create(session.state.doc, 1)),
      "user",
    );
    session.applyTransaction(session.state.tr.setNodeAttribute(1, "alt", "Local alt"), "user");
    const definitionPositions: number[] = [];
    session.state.doc.forEach((node, position) => {
      if (node.type.name === "raw_block") definitionPositions.push(position);
    });
    session.applyTransaction(
      closeHistory(session.state.tr)
        .setNodeAttribute(definitionPositions[0]!, "source", '[figure]: new.png "New caption"')
        .setNodeAttribute(definitionPositions[1]!, "source", '[link]: new.md "New link"'),
      "user",
    );
    const image = session.state.doc.nodeAt(1)!;
    expect(image.attrs).toMatchObject({ src: "new.png", title: "New caption", alt: "Local alt" });
    expect(image.marks[0]?.attrs).toMatchObject({ href: "new.md", title: "New link" });
    expect(session.state.selection).toBeInstanceOf(NodeSelection);
    expect(session.state.selection.from).toBe(1);
    expect(onUserSourceChange).toHaveBeenCalledTimes(2);
    expect(session.session.draftSource).toContain("[![Local alt][figure]][link]");

    runScientMarkdownCommand("undo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.state.selection).toBeInstanceOf(NodeSelection);
    expect(session.state.doc.nodeAt(1)?.attrs.src).toBe("old.png");
    expect(session.state.doc.nodeAt(1)?.marks[0]?.attrs.href).toBe("old.md");
    runScientMarkdownCommand("undo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe(source);
    runScientMarkdownCommand("redo", session.state, (tr) => session.applyTransaction(tr, "user"));
    runScientMarkdownCommand("redo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.state.doc.nodeAt(1)?.attrs.src).toBe("new.png");
    expect(session.state.doc.nodeAt(1)?.marks[0]?.attrs.href).toBe("new.md");
  });
});

describe("active Markdown reference definition navigation", () => {
  it.each([
    {
      source: '![Plot][figure]\n\n[figure]: plot.png "Caption"\n',
      label: "figure",
      definition: "[figure]:",
      line: 3,
    },
    {
      source:
        "![Plot][fig one]\n\n> Intro\n>\n> [FiG   one]: first.png\n\n[fig one]: ignored.png\n",
      label: "  FIG\tone  ",
      definition: "[FiG   one]:",
      line: 5,
    },
    {
      source: "![Plot][figure]\n\n- [figure]: first.png\n\n[FIGURE]: ignored.png\n",
      label: "FIGURE",
      definition: "[figure]:",
      line: 3,
    },
    {
      source: "![Plot][STRASSE]\r\n\r\n> [Straße]: first.png\r\n\r\n[STRASSE]: ignored.png\r\n",
      label: "straße",
      definition: "[Straße]:",
      line: 3,
    },
    {
      source: "![Plot][bracket\\]]\n\n[bracket\\]]: plot.png\n",
      label: "bracket\\]",
      definition: "[bracket\\]]:",
      line: 3,
    },
    {
      source: "```md\n[figure]: fake.png\n```\n\n![Plot][figure]\n\n[figure]: real.png\n",
      label: "figure",
      definition: "[figure]: real",
      line: 7,
    },
    {
      source: "![Plot][multi line]\n\n[multi\n line]: plot.png\n",
      label: "multi line",
      definition: "[multi\n",
      line: 3,
    },
  ])(
    "locates the parser's winning definition: $definition",
    ({ source, label, definition, line }) => {
      const onUserSourceChange = vi.fn();
      const session = new ScientProseMirrorSession({ source, revision: "r0", onUserSourceChange });
      expect(session.referenceDefinitionForLabel(label)).toEqual({
        sourceOffset: source.indexOf(definition),
        line,
      });
      expect(onUserSourceChange).not.toHaveBeenCalled();
      expect(session.session.draftSource).toBe(source);
    },
  );

  it("uses current draft offsets after editing and returns null for missing definitions", () => {
    const session = new ScientProseMirrorSession({
      source: "Text.\n\n![Plot][figure]\n\n[figure]: plot.png\n",
      revision: "r0",
    });
    session.applyTransaction(session.state.tr.insertText("Longer ", 1), "user");
    expect(session.referenceDefinitionForLabel("figure")).toEqual({
      sourceOffset: session.session.draftSource.indexOf("[figure]:"),
      line: 5,
    });
    expect(session.referenceDefinitionForLabel("missing")).toBeNull();
  });
});
