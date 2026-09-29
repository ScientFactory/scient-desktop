import { describe, expect, it } from "@effect/vitest";

import { bodyIsContained, readMessageBody, writeMessageBody } from "./messageBody.ts";

const OPTIONS = { namespace: "m3-", preserveLineBreaks: false, rawHtml: "render" } as const;

describe("message bodies", () => {
  it("closes blocks left open so a following marker stays top level", () => {
    for (const body of [
      "```\ncode",
      "<!-- open",
      "<style>\na {}",
      "<?php",
      "<![CDATA[ x",
      "<!DOCTYPE",
    ]) {
      const written = writeMessageBody(body, OPTIONS);
      expect(written.containedAsLiteral).toBe(false);
      expect(bodyIsContained(written.markdown)).toBe(true);
    }
  });

  it("escapes marker text outside code only", () => {
    const written = writeMessageBody("<!-- scient:message x -->\n\n`<!-- scient:inline`", OPTIONS);
    expect(written.markdown).toBe("&lt;!-- scient:message x -->\n\n`<!-- scient:inline`");
  });

  it("handles many user-authored marker lookalikes without changing their text", () => {
    const count = 512;
    const body = Array.from(
      { length: count },
      (_, index) => `<!-- scient:message ${index} -->`,
    ).join("\n\n");
    const written = writeMessageBody(body, { ...OPTIONS, rawHtml: "literal" });
    expect(written.containedAsLiteral).toBe(false);
    expect(written.markdown.match(/&lt;!-- scient:message/g)?.length).toBe(count);
    expect(written.markdown).toContain(`&lt;!-- scient:message ${count - 1} -->`);
  });

  it("reverses only the namespace when reading", () => {
    const body = "[a][ref] and [^n]\n\n[ref]: https://example.org\n\n[^n]: note";
    const written = writeMessageBody(body, OPTIONS).markdown;
    expect(written).toBe(
      "[a][m3-ref] and [^m3-n]\n\n[m3-ref]: https://example.org\n\n[^m3-n]: note",
    );
    expect(readMessageBody(written, "m3-")).toBe(body);
  });

  it("is deterministic", () => {
    const body = "line\nbreak <b>x</b> [s]\n\n[s]: /x";
    const options = { ...OPTIONS, preserveLineBreaks: true, rawHtml: "literal" } as const;
    expect(writeMessageBody(body, options)).toEqual(writeMessageBody(body, options));
  });

  it("namespaces quoted and unquoted anchors and the HTML links that target them", () => {
    const body = [
      "<a id=\"top\"></a><a name='mid'></a><a id=end></a>",
      "",
      '<p><a href="#top">up</a> <a href=\'#mid\'>mid</a> <a href=#end>down</a> <a href="#other">x</a></p>',
    ].join("\n");
    const written = writeMessageBody(body, OPTIONS).markdown;
    expect(written).toBe(
      [
        "<a id=\"m3-top\"></a><a name='m3-mid'></a><a id=m3-end></a>",
        "",
        '<p><a href="#m3-top">up</a> <a href=\'#m3-mid\'>mid</a> <a href=#m3-end>down</a> <a href="#other">x</a></p>',
      ].join("\n"),
    );
    expect(readMessageBody(written, "m3-")).toBe(body);
  });
});
