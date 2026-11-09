import { toHtml } from "hast-util-to-html";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";
import {
  DOCUMENT_FONT_SANITIZE_ATTRIBUTES,
  documentFontOfMarkdown,
  rehypeApplyFontSpans,
  rehypeMarkFontSpans,
} from "./documentFont";

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ...DOCUMENT_FONT_SANITIZE_ATTRIBUTES.span],
  },
};

async function exported(markdown: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeMarkFontSpans)
    .use(rehypeSanitize, schema)
    .use(rehypeApplyFontSpans);
  const tree = await processor.run(processor.parse(markdown));
  return toHtml(tree);
}

describe("export of local font styles", () => {
  it("keeps the exact size and family styles through the sanitizer", async () => {
    expect(await exported('a <span style="font-size:1.2em">big</span> b')).toContain(
      '<span style="font-size:1.2em">big</span>',
    );
    expect(await exported('<span style="font-family:serif">x</span>')).toContain(
      'style="font-family:serif,',
    );
  });

  it.each([
    '<span style="color:red">x</span>',
    '<span style="font-size:3em">x</span>',
    '<span style="font-size:1.2em;color:red">x</span>',
    '<span style="font-family:Arial">x</span>',
  ])("removes any other style: %s", async (markdown) => {
    const html = await exported(markdown);
    expect(html).not.toContain("color");
    expect(html).not.toContain("Arial");
    expect(html).not.toContain("3em");
    expect(html).toContain(">x</span>");
  });

  it("ignores a font data attribute written directly in the document", async () => {
    const html = await exported('<span data-scient-font-size="huge">x</span>');
    expect(html).not.toContain("style=");
    expect(html).not.toContain("data-scient-font-size");
  });

  it("reads the whole-document keys of a leading front matter only", () => {
    expect(
      documentFontOfMarkdown("---\ntitle: T\nfont-size: 12pt\nfont-family: monospace\n---\n\ntext"),
    ).toEqual({ fontFamily: "monospace", fontSize: "12pt" });
    expect(documentFontOfMarkdown("text\n\n---\nfont-size: 12pt\n---\n")).toEqual({
      fontFamily: null,
      fontSize: null,
    });
  });
});
