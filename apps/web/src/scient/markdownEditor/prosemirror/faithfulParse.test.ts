import { defaultMarkdownParser, MarkdownParser } from "prosemirror-markdown";
import { describe, expect, it } from "vite-plus/test";

import { makeFaithfulMarkdownParse } from "./faithfulParse";
import { scientMarkdownOutlinePlugin, scientMarkdownOutlineState } from "./outline";
import { createScientMarkdownProjection, serializeScientMarkdownProjection } from "./projection";
import { ScientProseMirrorSession } from "./session";
import { EditorState } from "prosemirror-state";

const SCIENTIFIC_HEADINGS: ReadonlyArray<readonly [string, string]> = [
  ["## Estimating $\\beta$ here", "inline_math"],
  ["## Prior work [@smith2020]", "citation"],
  ["## See [[Methods]]", "wiki_link"],
  ["## Title[^1]", "footnote_reference"],
];

function textPosition(session: ScientProseMirrorSession, text: string): number {
  let position: number | undefined;
  session.state.doc.descendants((node, offset) => {
    if (position === undefined && node.isText && node.text?.includes(text)) {
      position = offset + node.text.indexOf(text);
    }
    return position === undefined;
  });
  if (position === undefined) throw new Error(`Text not found: ${text}`);
  return position;
}

describe("faithful Markdown projection", () => {
  it.each(SCIENTIFIC_HEADINGS)("shows %s as a heading that keeps its %s", (heading, atom) => {
    const source = `${heading}\n\nBody text.\n${atom === "footnote_reference" ? "\n[^1]: Note.\n" : ""}`;
    const projection = createScientMarkdownProjection(source);
    const first = projection.document.firstChild;

    expect(first?.type.name).toBe("heading");
    const children: string[] = [];
    first?.forEach((child) => children.push(child.type.name));
    expect(children).toContain(atom);
    expect(serializeScientMarkdownProjection(projection, projection.document)).toBe(source);
  });

  it("changes only the typed character when typing in a heading with math", () => {
    const source = "# Paper\n\n## Estimating $\\beta$ here\n\nBody text.\n";
    const session = new ScientProseMirrorSession({ source, revision: "r1", mode: "write" });
    const position = textPosition(session, "Estimating") + 1;

    session.applyTransaction(session.state.tr.insertText("x", position, position), "user");

    expect(session.session.draftSource).toBe(source.replace("Estimating", "Exstimating"));
  });

  it("keeps a heading with math inside a quote when another word in the quote is bolded", () => {
    const source = "> ## Hidden $x$ heading\n>\n> Keep body.\n";
    const session = new ScientProseMirrorSession({ source, revision: "r1", mode: "write" });
    expect(session.state.doc.firstChild?.firstChild?.type.name).toBe("heading");
    const from = textPosition(session, "Keep");
    const strong = session.state.schema.marks.strong;
    if (!strong) throw new Error("Missing strong mark.");

    session.applyTransaction(session.state.tr.addMark(from, from + 4, strong.create()), "user");

    expect(session.session.draftSource).toContain("## Hidden $x$ heading");
    expect(session.session.draftSource).toContain("**Keep** body.");
  });

  it("names a heading with math by its TeX in the outline", () => {
    const projection = createScientMarkdownProjection("## Estimating $\\beta$ here\n");
    const state = EditorState.create({
      doc: projection.document,
      plugins: [scientMarkdownOutlinePlugin()],
    });

    expect(scientMarkdownOutlineState(state).items[0]?.text).toBe("Estimating \\beta here");
  });
});

describe("makeFaithfulMarkdownParse", () => {
  // Strong emphasis mapped to a code block cannot sit inside a paragraph, so
  // the library drops the whole paragraph.
  const droppingParser = new MarkdownParser(
    defaultMarkdownParser.schema,
    defaultMarkdownParser.tokenizer,
    { ...defaultMarkdownParser.tokens, strong: { block: "code_block" } },
  );
  const parse = makeFaithfulMarkdownParse(droppingParser);

  it("refuses a parse in which the library silently dropped a node", () => {
    expect(droppingParser.parse("a **b** c").textContent).toBe("");
    expect(parse("a **b** c", {})).toBeNull();
  });

  it("returns the ordinary document when nothing was dropped", () => {
    expect(parse("a b c", {})?.toJSON()).toEqual(droppingParser.parse("a b c").toJSON());
  });

  it("starts each parse without the previous parse's refusal", () => {
    expect(parse("a **b** c", {})).toBeNull();
    expect(parse("plain", {})).not.toBeNull();
  });
});
