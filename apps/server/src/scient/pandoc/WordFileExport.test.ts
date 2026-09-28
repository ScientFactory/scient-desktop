// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Builds a synthetic project and serializes its known test fixture.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as ConversationExportFiles from "../conversationExport/ConversationExportFiles.ts";
import {
  PandocWordConverter,
  WordConversionError,
  layer as realConverterLayer,
  type WordConversionFailureReason,
  type WordConversionInput,
} from "./PandocWordConverter.ts";
import { WordFileExport, layer as wordFileExportLayer } from "./WordFileExport.ts";
import { LATEX_UNVERIFIABLE_PLATFORM_MESSAGE } from "./latexProjectPreparation.ts";
import {
  managedToolLayer,
  pandocBinaryForTests,
  readDocx,
  PNG_BYTES,
  PNG_BYTES_ALT,
} from "./pandocTestSupport.ts";

const binary = pandocBinaryForTests();

const converterLayer = (
  seen: Array<WordConversionInput>,
  failure: WordConversionFailureReason | null = null,
  beforeConvert?: (input: WordConversionInput) => void,
) =>
  Layer.effect(
    PandocWordConverter,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return PandocWordConverter.of({
        availability: Effect.succeed({ available: true, reason: null, installable: false }),
        convert: (input) =>
          Effect.gen(function* () {
            beforeConvert?.(input);
            seen.push(input);
            if (failure !== null) {
              return yield* new WordConversionError({ reason: failure, message: "Word said no." });
            }
            yield* fileSystem.writeFileString(input.outputPath, "docx").pipe(Effect.orDie);
            return {
              byteLength: 4,
              warnings: [
                ...input.bundle.warnings,
                { code: "resource-unresolved", message: "Image “x” was not embedded." },
              ],
              summary: {
                embeddedImages: 0,
                placeholders: 1,
                workLogBlocks: 0,
                reasoningBlocks: 0,
                citedReferences: 0,
                rtlDocument: false,
                landscapeTables: 0,
              },
            };
          }),
      });
    }),
  );

const WorkspaceLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
);

