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

  it("changes only the typed character in a heading with math in a CRLF file", () => {
    const source = "# Paper\r\n\r\n## Estimating $\\beta$ here\r\n\r\nBody text.\r\n";
    const session = new ScientProseMirrorSession({ source, revision: "r1", mode: "write" });
    const position = textPosition(session, "Estimating") + 1;

    session.applyTransaction(session.state.tr.insertText("x", position, position), "user");

    expect(session.session.draftSource).toBe(source.replace("Estimating", "Exstimating"));
  });

  it.each([
    ["a heading whose equation spans lines", "Title \\(a\nb\\)\n===\n"],
    ["a quote holding a reference definition", "> [r]: https://example.org\n>\n> Keep body.\n"],
    ["a quote holding an HTML comment", "> Quote text\n>\n> <!-- keep me -->\n"],
    ["a list item holding display math", "- Alpha item\n\n  $$\n  x^2\n  $$\n\n- Beta\n"],
    [
      "a quote holding a heading whose equation spans lines",
      "> Title \\(a\n> b\\)\n> ===\n>\n> Body.\n",
    ],
    ["a quote with reversed direction lines", '> </div>\n>\n> Text\n>\n> <div dir="rtl">\n'],
    [
      "a quote with a surplus closing line",
      '> <div dir="rtl">\n>\n> Text\n>\n> </div>\n>\n> </div>\n',
    ],
    [
      "a quote with nested direction wrappers",
      '> <div dir="rtl">\n>\n> <div dir="ltr">\n>\n> Inner\n>\n> </div>\n>\n> Outer\n>\n> </div>\n',
    ],
    [
      "a quote with direction around code",
      '> <div dir="rtl">\n>\n> ```\n> code\n> ```\n>\n> </div>\n',
    ],
    ["direction around a code block", '<div dir="rtl">\n\n```\ncode\n```\n\n</div>\n'],
  ])("keeps %s as editable source", (_case, source) => {
    const projection = createScientMarkdownProjection(source);

    expect(projection.document.childCount).toBe(1);
    expect(projection.document.firstChild?.type.name).toBe("raw_block");
    expect(projection.document.firstChild?.attrs.source).toBe(source.trimEnd());
    expect(serializeScientMarkdownProjection(projection, projection.document)).toBe(source);
  });

  it.each([
    ['<div dir="auto">\n\n## Title\n\n</div>\n', "heading"],
    ['<div dir="rtl">\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n</div>\n', "table"],
  ])("keeps a direction-wrapped block rich: %s", (source, name) => {
    const projection = createScientMarkdownProjection(source);

    expect(projection.document.firstChild?.type.name).toBe(name);
  });

  it("writes a fence that keeps an info string containing backticks", () => {
    const source = "> ~~~ js `extra`\n> code\n> ~~~\n>\n> Keep body.\n";
    const session = new ScientProseMirrorSession({ source, revision: "r1", mode: "write" });
    const params = session.state.doc.firstChild?.child(0).attrs.params;
    expect(String(params).trim()).toBe("js `extra`");
    const from = textPosition(session, "Keep");
    const strong = session.state.schema.marks.strong;
    if (!strong) throw new Error("Missing strong mark.");

    session.applyTransaction(session.state.tr.addMark(from, from + 4, strong.create()), "user");

    const reopened = createScientMarkdownProjection(session.session.draftSource).document;
    const quote = reopened.firstChild;
    expect(quote?.type.name).toBe("blockquote");
    expect(quote?.child(0).type.name).toBe("code_block");
    expect(quote?.child(0).attrs.params).toBe(params);
    expect(quote?.child(0).textContent).toBe("code");
    expect(quote?.child(1).textContent).toBe("Keep body.");
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

  it("keeps each answer separate when one parse runs inside another", () => {
    let nested: string | null = null;
    let inner: ReturnType<typeof parse> | undefined;
    const reentrant = new MarkdownParser(
      defaultMarkdownParser.schema,
      defaultMarkdownParser.tokenizer,
      {
        ...defaultMarkdownParser.tokens,
        strong: { block: "code_block" },
        em: {
          mark: "em",
          getAttrs: () => {
            if (nested !== null) inner = reentrantParse(nested, {});
            return null;
          },
        },
      },
    );
    const reentrantParse = makeFaithfulMarkdownParse(reentrant);

    // The outer parse drops a node; a clean inner parse must not hide that.
    nested = "plain";
    expect(reentrantParse("*a* **b**", {})).toBeNull();
    expect(inner).not.toBeNull();

    // The outer parse is clean; a dropping inner parse must not reject it.
    nested = "a **b** c";
    expect(reentrantParse("*a* c", {})).not.toBeNull();
    expect(inner).toBeNull();
  });

  it("keeps an outer refusal that happened before the inner parse ran", () => {
    let inner: ReturnType<typeof parse> | undefined;
    const reentrant = new MarkdownParser(
      defaultMarkdownParser.schema,
      defaultMarkdownParser.tokenizer,
      {
        ...defaultMarkdownParser.tokens,
        strong: { block: "code_block" },
        em: {
          mark: "em",
          getAttrs: () => {
            inner = reentrantParse("plain", {});
            return null;
          },
        },
      },
    );
    const reentrantParse = makeFaithfulMarkdownParse(reentrant);

    expect(reentrantParse("a **b** c\n\n*a*", {})).toBeNull();
    expect(inner).not.toBeNull();
  });

  it("starts each parse without the previous parse's refusal", () => {
    expect(parse("a **b** c", {})).toBeNull();
    expect(parse("plain", {})).not.toBeNull();
  });
});
