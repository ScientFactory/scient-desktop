// @effect-diagnostics nodeBuiltinImport:off -- Library-mode tests read the real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import { attachScientSourcePdf, importScientSource } from "@scientfactory/scient-sources/store";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScientAnnotationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../config.ts";
import { readAnnotationsForInvocation } from "../../mcp/toolkits/annotations/handlers.ts";
import * as AgentInvocationContext from "../operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../projectScope/WorkspaceBindingTestUtils.ts";
import { ScientSourcesBackend, type ScientSourcesBackendKind } from "../sources/SourcesBackend.ts";
import { readerAnchor, textPdf, writeProjectFile } from "./annotationTestUtils.ts";
import { layer, ScientAnnotations } from "./ScientAnnotations.ts";

const candidate: ScientSourceCandidate = {
  sourceKey: "sleep-paper",
  type: "article",
  customType: null,
  title: "Sleep and memory",
  creators: [],
  issuedRaw: null,
  issuedYear: 2024,
  identifiers: [],
  abstract: null,
  containerTitle: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: null,
  tags: [],
  externalReferences: [],
  fieldProvenance: [],
  pdfAvailable: false,
  pdfFileName: null,
  pdfAttachmentCount: 0,
};

const PAGE = "We studied sleep in mice.";

/** A v1 project with one Source PDF and one project PDF that is no Source's. */
const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-annotations-library-")),
    );
    const root = NodePath.join(base, "project");
    await NodeFSP.mkdir(root);
    await initializeScientProject({ root });
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    const pdfPath = NodePath.join(base, "sleep.pdf");
    await NodeFSP.writeFile(pdfPath, textPdf([["Sleep and memory", PAGE]]));
    const attached = await attachScientSourcePdf({
      root,
      sourceId: imported.record!.sourceId,
      expectedRevision: imported.record!.revision,
      pdfPath,
    });
    const attachment = attached.record.attachments[0]!;
    await writeProjectFile(root, "notes/own.pdf", textPdf([["My own notes", PAGE]]));
    return {
      base,
      root,
      stateDir: NodePath.join(base, "state"),
      sourceId: imported.record!.sourceId,
      sourcePdfPath: `.scient/sources/${attachment.relativePath}`,
      material: { sha256: attachment.sha256, byteLength: attachment.byteLength },
    };
  }),
  ({ base }) => Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
);
type Fixture = Effect.Success<typeof fixture>;

const on =
  (backend: ScientSourcesBackendKind, { stateDir }: Fixture) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ScientSourcesBackend, backend),
      Effect.provideService(ServerConfig.ServerConfig, {
        stateDir,
      } as ServerConfig.ServerConfig["Service"]),
    );

const create = (annotationId: string, quote: string): ScientAnnotationCommand => ({
  action: "create",
  annotationId,
  anchor: readerAnchor({ text: PAGE, quote }),
  highlighted: true,
  note: "",
});

async function tree(root: string): Promise<ReadonlyArray<string>> {
  const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = NodePath.join(entry.parentPath, entry.name);
    files.push(`${path}:${NodeCrypto.hash("sha256", await NodeFSP.readFile(path))}`);
  }
  return files.toSorted();
}

const ids = (annotations: ReadonlyArray<{ readonly annotationId: string }>) =>
  annotations.map((annotation) => annotation.annotationId).toSorted();

const environmentId = EnvironmentId.make("environment-annotations-library");

/** The agent's annotation read tool, bound to this project with read access only. */
const agentRead = (root: string) => {
  const resolver = workspaceResolverForTest(
    new Map([
      [root, { projectId: "project", scope: workspaceScopeForTest(`binding:${root}`, root) }],
    ]),
  );
  return readAnnotationsForInvocation({}).pipe(
    Effect.provideService(
      WorkspaceBindingResolver,
      WorkspaceBindingResolver.of({
        ...resolver,
        resolveThread: () =>
          resolver.resolveWorkspaceRoot(root).pipe(
            Effect.map((resolved) => ({
              ...resolved,
              binding: {
                ...resolved.binding,
                environmentId,
                hostProjectId: ProjectId.make("project"),
              },
            })),
          ),
      }),
    ),
    Effect.provideService(
      AgentInvocationContext.AgentInvocationContext,
      AgentInvocationContext.AgentInvocationContext.of({
        environmentId,
        threadId: ThreadId.make("thread-annotations-library"),
        providerSessionId: "session-annotations-library",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["sources:read"]),
        issuedAt: 1,
      }),
    ),
  );
};

