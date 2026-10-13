import { describe, expect, it } from "vite-plus/test";
import { nativeMarkdownProjection, parseMarkdownDocument } from "./markdownDocument";

describe("native Markdown source projection", () => {
  it("keeps repeated URLs and identical labels in separate canonical occurrences", () => {
    const markdown = "😀 [**details**](</repo/a.ts>) then [*details*](/repo/a.ts)";
    expect(nativeMarkdownProjection(markdown)).toEqual({
      markdown,
      recognizedLinkTextByUrl: {},
      linkSources: [
        { url: "/repo/a.ts", source: "[**details**](</repo/a.ts>)" },
        { url: "/repo/a.ts", source: "[*details*](/repo/a.ts)" },
      ],
    });
  });

  it.each([
    "*details*",
    "~~details~~",
    "`` `details` ``",
    "`  details  `",
    "\\[details\\] \\*literal\\*",
    "first\nsecond",
    "first  \nsecond",
    "![details](<https://example.com/icon.png>)",
  ])("retains descriptive label markup in canonical selected Copy: %s", (label) => {
    const source = `[see ${label}](</repo/a.ts>)`;
    expect(nativeMarkdownProjection(source).linkSources).toEqual([{ url: "/repo/a.ts", source }]);
  });

  it("retains non-file links in the index and resolves reference destinations for portable Copy", () => {
    const projection = nativeMarkdownProjection(
      "<https://example.com> [**details**][file]\n\n[file]: /repo/a.ts",
    );
    expect(projection.linkSources).toEqual([
      { url: "https://example.com", source: null },
      { url: "/repo/a.ts", source: "[**details**](</repo/a.ts>)" },
    ]);
  });

  it("keeps file mentions actionable without consuming punctuation or package references", () => {
    const projection = nativeMarkdownProjection(
      "Inspect @src/Checkout.tsx. Use @t3tools/contracts.",
    );
    expect(projection.markdown).toBe(
      "Inspect [Checkout.tsx](<src/Checkout.tsx>). Use @t3tools/contracts.",
    );
    expect(projection.linkSources).toEqual([
      { url: "src/Checkout.tsx", source: "@src/Checkout.tsx" },
    ]);
    expect(nativeMarkdownProjection('Open @"src/My Checkout.tsx" now').linkSources).toEqual([
      { url: "src/My Checkout.tsx", source: '@"src/My Checkout.tsx"' },
    ]);
  });

  it("leaves code and existing link labels literal while preserving quoted mentions", () => {
    const source =
      "`@src/Checkout.tsx`\n\n```text\n@src/Checkout.tsx\n```\n\n[Inspect @src/Checkout.tsx](https://example.com)\n\n> Inspect @src/Checkout.tsx.";
    const projection = nativeMarkdownProjection(source);
    expect(projection.markdown).toContain("`@src/Checkout.tsx`");
    expect(projection.markdown).toContain("```text\n@src/Checkout.tsx\n```");
    expect(projection.markdown).toContain("[Inspect @src/Checkout.tsx](https://example.com)");
    expect(projection.markdown).toContain("> Inspect [Checkout.tsx](<src/Checkout.tsx>).");
    expect(projection.linkSources).toEqual([
      { url: "https://example.com", source: null },
      { url: "src/Checkout.tsx", source: "@src/Checkout.tsx" },
    ]);
  });

  it("preserves authored Windows destinations independently, including a colliding parsed path", () => {
    const first = String.raw`C:\Users\me\.t3\_build\shot.png`;
    const second = String.raw`C:\Users\me.t3_build\shot.png`;
    const source = `[first](${first}) [second](${second})\n\n\`${first}\``;
    const projection = nativeMarkdownProjection(source);
    expect(projection.linkSources).toEqual([
      { url: first, source: `[first](${first})` },
      { url: second, source: `[second](${second})` },
    ]);
    expect(projection.markdown).toBe(
      `[first](${first.replaceAll("\\", "\\\\")}) [second](${second.replaceAll("\\", "\\\\")})\n\n\`${first}\``,
    );
    expect(parseMarkdownDocument(source).children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "link", url: first }, {}, { type: "link", url: second }],
    });
  });

  it("preserves a Windows destination containing label delimiter characters", () => {
    const path = String.raw`C:\_dir\file](part).txt`;
    const source = `[file](<${path}>)`;
    const projection = nativeMarkdownProjection(source);
    expect(projection.linkSources).toEqual([{ url: path, source }]);
    expect(projection.markdown).toBe(`[file](<${path.replaceAll("\\", "\\\\")}>)`);
  });

  it("binds actual recognized file code spans for default and partial Copy", () => {
    const source =
      "`/tmp/frame.png` and `/tmp/frame.png`\n\n```text\n/tmp/example.png\n```\n\n`[example](/tmp/example.png)`";
    const projection = nativeMarkdownProjection(source);
    expect(projection.markdown).toBe(source);
    expect(projection.recognizedLinkTextByUrl).toEqual({
      "/tmp/frame.png": "[frame.png](</tmp/frame.png>)",
    });
    expect(projection.linkSources).toEqual([]);
  });

  it("preserves Windows image and definition destinations without rewriting URL/code examples", () => {
    const image = String.raw`C:\Users\me\.t3\shot.png`;
    const reference = String.raw`\\wsl.localhost\Ubuntu\.t3\ref.png`;
    const source = `![shot](${image} "Shot")\n\n![ref][ref]\n\n[ref]: ${reference}\n\n[site](https://example.com/a\\.b)\n\n\`![example](${image})\``;
    const projection = nativeMarkdownProjection(source);
    expect(projection.markdown).toContain(`![shot](${image.replaceAll("\\", "\\\\")} "Shot")`);
    expect(projection.markdown).toContain(`[ref]: ${reference.replaceAll("\\", "\\\\")}`);
    expect(projection.markdown).toContain("[site](https://example.com/a\\.b)");
    expect(projection.markdown).toContain(`\`![example](${image})\``);
  });

  it.each([
    ["&#128512;", "😀"],
    ["&#x1f680;", "🚀"],
    ["&#9999999999;", String.raw`\&\#9999999999\;`],
    ["&#x110000;", String.raw`\&\#x110000\;`],
    ["&amp;#9999999999;", String.raw`\&\#9999999999\;`],
    ["&amp;#x110000;", String.raw`\&\#x110000\;`],
    ["&amp;lt;", String.raw`\<`],
    ["&amp;gt;", String.raw`\>`],
    ["&alpha;", String.raw`\&alpha\;`],
    ["&amp;alpha;", String.raw`\&alpha\;`],
  ])("preserves retained native entity decoding without throwing: %s", (entity, literal) => {
    expect(nativeMarkdownProjection(`Before ${entity} after`).markdown).toBe(
      `Before ${literal} after`,
    );
  });

  it("keeps decoded entities literal while preserving code, destinations and canonical file source", () => {
    const source =
      "[&#42;details&#42;](</repo/a.ts>) &lt;https&#58;//example.com&gt;\n\n`&lt;`\n\n```text\n&#128512;\n```\n\n[site](https://example.com/?a=&amp;b)";
    const projection = nativeMarkdownProjection(source);
    expect(projection.markdown).toContain(
      String.raw`[\*details\*](</repo/a.ts>) \<https\://example.com\>`,
    );
    expect(projection.markdown).toContain("`&lt;`");
    expect(projection.markdown).toContain("```text\n&#128512;\n```");
    expect(projection.markdown).toContain(String.raw`[site](<https://example.com/?a=\&b>)`);
    expect(projection.linkSources[0]).toEqual({
      url: "/repo/a.ts",
      source: "[&#42;details&#42;](</repo/a.ts>)",
    });
    expect(projection.linkSources).toHaveLength(2);
    expect(nativeMarkdownProjection(String.raw`literal \&lt;`).markdown).toBe(
      String.raw`literal \&lt;`,
    );
  });

  it.each([
    ["/repo/a&amp;b.ts", "/repo/a&b.ts", String.raw`/repo/a\&b.ts`],
    ["/repo/a&amp;amp;b.ts", "/repo/a&amp;b.ts", String.raw`/repo/a\&amp;b.ts`],
  ])(
    "retains one decoded destination identity and its original canonical source: %s",
    (written, url, native) => {
      const source = `[details](${written} "Title &amp;")`;
      const projection = nativeMarkdownProjection(source);
      expect(projection.linkSources).toEqual([{ url, source }]);
      expect(projection.markdown).toBe(`[details](<${native}> "Title &amp;")`);
    },
  );

  it("normalizes parsed image and reference destinations without rewriting code, labels or titles", () => {
    const source =
      '![image](</repo/a&amp;b.png> "Image &amp;")\n\n[details][file]\n\n[file]: /repo/a&amp;amp;b.ts "File &amp;"\n\n`[example](/repo/a&amp;b.ts)`\n\n```text\n[example](/repo/a&amp;b.ts)\n```';
    const projection = nativeMarkdownProjection(source);
    expect(projection.markdown).toContain(String.raw`![image](</repo/a\&b.png> "Image &amp;")`);
    expect(projection.markdown).toContain(String.raw`[file]: </repo/a\&amp;b.ts> "File &amp;"`);
    expect(projection.markdown).toContain("`[example](/repo/a&amp;b.ts)`");
    expect(projection.markdown).toContain("```text\n[example](/repo/a&amp;b.ts)\n```");
    expect(projection.linkSources).toEqual([
      { url: "/repo/a&amp;b.ts", source: String.raw`[details](</repo/a\&amp;b.ts>)` },
    ]);
  });

  it("retains numeric whitespace inside the parsed link and does not truncate NUL-shaped text", () => {
    const source = "[line&#10;&#10;two&#x09;three&#13;four](/repo/a.ts) [next](/repo/b.ts)";
    const projection = nativeMarkdownProjection(source);
    expect(projection.markdown).toBe(
      "[line&#10;&#10;two&#9;three&#13;four](/repo/a.ts) [next](/repo/b.ts)",
    );
    expect(projection.linkSources).toEqual([
      { url: "/repo/a.ts", source: "[line&#10;&#10;two&#x09;three&#13;four](/repo/a.ts)" },
      { url: "/repo/b.ts", source: "[next](/repo/b.ts)" },
    ]);
    expect(nativeMarkdownProjection("before &#0; after").markdown).toBe(
      String.raw`before \&\#0\; after`,
    );
  });

  it.each([
    ["<https://example.com/?a=&amp;b>", "https://example.com/?a=&amp;b"],
    ["https://example.com/?a=&amp;b", "https://example.com/?a=&amp;b"],
    ["www.example.com/?a=&amp;b", "http://www.example.com/?a=&amp;b"],
    ["<file:///repo/a&amp;b.ts>", "file:///repo/a&amp;b.ts"],
  ])("separates entity text from an autolink's exact raw destination: %s", (source, url) => {
    const projection = nativeMarkdownProjection(`${source} [next](/repo/next.ts)`);
    expect(projection.linkSources.map((link) => link.url)).toEqual([url, "/repo/next.ts"]);
    expect(projection.markdown).toContain(`<${url.replace(/&/g, "\\&")}>`);
    expect(projection.markdown).toContain("[next](/repo/next.ts)");
    expect(parseMarkdownDocument(projection.markdown).children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "link", url }, {}, { type: "link", url: "/repo/next.ts" }],
    });
  });

  it("retains actual mail recognition instead of inventing an entity-decoded email identity", () => {
    const valid = "<x&y@example.com>";
    expect(nativeMarkdownProjection(valid).markdown).toBe(valid);
    expect(nativeMarkdownProjection(valid).linkSources).toEqual([
      { url: "mailto:x&y@example.com", source: null },
    ]);
    // The entity semicolon prevents a complete email autolink; GFM recognizes only this suffix.
    const encoded = nativeMarkdownProjection("<x&amp;y@example.com>");
    expect(encoded.linkSources).toEqual([{ url: "mailto:y@example.com", source: null }]);
    expect(parseMarkdownDocument(encoded.markdown).children[0]).toMatchObject({
      children: expect.arrayContaining([
        expect.objectContaining({ type: "link", url: "mailto:y@example.com" }),
      ]),
    });
  });

  it("normalizes GFM offset-free text gaps while protecting complete positioned subtrees", () => {
    const source =
      '&lt;https&#58;//example.com&gt; **&alpha;** [details](</repo/a&amp;amp;b.ts> "Title &amp;") `&alpha;` ![image](/repo/a&amp;b.png "Image &amp;") [reference][r]\n\n[r]: /repo/a&amp;b.md "Reference &amp;"';
    const projection = nativeMarkdownProjection(source);
    expect(projection.markdown).toContain(String.raw`\<https\://example.com\> **\&alpha\;**`);
    expect(projection.markdown).toContain(String.raw`[details](</repo/a\&amp;b.ts> "Title &amp;")`);
    expect(projection.markdown).toContain("`&alpha;`");
    expect(projection.markdown).toContain(String.raw`![image](</repo/a\&b.png> "Image &amp;")`);
    expect(projection.markdown).toContain(String.raw`[r]: </repo/a\&b.md> "Reference &amp;"`);
    expect(projection.linkSources).toEqual([
      { url: "/repo/a&amp;b.ts", source: '[details](</repo/a&amp;amp;b.ts> "Title &amp;")' },
      { url: "/repo/a&b.md", source: String.raw`[reference](</repo/a\&b.md>)` },
    ]);
  });
});
