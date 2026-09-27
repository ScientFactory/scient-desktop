// @effect-diagnostics nodeBuiltinImport:off -- Builds a synthetic project on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
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
  type WordConversionFailureReason,
  type WordConversionInput,
} from "./PandocWordConverter.ts";
import { WordFileExport, layer as wordFileExportLayer } from "./WordFileExport.ts";

const converterLayer = (
  seen: Array<WordConversionInput>,
  failure: WordConversionFailureReason | null = null,
) =>
  Layer.effect(
    PandocWordConverter,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return PandocWordConverter.of({
        availability: Effect.succeed({ available: true, reason: null, installable: false }),
        convert: (input) =>
          Effect.gen(function* () {
            seen.push(input);
            if (failure !== null) {
              return yield* new WordConversionError({ reason: failure, message: "Word said no." });
            }
            yield* fileSystem.writeFileString(input.outputPath, "docx").pipe(Effect.orDie);
            return {
              byteLength: 4,
              warnings: [{ code: "resource-unresolved", message: "Image “x” was not embedded." }],
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
    const layer = wordFileExportLayer.pipe(
      Layer.provide(ConversationExportFiles.layer),
      Layer.provide(converterLayer(options.seen ?? [], options.failure ?? null)),
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
