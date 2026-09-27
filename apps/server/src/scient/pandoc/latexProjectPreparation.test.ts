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

  it.live("replaces escaped, missing and cyclic includes without reading outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "scient-latex-word-" });
      const project = NodePath.join(workspace, "paper");
      NodeFS.mkdirSync(project);
      NodeFS.writeFileSync(NodePath.join(workspace, "secret.tex"), "SECRET OUTSIDE");
      NodeFS.writeFileSync(
        NodePath.join(project, "main.tex"),
        "\\begin{document}\\input{../secret}\\input{missing}\\input{main}\\includegraphics{../secret}\\bibliography{../secret}\\end{document}",
      );
      const prepared = yield* prepareLatexProject(NodePath.join(project, "main.tex"), workspace);
      expect(prepared.source).not.toContain("SECRET OUTSIDE");
      expect(prepared.source).toContain("[Unresolved include]");
      expect(prepared.source).toContain("[Figure unavailable]");
      expect(prepared.warnings.length).toBeGreaterThanOrEqual(4);
      expect(prepared.bibliography).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("rejects a symlinked include outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "scient-latex-word-" });
      const project = NodePath.join(workspace, "paper");
      NodeFS.mkdirSync(project);
      NodeFS.writeFileSync(NodePath.join(workspace, "secret.tex"), "PRIVATE TEXT");
      try {
        NodeFS.symlinkSync(
          NodePath.join(workspace, "secret.tex"),
          NodePath.join(project, "linked.tex"),
        );
      } catch {
        return;
      }
      NodeFS.writeFileSync(NodePath.join(project, "main.tex"), "\\input{linked}");
      const prepared = yield* prepareLatexProject(NodePath.join(project, "main.tex"), workspace);
      expect(prepared.source).not.toContain("PRIVATE TEXT");
      expect(prepared.source).toContain("[Unresolved include]");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
