// @effect-diagnostics nodeBuiltinImport:off -- Temporary workspaces exercise the Node index directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { parseLatexDependencyDirectives, resolveLatexDocument } from "./LatexProjectIndex.ts";

const workspaces: string[] = [];

async function workspace(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-latex-index-"));
  workspaces.push(root);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const absolutePath = NodePath.join(root, relativePath);
      await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
      await NodeFSP.writeFile(absolutePath, contents);
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

describe("parseLatexDependencyDirectives", () => {
  it("ignores comments and literal environments while retaining executable inputs", () => {
    const parsed = parseLatexDependencyDirectives(String.raw`
      % \input{ignored-comment}
      \begin{verbatim}
      \input{ignored-verbatim}
      \end{verbatim}
      \input{sections/intro}
    `);

    expect(parsed.directives).toEqual([
      { command: "input", directory: null, target: "sections/intro" },
    ]);
    expect([...parsed.incompleteReasons]).toEqual([]);
  });

  it("marks a macro-computed input incomplete", () => {
    const parsed = parseLatexDependencyDirectives(String.raw`\input{sections/\chosenSection}`);
    expect(parsed.directives).toEqual([]);
    expect([...parsed.incompleteReasons]).toContain("dynamic-input");
  });
});

describe("resolveLatexDocument", () => {
  it("resolves an AAA-NATI-shaped included section to its unique main document", async () => {
    const root = await workspace({
      "main.tex": String.raw`\documentclass{article}
        \newcommand{\projectName}{Example}
        \begin{document}
        \input{sections/introduction}
        % \input{sections/appendix}
        \end{document}`,
      "sections/introduction.tex": "Introduction text.",
      "sections/appendix.tex": "Appendix text.",
    });

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "sections/introduction.tex",
    });

    expect(result).toMatchObject({
      _tag: "resolved",
      sourceRelativePath: "sections/introduction.tex",
      rootRelativePath: "main.tex",
      reason: "static-dependency",
      complete: true,
    });
    expect(result.candidates).toEqual([
      {
        rootRelativePath: "main.tex",
        evidence: ["static-dependency"],
        independentlyCompilable: true,
      },
    ]);

    const commented = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "sections/appendix.tex",
    });
    expect(commented._tag).toBe("unresolved");
  });

  it("recognizes a main document whose document class lives in an included preamble", async () => {
    const root = await workspace({
      "main.tex": String.raw`\input{preamble}\begin{document}\input{section}\end{document}`,
      "preamble.tex": String.raw`\documentclass{article}`,
      "section.tex": "Body text.",
    });

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "section.tex",
    });

    expect(result).toMatchObject({
      _tag: "resolved",
      rootRelativePath: "main.tex",
      reason: "static-dependency",
    });
  });

  it("returns every plausible root for a shared fragment instead of guessing", async () => {
    const root = await workspace({
      "paper-a.tex": String.raw`\documentclass{article}\input{shared}`,
      "paper-b.tex": String.raw`\documentclass{report}\input{shared}`,
      "shared.tex": "Shared text.",
    });

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "shared.tex",
    });

    expect(result._tag).toBe("ambiguous");
    expect(result.candidates.map((candidate) => candidate.rootRelativePath)).toEqual([
      "paper-a.tex",
      "paper-b.tex",
    ]);
  });

  it("keeps carried document context when the included file is independently compilable", async () => {
    const root = await workspace({
      "main.tex": String.raw`\documentclass{article}\input{chapter}`,
      "chapter.tex": String.raw`\documentclass{article}\begin{document}Chapter\end{document}`,
    });

    const direct = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "chapter.tex",
    });
    expect(direct).toMatchObject({
      _tag: "resolved",
      rootRelativePath: "chapter.tex",
      reason: "self-document",
    });

    const carried = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "chapter.tex",
      contextRootRelativePath: "main.tex",
    });
    expect(carried).toMatchObject({
      _tag: "resolved",
      rootRelativePath: "main.tex",
      reason: "context",
    });
  });

  it("does not infer a sole static parent when dependency discovery is incomplete", async () => {
    const root = await workspace({
      "main.tex": String.raw`\documentclass{article}\input{known}\input{\dynamicName}`,
      "known.tex": "Known text.",
    });

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "known.tex",
    });

    expect(result).toMatchObject({ _tag: "unresolved", complete: false });
    expect(result.incompleteReasons).toContain("dynamic-input");
    expect(result.candidates.map((candidate) => candidate.rootRelativePath)).toEqual(["main.tex"]);
  });
});
