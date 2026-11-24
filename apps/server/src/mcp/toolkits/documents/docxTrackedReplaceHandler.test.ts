// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BindingGeneration, type PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ServerConfig from "../../../config.ts";
import {
  GeneratedDocumentStore,
  type GeneratedDocumentProductionHandle,
} from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as DocumentHostBroker from "../../../scient/documents/DocumentHostBroker.ts";
import * as DocumentOfficeToolchain from "../../../scient/documents/docxJob/DocumentOfficeToolchain.ts";
import {
  REVIEW,
  TINY_CANDIDATE_PDF,
  TINY_EDIT,
  TINY_SOURCE_PDF,
  tinyDocx,
} from "../../../scient/documents/docxJob/docxJob.testkit.ts";
import { OfficeRenderer } from "../../../scient/documents/docxJob/OfficeRenderer.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import {
  WorkspaceAuthorityGeneration,
  WorkspaceAuthorityScopeRevision,
  WorkspaceBindingId,
} from "../../../scient/projectScope/WorkspaceBinding.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { filePublicationTestHelper } from "../../../scient/workspace/fileExchange.testkit.ts";
import { layerKnownWorkspacesAllowAll } from "../../../scient/workspace/knownWorkspaces.testkit.ts";
import { bytesRevision } from "../../../scient/workspace/RetainedFileMutation.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import { replaceDocxTextForInvocation } from "./docxTrackedReplaceHandler.ts";

const environmentId = EnvironmentId.make("environment-docx-job-test");
const threadId = ThreadId.make("thread-docx-job");
const roots: string[] = [];
const publicationHelper = await filePublicationTestHelper();
const configLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-docx-job-test-" });
    return ServerConfig.layerTest(
      process.cwd(),
      yield* fs.realPath(directory),
      publicationHelper === undefined ? {} : { filePublicationHelperPath: publicationHelper },
    );
  }),
);
const workspaceLayer = Layer.mergeAll(
  configLayer,
  WorkspaceFileSystem.layer.pipe(
    Layer.provide(layerKnownWorkspacesAllowAll),
    Layer.provide(configLayer),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
    Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Layer.orDie);

const pdfSource = {
  _tag: "generated-pdf",
  authority: "environment-docx-job-test",
  logicalDocumentKey: "docx-tracked:fixture",
  title: "copy",
  fileName: "copy.pdf",
  capabilities: { canSaveCopy: true, canRevealSource: false },
  artifactId: "artifact-1",
  revisionId: "revision-1",
  bindingGeneration: 1,
  bindingStatus: "current",
  staleReason: null,
  pageCount: 1,
} as PdfSourceDescriptor;

const ready = {
  status: "ready",
  engine: "LibreOffice",
  version: "26.2.4.2",
  buildId: "0229ac93fcf0d7cbc6376066c6f35021cef002dc",
  platformArch: "darwin-arm64",
  provisioning: "pinned-archive",
  sofficePath: "/office/soffice",
  inputPolicy: "trusted-fixtures",
  isolation: "process-boundary",
} as const;

function harness(
  root: string,
  options: {
    readonly sameRender?: boolean;
    readonly status?: DocumentOfficeToolchain.OfficeToolchainStatus;
  } = {},
) {
  const sourcePdf = new Uint8Array(NodeFS.readFileSync(TINY_SOURCE_PDF));
  const candidatePdf = new Uint8Array(NodeFS.readFileSync(TINY_CANDIDATE_PDF));
  const render = vi.fn(() =>
    Effect.succeed(
      new Map([
        ["source.docx", sourcePdf],
        ["candidate.docx", options.sameRender === true ? sourcePdf : candidatePdf],
      ]) as ReadonlyMap<string, Uint8Array>,
    ),
  );
  const handle = {
    logicalDocumentKey: "docx-tracked:fixture",
    operationId: "docx-tracked-operation",
    producerId: "scient.docx-tracked-replace",
    generation: BindingGeneration.make(1),
  } as GeneratedDocumentProductionHandle;
  const store = {
    beginProduction: vi.fn(() => Effect.succeed(handle)),
    publishPdf: vi.fn(() => Effect.succeed(pdfSource)),
    abandonProduction: vi.fn(() => Effect.succeed({} as never)),
    failProduction: vi.fn(() => Effect.succeed({} as never)),
  };
  const present = vi.fn(() => Effect.succeed({}));
  const binding = {
    schemaVersion: 1,
    bindingId: WorkspaceBindingId.make(`binding:${root}`),
    environmentId,
    hostProjectId: "project-docx",
    canonicalRoot: root,
    rootFileSystemIdentity: null,
    scientProjectId: "scient-project-fixture",
    repositoryIdentity: null,
    worktreeIdentity: null,
    lineageBindingId: null,
    trustState: "verified",
    authorityGeneration: WorkspaceAuthorityGeneration.make(1),
    createdAt: "2026-11-24T08:00:00.000Z",
    lastVerifiedAt: "2026-11-24T08:00:00.000Z",
    supersededBy: null,
  } as const;
  const resolved = {
    binding,
    relation: "only-binding",
    relatedBindingCount: 0,
    scopeRevision: WorkspaceAuthorityScopeRevision.make(1),
  } as const;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        AgentInvocationContext.AgentInvocationContext,
        AgentInvocationContext.AgentInvocationContext.of({
          environmentId,
          threadId,
          providerSessionId: "session-docx-job",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["documents:build"]),
          issuedAt: 1,
        }),
      ),
      Effect.provideService(
        WorkspaceBindingResolver,
        WorkspaceBindingResolver.of({
          resolveThread: () => Effect.succeed(resolved),
          assertCurrentThreadScope: () => Effect.succeed(binding),
        } as unknown as WorkspaceBindingResolver["Service"]),
      ),
      Effect.provideService(
        GeneratedDocumentStore,
        GeneratedDocumentStore.of(store as unknown as GeneratedDocumentStore["Service"]),
      ),
      Effect.provideService(
        DocumentHostBroker.DocumentHostBroker,
        DocumentHostBroker.DocumentHostBroker.of({
          invoke: present,
        } as unknown as DocumentHostBroker.DocumentHostBroker["Service"]),
      ),
      Effect.provideService(
        DocumentOfficeToolchain.DocumentOfficeToolchain,
        DocumentOfficeToolchain.DocumentOfficeToolchain.of({
          status: Effect.succeed(options.status ?? ready),
        }),
      ),
      Effect.provideService(OfficeRenderer, OfficeRenderer.of({ render })),
      Effect.provide(
        workspaceLayer.pipe(
          Layer.provideMerge(
            Layer.mock(Orchestrator.OrchestratorV2)({
              dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
            }),
          ),
        ),
      ),
    );
  return { render, store, present, provide };
}

