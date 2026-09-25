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

  it("bounds pathological dependency fan-out and reports an incomplete graph", () => {
    const parsed = parseLatexDependencyDirectives(String.raw`\input{chapter}`.repeat(10_001));

    expect(parsed.directives).toHaveLength(10_000);
    expect([...parsed.incompleteReasons]).toContain("scan-limit");
  });

  it("marks unsupported import-package inclusion commands incomplete", () => {
    const parsed = parseLatexDependencyDirectives(String.raw`\inputfrom{chapters}{results}`);
    expect(parsed.directives).toEqual([]);
    expect([...parsed.incompleteReasons]).toContain("unsupported-command");
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

  it("follows nested import directories from their declared import base", async () => {
    const root = await workspace({
      "paper/main.tex": String.raw`\documentclass{article}\begin{document}\import{chapters}{index}\end{document}`,
      "paper/chapters/index.tex": String.raw`\subimport{results}{final}`,
      "paper/chapters/results/final.tex": "Final results.",
    });

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "paper/chapters/results/final.tex",
    });

    expect(result).toMatchObject({
      _tag: "resolved",
      rootRelativePath: "paper/main.tex",
      reason: "static-dependency",
      complete: true,
    });
  });

  it("deduplicates repeated static inputs while traversing a document graph", async () => {
    const repeatedInputs = String.raw`\input{chapter}`.repeat(5_000);
    const root = await workspace({
      "main.tex": `\\documentclass{article}${repeatedInputs}`,
      "chapter.tex": "Chapter text.",
    });

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "chapter.tex",
    });

    expect(result).toMatchObject({
      _tag: "resolved",
      rootRelativePath: "main.tex",
      reason: "static-dependency",
      complete: true,
    });
  });

  it("bounds total graph traversal across a document with many repeated dependencies", async () => {
    const repeatedInputs = String.raw`\input{missing}`.repeat(10_000);
    const helpers = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`helper-${index}.tex`, repeatedInputs]),
    );
    const helperReferences = Array.from(
      { length: 11 },
      (_, index) => `\\input{helper-${index}}`,
    ).join("");
    const root = await workspace({
      "main.tex": `\\documentclass{article}\\input{chapter}${helperReferences}`,
      "chapter.tex": "Chapter text.",
      ...helpers,
    });

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "chapter.tex",
    });

    expect(result).toMatchObject({ _tag: "unresolved", complete: false });
    expect(result.incompleteReasons).toContain("scan-limit");
  });

  it("rejects absolute and workspace-escaping source paths", async () => {
    const root = await workspace({
      "main.tex": String.raw`\documentclass{article}\begin{document}\end{document}`,
    });

    await expect(
      resolveLatexDocument({ workspaceRoot: root, sourceRelativePath: "../outside.tex" }),
    ).rejects.toThrow("stay inside the workspace");
    await expect(
      resolveLatexDocument({
        workspaceRoot: root,
        sourceRelativePath: NodePath.join(root, "main.tex"),
      }),
    ).rejects.toThrow("must be relative");
  });

  it("does not read a requested source through a symlinked parent directory", async () => {
    const root = await workspace({
      "real/main.tex": String.raw`\documentclass{article}\input{chapter}`,
      "real/chapter.tex": "Chapter text.",
    });
    await NodeFSP.symlink("real", NodePath.join(root, "alias"));

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "alias/chapter.tex",
    });

    expect(result).toMatchObject({ _tag: "unresolved", complete: false });
    expect(result.incompleteReasons).toContain("unreadable-file");
  });

  it("honors and carries an explicit root outside the bounded source index", async () => {
    const root = await workspace({
      "main.tex": String.raw`\documentclass{article}\begin{document}`.padEnd(1_048_577, " "),
      "chapters/chapter.tex": "% !TEX root = ../main.tex\n\\section{Chapter}",
    });

    const byMagicComment = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "chapters/chapter.tex",
    });
    expect(byMagicComment).toMatchObject({
      _tag: "resolved",
      rootRelativePath: "main.tex",
      reason: "magic-comment",
      complete: false,
    });
    expect(byMagicComment.incompleteReasons).toContain("file-too-large");

    const carried = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "chapters/chapter.tex",
      contextRootRelativePath: "main.tex",
    });
    expect(carried).toMatchObject({
      _tag: "resolved",
      rootRelativePath: "main.tex",
      reason: "context",
      complete: false,
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

    const explicitlySelected = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "known.tex",
      contextRootRelativePath: "main.tex",
    });
    expect(explicitlySelected).toMatchObject({
      _tag: "resolved",
      rootRelativePath: "main.tex",
      reason: "context",
      complete: false,
    });
  });

  it("still reports later dynamic inputs after finding a static source", async () => {
    const root = await workspace({
      "main.tex": String.raw`\documentclass{article}\begin{document}\input{known}\input{\dynamicName}\end{document}`,
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

  it("does not claim a complete graph when a dependency escapes the workspace", async () => {
    const root = await workspace({
      "main.tex": String.raw`\documentclass{article}\begin{document}\input{known}\input{../../external}\end{document}`,
      "known.tex": "Known text.",
    });

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "known.tex",
    });

    expect(result).toMatchObject({ _tag: "unresolved", complete: false });
    expect(result.incompleteReasons).toContain("unsupported-command");
  });

  it("does not auto-select a root when a dependency crosses a skipped symlink", async () => {
    const root = await workspace({
      "main.tex": String.raw`\documentclass{article}\begin{document}\input{chapter}\input{alias}\end{document}`,
      "chapter.tex": "Chapter.",
      "linked-source.tex": "Linked source.",
    });
    await NodeFSP.symlink("linked-source.tex", NodePath.join(root, "alias.tex"));

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "chapter.tex",
    });

    expect(result).toMatchObject({ _tag: "unresolved", complete: false });
    expect(result.incompleteReasons).toContain("unreadable-file");
  });

  it("does not let an unrelated dynamic fragment make a known document ambiguous", async () => {
    const root = await workspace({
      "main.tex": String.raw`\documentclass{article}\input{known}`,
      "known.tex": "Known text.",
      "unrelated.tex": String.raw`\input{sections/\dynamicName}`,
    });

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "known.tex",
    });

    expect(result).toMatchObject({
      _tag: "resolved",
      rootRelativePath: "main.tex",
      complete: true,
    });
  });

  it("keeps a requested source resolvable under a large project scan", async () => {
    const root = await workspace({
      "paper/main.tex": String.raw`\documentclass{article}\begin{document}\input{chapters/result}\end{document}`,
      "paper/chapters/result.tex": "Result text.",
    });
    const generated = NodePath.join(root, "generated");
    await NodeFSP.mkdir(generated, { recursive: true });
    for (let batch = 0; batch < 12; batch += 1) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) => {
          const index = batch * 100 + offset;
          return NodeFSP.writeFile(NodePath.join(generated, `noise-${index}.tex`), "Notes.");
        }),
      );
    }

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "paper/chapters/result.tex",
    });

    expect(result).toMatchObject({
      _tag: "resolved",
      rootRelativePath: "paper/main.tex",
      complete: true,
    });
  });

  it("does not auto-select a root when the bounded file index is exhausted", async () => {
    const root = await workspace({
      "main.tex": String.raw`\documentclass{article}\begin{document}\input{chapter}\end{document}`,
      "chapter.tex": "Chapter.",
    });
    for (let batch = 0; batch < 21; batch += 1) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) => {
          const index = batch * 100 + offset;
          return NodeFSP.writeFile(NodePath.join(root, `noise-${index}.tex`), "Notes.");
        }),
      );
    }

    const result = await resolveLatexDocument({
      workspaceRoot: root,
      sourceRelativePath: "chapter.tex",
    });

    expect(result).toMatchObject({ _tag: "unresolved", complete: false });
    expect(result.incompleteReasons).toContain("scan-limit");
    expect(result._tag).not.toBe("resolved");
  });
});
