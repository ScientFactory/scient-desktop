import { describe, expect, it } from "vite-plus/test";
import { sourceExcerptCopy } from "./sourceExcerptCopy";

describe("short excerpt attribution", () => {
  const source = {
    title: "A useful paper",
    issuedYear: 2025,
    url: null,
    identifiers: [{ scheme: "doi", value: "10.1234/paper" }],
    creators: [{ creatorType: "author", givenName: "A", familyName: "Omar", literalName: null }],
  };
  it("copies a linked short attribution, not an invented numbered reference", () => {
    const result = sourceExcerptCopy(source, [{ page: 2, quote: "Exact words" }]);
    expect(result.markdown).toBe(
      "> Exact words\n\n[Omar · A useful paper (2025)](<https://doi.org/10.1234/paper>) · PDF page 2",
    );
    expect(result.html).toContain('<a href="https://doi.org/10.1234/paper">');
  });
  it("omits missing metadata and unsafe URLs without inventing a link", () => {
    const result = sourceExcerptCopy(
      { ...source, identifiers: [], url: "javascript:alert(1)", creators: [], issuedYear: null },
      [{ page: 1, quote: "Text" }],
    );
    expect(result.markdown).toBe("> Text\n\nA useful paper · PDF page 1");
    expect(result.html).not.toContain("<a");
  });
  it("escapes source text and metadata in rich HTML", () => {
    const result = sourceExcerptCopy({ ...source, title: '<img src=x onerror="alert(1)">' }, [
      { page: 1, quote: "<script>alert(1)</script>" },
    ]);
    expect(result.html).not.toContain("<script>");
    expect(result.html).not.toContain("<img");
    expect(result.html).toContain("&lt;script&gt;");
  });
});
