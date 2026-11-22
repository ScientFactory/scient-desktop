import { describe, expect, it } from "@effect/vitest";

import { ZOTERO_NOTE_CHARACTERS, zoteroNotesMarkdown } from "./ZoteroNoteMarkdown.ts";

const one = (html: string) => zoteroNotesMarkdown([{ itemKey: "NOTE2345", html }]);

describe("Zotero notes as Markdown", () => {
  it("keeps headings, links, lists, quotes, tables and code, and counts the images it leaves out", () => {
    // The shapes Zotero's note editor writes (schema version 9), in one note.
    const note = one(
      [
        '<div data-schema-version="9">',
        "<h1>Aims</h1>",
        '<p>See <a href="https://example.org/a_b">the <strong>errata</strong></a> and <em>ch. 2</em>,',
        ' <span style="color: rgb(255, 0, 0)">in red</span>, <s>dropped</s>, <code>p &lt; .05</code>.</p>',
        "<ul><li><p>one</p><ol><li><p>inner</p></li></ol></li><li><p>two<br>second line</p></li></ul>",
        '<ol start="3"><li>third</li></ol>',
        "<blockquote><p>Quoted line</p><p>and another</p></blockquote>",
        "<table><tbody><tr><th><p>Group</p></th><th><p>n</p></th></tr>",
        "<tr><td><p>A | B</p></td><td><p>12</p></td></tr></tbody></table>",
        '<pre>x = 1\nprint("```")</pre>',
        '<p><span class="citation" data-citation="%7B%7D">(<span class="citation-item">Smith, 2020</span>)</span>',
        ' <img data-attachment-key="IMGA2345" width="10"> <span class="math">$a_i^2$</span></p>',
        '<pre class="math">$$\\sum_i x_i$$</pre>',
        "<hr>",
        "</div>",
      ].join(""),
    );

    expect(note).toEqual({
      markdown: [
        "# Aims",
        "See [the **errata**](https://example.org/a_b) and *ch. 2*, in red, ~~dropped~~, `p < .05`.",
        "- one\n  1. inner\n- two\n  second line",
        "3. third",
        "> Quoted line\n>\n> and another",
        "| Group | n |\n| --- | --- |\n| A \\| B | 12 |",
        '````\nx = 1\nprint("```")\n````',
        "(Smith, 2020) $a_i^2$",
        "$$\\sum_i x_i$$",
        "---",
      ].join("\n\n"),
      images: 1,
      cut: false,
    });
  });

  it("keeps what a person typed as text, not as Markdown", () => {
    expect(
      one(
        "<p># not a heading</p><p>1. not a list</p><p>- nor this</p><p>&gt; nor a quote</p>" +
          "<p>2 * 3 * 4, snake_case, [x], a &lt;b&gt;, $5 and &amp;amp;</p><p>https://example.org/a_b</p>" +
          '<p><a href="https://example.org/a_b">https://example.org/a_b</a></p>',
      ).markdown,
    ).toBe(
      [
        "\\# not a heading",
        "1\\. not a list",
        "\\- nor this",
        "\\> nor a quote",
        "2 \\* 3 \\* 4, snake\\_case, \\[x\\], a \\<b>, \\$5 and \\&amp;",
        "<https://example.org/a_b>",
        "<https://example.org/a_b>",
      ].join("\n\n"),
    );
  });

  it("puts several notes under their first lines, in the order Zotero lists them", () => {
    const notes = zoteroNotesMarkdown([
      { itemKey: "NOTE9999", html: "<p>summary<br>Read twice.</p><p>Then again.</p>" },
      { itemKey: "NOTE2345", html: "<h2>Methods</h2><p>Small sample.</p>" },
      { itemKey: "NOTE5555", html: "<ul><li>Critique</li><li>weak controls</li></ul>" },
      { itemKey: "NOTE7777", html: "<p></p>" },
    ]);

    expect(notes.markdown).toBe(
      [
        "## Critique",
        "- Critique\n- weak controls",
        "## Methods",
        "Small sample.",
        "## summary",
        "Read twice.",
        "Then again.",
      ].join("\n\n"),
    );
  });

  it("cuts a note that is too long at a block, and says so", () => {
    const paragraph = `<p>${"word ".repeat(8_000).trim()}</p>`;
    const long = one(`<p>Kept.</p>${paragraph}${paragraph}${paragraph}<p>Not kept.</p>`);

    expect(long.cut).toBe(true);
    expect(long.markdown?.length).toBeLessThanOrEqual(ZOTERO_NOTE_CHARACTERS);
    expect(long.markdown?.startsWith("Kept.\n\nword word")).toBe(true);
    // Two whole paragraphs fit; the third is left out whole, not cut in a word.
    expect(long.markdown?.split("\n\n")).toHaveLength(3);
  });
});
