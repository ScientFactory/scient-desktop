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
});