const project = Effect.fn("test.project")(function* () {
  const root = yield* Effect.promise(async () =>
    NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-docx-project-"))),
  );
  roots.push(root);
  const bytes = yield* tinyDocx;
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.join(root, "docs"));
    await NodeFSP.writeFile(NodePath.join(root, "docs/report.docx"), bytes);
  });
  return { root, revision: bytesRevision(bytes) };
});

const input = (revision: string, overrides: Record<string, string> = {}) => ({
  sourcePath: "docs/report.docx",
  sourceRevision: revision,
  outputPath: "docs/report-reviewed.docx",
  pdfOutputPath: "docs/report-reviewed.pdf",
  ...TINY_EDIT,
  ...REVIEW,
  ...overrides,
});

const exists = (root: string, relative: string) =>
  Effect.promise(() =>
    NodeFSP.access(NodePath.join(root, relative)).then(
      () => true,
      () => false,
    ),
  );
const sourceRevision = (root: string) =>
  Effect.promise(async () =>
    bytesRevision(await NodeFSP.readFile(NodePath.join(root, "docs/report.docx"))),
  );

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Word tracked replacement tool", () => {
  it.effect("saves the checked copy and its PDF and leaves the source as it was", () =>
    Effect.gen(function* () {
      const { root, revision } = yield* project();
      const h = harness(root);
      const result = yield* h.provide(replaceDocxTextForInvocation(input(revision)));
      expect(result).toMatchObject({
        sourcePath: "docs/report.docx",
        sourceRevision: revision,
        outputPath: "docs/report-reviewed.docx",
        pdfOutputPath: "docs/report-reviewed.pdf",
        pdf: pdfSource,
        revision: { deletionId: "1", insertionId: "2", ...REVIEW },
        pageCount: 1,
        editPage: 1,
        engine: { name: "LibreOffice", version: "26.2.4.2", provisioning: "pinned-archive" },
        support: {
          inputPolicy: "trusted-fixtures",
          isolation: "process-boundary",
          osSandbox: false,
        },
        warnings: [],
      });
      expect(result.checks.every((check) => check.passed)).toBe(true);
      expect(h.store.publishPdf).toHaveBeenCalledWith(
        expect.objectContaining({ provenanceKind: "document-build" }),
      );
      const written = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "docs/report-reviewed.docx")),
      );
      expect(bytesRevision(written)).toBe(result.outputRevision);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "docs/report-reviewed.pdf")),
        ),
      ).toEqual(Buffer.from(NodeFS.readFileSync(TINY_CANDIDATE_PDF)));
      expect(yield* sourceRevision(root)).toBe(revision);
    }),
  );

  it.effect("saves nothing when a check of the render fails", () =>
    Effect.gen(function* () {
      const { root, revision } = yield* project();
      const h = harness(root, { sameRender: true });
      const error = yield* h
        .provide(replaceDocxTextForInvocation(input(revision)))
        .pipe(Effect.flip);
      expect(error).toMatchObject({ code: "integrity-failed", reason: "pdf-checks" });
      expect(error.checks?.find((check) => check.id === "pdf-tracked-text-shown")?.passed).toBe(
        false,
      );
      expect(h.store.beginProduction).not.toHaveBeenCalled();
      expect(yield* exists(root, "docs/report-reviewed.docx")).toBe(false);
      expect(yield* exists(root, "docs/report-reviewed.pdf")).toBe(false);
      expect(yield* sourceRevision(root)).toBe(revision);
    }),
  );

  it.effect("works only on the revision the caller named, and only into a new copy", () =>
    Effect.gen(function* () {
      const { root, revision } = yield* project();
      const h = harness(root);
      const stale = yield* h
        .provide(replaceDocxTextForInvocation(input(`sha256:${"0".repeat(64)}`)))
        .pipe(Effect.flip);
      expect(stale.code).toBe("source-changed");
      const inPlace = yield* h
        .provide(replaceDocxTextForInvocation(input(revision, { outputPath: "docs/report.docx" })))
        .pipe(Effect.flip);
      expect(inPlace.code).toBe("invalid-output-path");
      const escaping = yield* h
        .provide(replaceDocxTextForInvocation(input(revision, { outputPath: "../outside.docx" })))
        .pipe(Effect.flip);
      expect(escaping.code).toBe("invalid-output-path");
      expect(h.render).not.toHaveBeenCalled();
      expect(yield* sourceRevision(root)).toBe(revision);
    }),
  );

  it.effect("on Windows reads the unbound file only at the revision the caller named", () =>
    Effect.gen(function* () {
      const { root, revision } = yield* project();
      const h = harness(root);
      const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(HostProcess.Platform, "win32"));
      const stale = yield* onWindows(
        h.provide(replaceDocxTextForInvocation(input(`sha256:${"1".repeat(64)}`))),
      ).pipe(Effect.flip);
      expect(stale.code).toBe("source-changed");
      expect(h.render).not.toHaveBeenCalled();
      const error = yield* onWindows(
        h.provide(replaceDocxTextForInvocation(input(revision, { find: "absent", replace: "x" }))),
      ).pipe(Effect.flip);
      // The named revision was read and handed to the job, which then refused the edit.
      expect(error).toMatchObject({ code: "unsupported-edit", reason: "text-not-found" });
    }),
  );

  it.effect("refuses without the qualified engine", () =>
    Effect.gen(function* () {
      const { root, revision } = yield* project();
      const h = harness(root, { status: { status: "unavailable", reason: "unpinned-engine" } });
      const error = yield* h
        .provide(replaceDocxTextForInvocation(input(revision)))
        .pipe(Effect.flip);
      expect(error).toMatchObject({ code: "toolchain-unavailable", reason: "unpinned-engine" });
      expect(h.render).not.toHaveBeenCalled();
    }),
  );
});
