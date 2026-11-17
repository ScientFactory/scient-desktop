import { describe, expect, it } from "@effect/vitest";

import { renameCitationKeyInDocument } from "./citationKeyRename.ts";

describe("citation key rename in documents", () => {
  it("renames Markdown citations in prose and leaves e-mail, longer keys and code alone", () => {
    const text = [
      "As [@old; -@old, p. 3] and @old said, unlike @older or [@old.x].",
      "Mail old@old.org. Inline `[@old]` stays.",
      "```",
      "[@old]",
      "```",
      "End [see @old].",
      "",
    ].join("\n");
    expect(renameCitationKeyInDocument("markdown", text, "old", "new")).toBe(
      [
        "As [@new; -@new, p. 3] and @new said, unlike @older or [@old.x].",
        "Mail old@old.org. Inline `[@old]` stays.",
        "```",
        "[@old]",
        "```",
        "End [see @new].",
        "",
      ].join("\n"),
    );
  });

  // regression: renames once rewrote code, URLs and verbatim examples.
  it.each([
    { kind: "markdown", text: "Intro.\r\n\r\n    [@old]\r\n" },
    { kind: "markdown", text: "Use `a\n@old\nb` here.\n" },
    { kind: "markdown", text: "See <https://example.test/a;@old>.\n" },
    { kind: "markdown", text: "See https://example.test/a;@old today.\n" },
    { kind: "latex", text: "\\begin{verbatim}\n\\cite{old}\n\\end{verbatim}\n" },
    { kind: "latex", text: "% \\cite{old}\nText.\n" },
  ] as const)("keeps $kind code and links as written: $text", ({ kind, text }) => {
    expect(renameCitationKeyInDocument(kind, text, "old", "new")).toBe(text);
  });

  it("renames keys inside LaTeX cite commands only", () => {
    expect(
      renameCitationKeyInDocument(
        "latex",
        "See \\citep[p.~2]{a, old,b} and \\textcite{old}; \\label{old} and \\cite{older}.\r\n",
        "old",
        "new",
      ),
    ).toBe("See \\citep[p.~2]{a, new,b} and \\textcite{new}; \\label{old} and \\cite{older}.\r\n");
  });

  // regression: a comment between a command and its arguments hid the citation from a rename.
  it.each([
    {
      text: "See \\cite % old formatting\n  {old}.\n",
      renamed: "See \\cite % old formatting\n  {new}.\n",
    },
    {
      text: "See \\citep[see] % old page\n[p.~4]{old}.\n",
      renamed: "See \\citep[see] % old page\n[p.~4]{new}.\n",
    },
    {
      text: "See \\cite{a, % old}, c\n old,b}.\r\n",
      renamed: "See \\cite{a, % old}, c\n new,b}.\r\n",
    },
  ])(
    "renames LaTeX keys across comments and leaves the comments as written: %j",
    ({ text, renamed }) => {
      expect(renameCitationKeyInDocument("latex", text, "old", "new")).toBe(renamed);
    },
  );
});
