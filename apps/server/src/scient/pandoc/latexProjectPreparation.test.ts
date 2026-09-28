// @effect-diagnostics nodeBuiltinImport:off -- Synthetic project fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { prepareLatexProject } from "./latexProjectPreparation.ts";

describe("LaTeX project preparation", () => {
  it.live(
    "resolves nested includes, bibliography and graphicspath without interpreting comments or verbatim",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "scient-latex-word-" });
        const project = NodePath.join(workspace, "paper");
        NodeFS.mkdirSync(NodePath.join(project, "chapters"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(project, "figures"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(project, "main.tex"),
          [
            "\\documentclass{article}",
            "\\usepackage{graphicx}",
            "\\graphicspath{{figures/}}",
            "\\begin{document}",
            "% \\input{secret}",
            "\\newcommand{\\hidden}{\\input{secret}}",
            "\\begin{verbatim}\\input{secret}\\end{verbatim}",
            "\\input{chapters/one}",
            "\\subfile{chapters/sub}",
            "\\includegraphics{plot}",
            "\\bibliography{refs}",
            "\\end{document}",
          ].join("\n"),
        );
        NodeFS.writeFileSync(
          NodePath.join(project, "chapters", "one.tex"),
          "\\section{First}\\input{chapters/two}",
        );
        NodeFS.writeFileSync(NodePath.join(project, "chapters", "two.tex"), "Nested text.");
        NodeFS.writeFileSync(
          NodePath.join(project, "chapters", "sub.tex"),
          "\\documentclass{article}\\begin{document}Subfile body.\\end{document}",
        );
        NodeFS.writeFileSync(NodePath.join(project, "refs.bib"), "@article{test, title={Local}}\n");
        NodeFS.writeFileSync(
          NodePath.join(project, "figures", "plot.png"),
          Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        );
        const prepared = yield* prepareLatexProject(NodePath.join(project, "main.tex"), workspace);
        expect(prepared.source).toContain("Nested text.");
        expect(prepared.source).toContain("Subfile body.");
        expect(prepared.source.match(/\\documentclass/gu)).toHaveLength(1);
        expect(prepared.source).toContain("% \\input{secret}");
        expect(prepared.source).toContain("\\newcommand{\\hidden}{\\input{secret}}");
        expect(prepared.source).toContain("\\begin{verbatim}\\input{secret}");
        expect(prepared.source).toContain("{figures/plot.png}");
        expect(prepared.source).not.toContain("\\bibliography{refs}");
        expect(prepared.bibliography[0]?.contents).toContain("@article{test");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("resolves includes, figures and bibliographies elsewhere in the same project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "scient-latex-word-" });
      const paper = NodePath.join(workspace, "paper");
      NodeFS.mkdirSync(paper);
      NodeFS.mkdirSync(NodePath.join(workspace, "shared"));
      NodeFS.mkdirSync(NodePath.join(workspace, "figures"));
      NodeFS.writeFileSync(NodePath.join(workspace, "shared", "methods.tex"), "Shared methods.");
      NodeFS.writeFileSync(
        NodePath.join(workspace, "figures", "plot.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
      NodeFS.writeFileSync(NodePath.join(workspace, "refs.bib"), "@article{shared, title={S}}\n");
      NodeFS.writeFileSync(
        NodePath.join(paper, "main.tex"),
        [
          "\\graphicspath{{../figures/}}",
          "\\input{../shared/methods}",
          "\\includegraphics{plot}",
          "\\bibliography{../refs}",
        ].join("\n"),
      );
      const prepared = yield* prepareLatexProject(NodePath.join(paper, "main.tex"), workspace);
      expect(prepared.source).toContain("Shared methods.");
      expect(prepared.source).toContain("{../figures/plot.png}");
      expect(prepared.imageReferences).toEqual(["../figures/plot.png"]);
      expect(prepared.bibliography[0]?.contents).toContain("@article{shared");
      expect(prepared.baseDirectory).toBe(paper);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("replaces escaped, missing and cyclic includes without reading outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-latex-word-" });
      const workspace = NodePath.join(directory, "project");
      const project = NodePath.join(workspace, "paper");
      NodeFS.mkdirSync(project, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(directory, "secret.tex"), "SECRET OUTSIDE");
      NodeFS.writeFileSync(
        NodePath.join(project, "main.tex"),
        "\\begin{document}\\input{../../secret}\\input{missing}\\input{main}\\includegraphics{../../secret}\\bibliography{../../secret}\\end{document}",
      );
      const prepared = yield* prepareLatexProject(NodePath.join(project, "main.tex"), workspace);
      expect(prepared.source).not.toContain("SECRET OUTSIDE");
      expect(prepared.source).toContain("[Include outside the project folder]");
      expect(prepared.source).toContain("[Unresolved include]");
      expect(prepared.source).toContain("[Figure outside the project folder]");
      const notes = prepared.warnings.map((warning) => warning.message);
      expect(notes).toContain(
        "A LaTeX include outside the project folder was left out; a placeholder was inserted.",
      );
      expect(notes).toContain("A bibliography outside the project folder was omitted.");
      expect(notes).toContain("A LaTeX include exceeded the depth, file-count, or cycle limit.");
      expect(prepared.bibliography).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("rejects a symlinked include outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-latex-word-" });
      const workspace = NodePath.join(directory, "project");
      const project = NodePath.join(workspace, "paper");
      NodeFS.mkdirSync(project, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(directory, "secret.tex"), "PRIVATE TEXT");
      try {
        NodeFS.symlinkSync(
          NodePath.join(directory, "secret.tex"),
          NodePath.join(project, "linked.tex"),
        );
      } catch {
        return;
      }
      NodeFS.writeFileSync(NodePath.join(project, "main.tex"), "\\input{linked}");
      const prepared = yield* prepareLatexProject(NodePath.join(project, "main.tex"), workspace);
      expect(prepared.source).not.toContain("PRIVATE TEXT");
      expect(prepared.source).toContain("[Include outside the project folder]");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