describe("annotations on the library backend", () => {
  it.effect("highlights on library PDFs live in the library; project PDFs keep theirs", () =>
    Effect.gen(function* () {
      const project = yield* fixture;
      const { root, sourceId, sourcePdfPath, material } = project;
      const annotations = yield* ScientAnnotations;
      const libraryFolder = NodePath.join(project.stateDir, "scient", "library");
      const own = yield* annotations
        .forDocument({ root, relativePath: "notes/own.pdf" })
        .pipe(on("project", project));
      if (own.status !== "available") throw new Error("Expected the project PDF to open");

      // Before the move, on today's backend.
      yield* annotations
        .mutate(
          { root, relativePath: sourcePdfPath, material, command: create("ann_before01", "sleep") },
          "user",
        )
        .pipe(on("project", project));
      yield* annotations
        .mutate(
          {
            root,
            relativePath: "notes/own.pdf",
            material: own.material,
            command: create("ann_own00001", "mice"),
          },
          "user",
        )
        .pipe(on("project", project));

      // A read on the library backend reads the unmoved project and creates nothing.
      const before = yield* Effect.promise(() => tree(project.base));
      const unmoved = yield* annotations.forSource({ root, sourceId }).pipe(on("library", project));
      expect(ids(unmoved.attachments[0]!.annotations)).toEqual(["ann_before01"]);
      expect(yield* Effect.promise(() => tree(project.base))).toEqual(before);

      // A write moves the project first; its new highlight lands in the library's folder.
      const created = yield* annotations
        .mutate(
          {
            root,
            relativePath: sourcePdfPath,
            material,
            command: create("ann_after001", "studied"),
          },
          "user",
        )
        .pipe(on("library", project));
      expect(created.outcome).toBe("created");
      const libraryFile = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(libraryFolder, "annotations", "v1", `${material.sha256}.json`),
            "utf8",
          ),
        ),
      );
      expect(ids(libraryFile.annotations)).toEqual(["ann_after001", "ann_before01"]);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(
            NodePath.join(root, ".scient", "annotations", "v1", `${material.sha256}.json`),
          ).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);

      // The reader's routes, by Source and by the PDF's old store path.
      const bySource = yield* annotations
        .forSource({ root, sourceId })
        .pipe(on("library", project));
      expect(ids(bySource.attachments[0]!.annotations)).toEqual(["ann_after001", "ann_before01"]);
      const byPath = yield* annotations
        .forDocument({ root, relativePath: sourcePdfPath })
        .pipe(on("library", project));
      expect(byPath.status === "available" && ids(byPath.annotations)).toEqual([
        "ann_after001",
        "ann_before01",
      ]);

      // A project PDF that is not a library PDF keeps the project folder.
      yield* annotations
        .mutate(
          {
            root,
            relativePath: "notes/own.pdf",
            material: own.material,
            command: create("ann_own_later", "sleep"),
          },
          "user",
        )
        .pipe(on("library", project));
      const ownFile = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(root, ".scient", "annotations", "v1", `${own.material.sha256}.json`),
            "utf8",
          ),
        ),
      );
      expect(ids(ownFile.annotations)).toEqual(["ann_own00001", "ann_own_later"]);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(
            NodePath.join(libraryFolder, "annotations", "v1", `${own.material.sha256}.json`),
          ).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);

      // The agent's read tool sees both homes.
      const listed = yield* agentRead(root).pipe(on("library", project));
      expect(
        listed.pdfs.flatMap((pdf) => pdf.annotations.map((entry) => entry.annotationId)).toSorted(),
      ).toEqual(["ann_after001", "ann_before01", "ann_own00001", "ann_own_later"]);

      // A shard folder that is a link names bytes kept elsewhere: not library material.
      const shard = NodePath.join(libraryFolder, "files", "sha256", material.sha256.slice(0, 2));
      const outside = NodePath.join(project.base, "outside");
      yield* Effect.promise(async () => {
        await NodeFSP.rename(shard, outside);
        await NodeFSP.symlink(outside, shard, "junction");
      });
      const linked = yield* annotations
        .forDocument({ root, relativePath: sourcePdfPath })
        .pipe(on("library", project));
      expect(linked.status).toBe("unavailable");
      // The listing follows the rule a change follows, so it lists nothing a change cannot reach.
      const afterLink = yield* agentRead(root).pipe(on("library", project));
      expect(ids(afterLink.pdfs.flatMap((pdf) => pdf.annotations))).toEqual([
        "ann_own00001",
        "ann_own_later",
      ]);
    }).pipe(Effect.provide(layer)),
  );
});