const run = <A, E>(
  body: (input: {
    readonly service: WordFileExport["Service"];
    readonly project: string;
    readonly revisionOf: (relativePath: string) => Effect.Effect<string>;
  }) => Effect.Effect<A, E>,
  options: {
    readonly seen?: Array<WordConversionInput>;
    readonly failure?: WordConversionFailureReason;
    readonly realConverter?: boolean;
    readonly beforeConvert?: (input: WordConversionInput) => void;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-word-file-" });
    const project = NodePath.join(root, "project");
    NodeFS.mkdirSync(NodePath.join(project, "notes"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(project, "notes", "report.md"),
      "# Report\n\n![plot](plot.png)\n",
    );
    NodeFS.writeFileSync(NodePath.join(project, "notes", "data.csv"), "a,b\n");
    const words = options.realConverter
      ? realConverterLayer.pipe(
          Layer.provide(
            managedToolLayer({
              command: { command: binary!, leadingArgs: [] },
              scratchRoot: NodePath.join(root, "scratch"),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        )
      : converterLayer(options.seen ?? [], options.failure ?? null, options.beforeConvert);
    const layer = wordFileExportLayer.pipe(
      Layer.provide(ConversationExportFiles.layer),
      Layer.provide(words),
      Layer.provideMerge(WorkspaceLayer),
      Layer.provideMerge(ServerConfig.layerTest(project, NodePath.join(root, "base"))),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const service = yield* WordFileExport;
      const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const revisionOf = (relativePath: string) =>
        files.readFile({ cwd: project, relativePath }).pipe(
          Effect.map((read) => read.revision),
          Effect.orDie,
        );
      return yield* body({ service, project, revisionOf });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("WordFileExport", () => {
  it.live("sends captured Mermaid PNG bytes to the Word converter", () => {
    const seen: Array<WordConversionInput> = [];
    return run(
      ({ service, project, revisionOf }) =>
        Effect.gen(function* () {
          NodeFS.writeFileSync(
            NodePath.join(project, "notes", "report.md"),
            "```mermaid\nflowchart LR\n A --> B\n```\n",
          );
          const revision = yield* revisionOf("notes/report.md");
          const request = { cwd: project, relativePath: "notes/report.md", revision };
          const plan = yield* service.prepareDiagrams(request);
          yield* service.export({
            ...request,
            diagramCapture: {
              sourceDigest: plan.sourceDigest,
              diagrams: [
                {
                  id: plan.diagrams[0]!.id,
                  result: { _tag: "png", base64: Buffer.from(PNG_BYTES).toString("base64") },
                },
              ],
            },
          });
          expect(
            seen[0]?.bundle.assets.find((asset) => asset.role === "rendered-diagram")?.id,
          ).toBe(plan.diagrams[0]!.id);
        }),
      { seen },
    );
  });

  it.live(
    "prepares saved Mermaid source and rejects a changed file before accepting its capture",
    () =>
      run(({ service, project, revisionOf }) =>
        Effect.gen(function* () {
          const file = NodePath.join(project, "notes", "report.md");
          NodeFS.writeFileSync(file, "```mermaid\nflowchart LR\n A --> B\n```\n");
          const revision = yield* revisionOf("notes/report.md");
          const request = { cwd: project, relativePath: "notes/report.md", revision };
          const plan = yield* service.prepareDiagrams(request);
          expect(plan.diagrams).toHaveLength(1);
          NodeFS.writeFileSync(file, "```mermaid\nflowchart LR\n A --> C\n```\n");
          const error = yield* service
            .export({
              ...request,
              diagramCapture: {
                sourceDigest: plan.sourceDigest,
                diagrams: [{ id: plan.diagrams[0]!.id, result: { _tag: "render-failed" } }],
              },
            })
            .pipe(Effect.flip);
          expect(error._tag === "ScientWordExportError" && error.reason).toBe("file-changed");
        }),
      ),
  );

  if (binary !== null)
    it.live(
      "produces Word from saved Markdown with Mermaid source and local CSL and BibTeX references",
      () =>
        run(
          ({ service, project, revisionOf }) =>
            Effect.gen(function* () {
              const notes = NodePath.join(project, "notes");
              NodeFS.writeFileSync(
                NodePath.join(notes, "local.json"),
                JSON.stringify([
                  {
                    id: "json2025",
                    type: "book",
                    title: "JSON Reference",
                    author: [{ family: "Example" }],
                    issued: { "date-parts": [[2025]] },
                  },
                ]),
              );
              NodeFS.writeFileSync(
                NodePath.join(notes, "local.bib"),
                "@article{bib2024, author={Doe, Jane}, title={BibTeX Reference}, year={2024}}\n",
              );
              NodeFS.writeFileSync(
                NodePath.join(notes, "report.md"),
                [
                  "---",
                  "bibliography:",
                  "  - local.json",
                  "  - local.bib",
                  "references:",
                  "  - id: inline2026",
                  "    type: book",
                  "    title: Inline Reference",
                  "    author:",
                  "      - family: Author",
                  "    issued:",
                  "      date-parts: [[2026]]",
                  "---",
                  "# Report",
                  "See [@json2025], [@bib2024], and [@inline2026].",
                  "",
                  "```mermaid",
                  "flowchart LR",
                  "  A --> B",
                  "```",
                ].join("\n"),
              );
              const produced = yield* service.export({
                cwd: project,
                relativePath: "notes/report.md",
                revision: yield* revisionOf("notes/report.md"),
              });
              const docx = yield* readDocx(produced.path);
              const xml = docx.text("word/document.xml");
              expect(xml).toContain("JSON Reference");
              expect(xml).toContain("BibTeX Reference");
              expect(xml).toContain("Inline Reference");
              expect(xml).toContain("Mermaid diagram source (image unavailable)");
              expect(xml).toContain("A --&gt; B");
              expect(xml).not.toContain("[@json2025]");
              expect(produced.warnings.map((warning) => warning.message).join("\n")).toContain(
                "complete Mermaid source",
              );
            }),
          { realConverter: true },
        ),
    );

  if (binary !== null)
    it.live("embeds a captured Mermaid PNG in the real Word package", () =>
      run(
        ({ service, project, revisionOf }) =>
          Effect.gen(function* () {
            NodeFS.writeFileSync(
              NodePath.join(project, "notes", "report.md"),
              "# Report\n\n```mermaid\nflowchart LR\n A --> B\n```\n",
            );
            const request = {
              cwd: project,
              relativePath: "notes/report.md",
              revision: yield* revisionOf("notes/report.md"),
            };
            const plan = yield* service.prepareDiagrams(request);
            const produced = yield* service.export({
              ...request,
              diagramCapture: {
                sourceDigest: plan.sourceDigest,
                diagrams: [
                  {
                    id: plan.diagrams[0]!.id,
                    result: { _tag: "png", base64: Buffer.from(PNG_BYTES).toString("base64") },
                  },
                ],
              },
            });
            const docx = yield* readDocx(produced.path);
            expect(
              [...docx.entries.keys()].some((name) => /^word\/media\/.*\.png$/u.test(name)),
            ).toBe(true);
            expect(docx.text("word/document.xml")).toContain("w:drawing");
            expect(docx.text("word/document.xml")).not.toContain(
              "Mermaid diagram source (image unavailable)",
            );
            expect(produced.warnings.map((warning) => warning.message).join("\n")).not.toContain(
              "complete Mermaid source",
            );
          }),
        { realConverter: true },
      ),
    );

  it.live("passes only local bibliographies and reports inaccessible references", () => {
    const seen: Array<WordConversionInput> = [];
    return run(
      ({ service, project, revisionOf }) =>
        Effect.gen(function* () {
          NodeFS.writeFileSync(
            NodePath.join(project, "notes", "report.md"),
            [
              "---",
              "bibliography: [missing.json, ../../outside.bib, https://example.com/remote.bib]",
              "references:",
              "  - id: known",
              "    type: book",
              "    title: Known reference",
              "---",
              "See [@known] and [@unknown].",
            ].join("\n"),
          );
          const produced = yield* service.export({
            cwd: project,
            relativePath: "notes/report.md",
            revision: yield* revisionOf("notes/report.md"),
          });
          expect(seen[0]?.bundle.citations.map((citation) => citation._tag)).toEqual([
            "bibliographic",
          ]);
          expect(seen[0]?.bibliographySources).toEqual([]);
          expect(
            produced.warnings.filter((warning) => warning.code === "resource-unresolved"),
          ).toHaveLength(4);
        }),
      { seen },
    );
  });
  it.live("exports the selected LaTeX root and validates the editor revision", () => {
    const seen: Array<WordConversionInput> = [];
    return run(
      ({ service, project, revisionOf }) =>
        Effect.gen(function* () {
          NodeFS.writeFileSync(
            NodePath.join(project, "notes", "main.tex"),
            [
              "\\begin{document}",
              "\\input{section}",
              "\\includegraphics{plot.png}",
              "\\input{../shared/methods}",
              "\\includegraphics{../figures/shared.png}",
              "\\input{../../outside}",
              "\\end{document}",
            ].join(""),
          );
          NodeFS.writeFileSync(NodePath.join(project, "notes", "plot.png"), PNG_BYTES);
          NodeFS.writeFileSync(NodePath.join(project, "notes", "section.tex"), "A nested section.");
          NodeFS.writeFileSync(NodePath.join(project, "notes", "unrelated.tex"), "Unrelated.");
          // Elsewhere in the same project, and outside it.
          NodeFS.mkdirSync(NodePath.join(project, "shared"));
          NodeFS.writeFileSync(NodePath.join(project, "shared", "methods.tex"), "Shared methods.");
          NodeFS.mkdirSync(NodePath.join(project, "figures"));
          NodeFS.writeFileSync(NodePath.join(project, "figures", "shared.png"), PNG_BYTES_ALT);
          NodeFS.writeFileSync(NodePath.join(project, "..", "outside.tex"), "FAKE-SECRET-OUTSIDE");
          const revision = yield* revisionOf("notes/main.tex");
          const produced = yield* service.exportLatex({
            cwd: project,
            relativePath: "notes/main.tex",
            rootRelativePath: "notes/main.tex",
            revision,
          });
          expect(produced.fileName).toBe("main.docx");
          expect(seen[0]?.latex?.source).toContain("A nested section.");
          expect(seen[0]?.latex?.source).toContain("Shared methods.");
          expect(seen[0]?.latex?.source).toContain("[Include outside the project folder]");
          expect(seen[0]?.latex?.source).not.toContain("FAKE-SECRET-OUTSIDE");
          const figure = seen[0]?.imageSnapshot?.get("plot.png");
          expect(figure?.ok).toBe(true);
          if (figure?.ok) expect(figure.bytes).toEqual(PNG_BYTES);
          const shared = seen[0]?.imageSnapshot?.get("../figures/shared.png");
          expect(shared?.ok).toBe(true);
          if (shared?.ok) expect(shared.bytes).toEqual(PNG_BYTES_ALT);
          expect(NodeFS.realpathSync(seen[0]!.files!.allowRoots[0]!)).toBe(
            NodeFS.realpathSync(project),
          );
          const changed = yield* service
            .exportLatex({
              cwd: project,
              relativePath: "notes/main.tex",
              rootRelativePath: "notes/main.tex",
              revision: "stale",
            })
            .pipe(Effect.flip);
          expect(changed._tag === "ScientWordExportError" && changed.reason).toBe("file-changed");
          const unrelated = yield* service
            .exportLatex({
              cwd: project,
              relativePath: "notes/unrelated.tex",
              rootRelativePath: "notes/main.tex",
              revision: yield* revisionOf("notes/unrelated.tex"),
            })
            .pipe(Effect.flip);
          expect(unrelated._tag === "ScientWordExportError" && unrelated.reason).toBe(
            "file-unreadable",
          );
        }),
      { seen },
    );
  });
  it.live(
    "on Windows exports a single open LaTeX file, refuses other project files, and leaves Markdown images out",
    () => {
      const seen: Array<WordConversionInput> = [];
      return run(
        ({ service, project, revisionOf }) =>
          Effect.gen(function* () {
            const notes = NodePath.join(project, "notes");
            NodeFS.writeFileSync(NodePath.join(notes, "plot.png"), PNG_BYTES);
            NodeFS.writeFileSync(NodePath.join(notes, "single.tex"), "Single body.");
            NodeFS.writeFileSync(NodePath.join(notes, "chapter.tex"), "Chapter.");
            NodeFS.writeFileSync(NodePath.join(notes, "included.tex"), "\\input{chapter}");
            NodeFS.writeFileSync(NodePath.join(notes, "figure.tex"), "\\includegraphics{plot}");
            const exportOnWindows = (name: string) =>
              Effect.gen(function* () {
                const relativePath = `notes/${name}`;
                return yield* service.exportLatex({
                  cwd: project,
                  relativePath,
                  rootRelativePath: relativePath,
                  revision: yield* revisionOf(relativePath),
                });
              }).pipe(Effect.provideService(HostProcessPlatform, "win32"));

            yield* exportOnWindows("single.tex");
            expect(seen[0]?.latex?.source).toBe("Single body.");
            for (const name of ["included.tex", "figure.tex"]) {
              const refused = yield* exportOnWindows(name).pipe(Effect.flip);
              expect(refused).toMatchObject({
                reason: "file-unreadable",
                message: LATEX_UNVERIFIABLE_PLATFORM_MESSAGE,
              });
            }
            expect(seen).toHaveLength(1);

            yield* service
              .export({
                cwd: project,
                relativePath: "notes/report.md",
                revision: yield* revisionOf("notes/report.md"),
              })
              .pipe(Effect.provideService(HostProcessPlatform, "win32"));
            // The Markdown file still exports; its image is left out, as in PDF on Windows.
            expect(seen[1]?.bundle.markdown).toContain("# Report");
            expect(seen[1]?.imageSnapshot?.get("plot.png")).toEqual({
              ok: false,
              refusal: "unverifiable-platform",
            });
          }),
        { seen },
      );
    },
  );

  it.live("converts the saved file with images resolved only inside the project", () => {
    const seen: Array<WordConversionInput> = [];
    return run(
      ({ service, project, revisionOf }) =>
        Effect.gen(function* () {
          const revision = yield* revisionOf("notes/report.md");
          const produced = yield* service.export({
            cwd: project,
            relativePath: "notes/report.md",
            revision,
          });
          expect(produced.fileName).toBe("report.docx");
          expect(NodeFS.readFileSync(produced.path, "utf8")).toBe("docx");
          expect(produced.warnings[0]?.code).toBe("resource-unresolved");
          const input = seen[0]!;
          expect(input.bundle.profile).toBe("document");
          expect(input.bundle.markdown).toContain("![plot](plot.png)");
          expect(input.bundle.metadata.source).toMatchObject({
            _tag: "workspace-file",
            relativePath: "notes/report.md",
            revision,
          });
          const realProject = NodeFS.realpathSync(project);
          expect([NodeFS.realpathSync(input.files!.allowRoots[0]!)]).toEqual([realProject]);
          expect(NodeFS.realpathSync(input.files!.baseDirectory)).toBe(
            NodePath.join(realProject, "notes"),
          );
        }),
      { seen },
    );
  });

  it.live(
    "captures Markdown and image bytes before conversion and keeps the source revision honest",
    () => {
      const seen: Array<WordConversionInput> = [];
      let sourcePath = "";
      let imagePath = "";
      return run(
        ({ service, project, revisionOf }) =>
          Effect.gen(function* () {
            sourcePath = NodePath.join(project, "notes", "report.md");
            imagePath = NodePath.join(project, "notes", "plot.png");
            NodeFS.writeFileSync(imagePath, PNG_BYTES);
            const revision = yield* revisionOf("notes/report.md");
            yield* service.export({ cwd: project, relativePath: "notes/report.md", revision });
            expect(seen[0]?.bundle.markdown).toContain("![plot](plot.png)");
            const captured = seen[0]?.imageSnapshot?.get("plot.png");
            expect(captured?.ok).toBe(true);
            if (captured?.ok) expect(captured.bytes).toEqual(PNG_BYTES);
            expect(NodeFS.readFileSync(imagePath)).toEqual(Buffer.from(PNG_BYTES_ALT));
            const changed = yield* service
              .export({ cwd: project, relativePath: "notes/report.md", revision })
              .pipe(Effect.flip);
            expect(changed._tag === "ScientWordExportError" && changed.reason).toBe("file-changed");
            expect(NodeFS.readFileSync(sourcePath, "utf8")).toContain("Changed after capture");
          }),
        {
          seen,
          beforeConvert: () => {
            NodeFS.writeFileSync(imagePath, PNG_BYTES_ALT);
            NodeFS.writeFileSync(sourcePath, "# Changed after capture\n\n![plot](plot.png)\n");
          },
        },
      );
    },
  );

  it.live("refuses a file that changed since the editor showed it", () =>
    run(({ service, project }) =>
      Effect.gen(function* () {
        const error = yield* service
          .export({ cwd: project, relativePath: "notes/report.md", revision: "stale" })
          .pipe(Effect.flip);
        expect(error._tag === "ScientWordExportError" && error.reason).toBe("file-changed");
      }),
    ),
  );

  it.live("exports only Markdown files inside the project", () =>
    run(({ service, project }) =>
      Effect.gen(function* () {
        const reasonOf = (relativePath: string) =>
          service.export({ cwd: project, relativePath, revision: "r" }).pipe(
            Effect.flip,
            Effect.map((error) =>
              error._tag === "ScientWordExportError" ? error.reason : error._tag,
            ),
          );
        expect(yield* reasonOf("notes/data.csv")).toBe("not-markdown");
        expect(yield* reasonOf("/etc/hosts.md")).toBe("not-markdown");
        expect(yield* reasonOf("../outside.md")).toBe("file-unreadable");
        expect(yield* reasonOf("notes/missing.md")).toBe("file-unreadable");
      }),
    ),
  );

  it.live("reports conversion failures in the export's own terms", () =>
    run(
      ({ service, project, revisionOf }) =>
        Effect.gen(function* () {
          const error = yield* service
            .export({
              cwd: project,
              relativePath: "notes/report.md",
              revision: yield* revisionOf("notes/report.md"),
            })
            .pipe(Effect.flip);
          expect(error._tag === "ScientWordExportError" && error.reason).toBe("too-large");
          expect(error._tag === "ScientWordExportError" && error.message).toBe("Word said no.");
        }),
      { failure: "timeout" },
    ),
  );
});
