// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BindingGeneration, type PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../../../project/T3ProjectFileLoader.ts";
import {
  GeneratedDocumentStore,
  GeneratedDocumentStoreError,
  type GeneratedDocumentProductionHandle,
} from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { buildScientPdfForInvocation } from "./handlers.ts";

const fixtures: string[] = [];
const now = "2026-08-29T08:00:00.000Z";
const environmentId = EnvironmentId.make("environment-html-pdf-test");
const providerInstanceId = ProviderInstanceId.make("codex");
const defaultBuildInput = {
  sourcePath: "documents/report.html",
  outputPath: "outputs/report.pdf",
} as const;

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-html-pdf-handler-test-",
});
const assetLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

async function fixture(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

async function writeHtml(root: string, relativePath = "documents/report.html") {
  const filePath = NodePath.join(root, relativePath);
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, "<!doctype html><title>Report</title><main>Body</main>");
  return filePath;
}

function minimalPdf(marker: string): Uint8Array {
  const stream = `% ${marker}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

const source = {
  _tag: "generated-pdf",
  authority: "environment-html-pdf-test",
  logicalDocumentKey: "html-pdf:fixture",
  title: "Rendered report",
  fileName: "Rendered report.pdf",
  capabilities: { canSaveCopy: true, canRevealSource: false },
  artifactId: "artifact-1",
  revisionId: "revision-1",
  bindingGeneration: 1,
  bindingStatus: "current",
  staleReason: null,
  pageCount: 1,
} as PdfSourceDescriptor;

const renderResult = {
  title: "Rendered report",
  sourceUrl: "https://environment.test/api/assets/internal/report.html",
  profile: "document-layout" as const,
  media: "print" as const,
  warnings: ["broken-images"],
  sourceSignals: {
    bodyTextLength: 100,
    imageCount: 1,
    brokenImageCount: 1,
    canvasCount: 0,
    videoCount: 0,
    iframeCount: 0,
    scrollWidth: 900,
    scrollHeight: 1_200,
  },
  blockedRequestCount: 2,
  bytesBase64: Encoding.encodeBase64Url(minimalPdf("controlled-render")),
};

function makeStore(options?: {
  readonly onPublish?: () => Promise<void>;
  readonly publishError?: GeneratedDocumentStoreError;
}) {
  const handle = {
    logicalDocumentKey: "html-pdf:fixture",
    operationId: "html-pdf-operation",
    producerId: "scient.html-pdf",
    generation: BindingGeneration.make(1),
  } as GeneratedDocumentProductionHandle;
  const beginProduction = vi.fn(() => Effect.succeed(handle));
  const publishPdf = vi.fn(() => {
    if (options?.publishError !== undefined) return Effect.fail(options.publishError);
    if (options?.onPublish !== undefined) {
      return Effect.promise(async () => {
        await options.onPublish?.();
        return source;
      });
    }
    return Effect.succeed(source);
  });
  const abandonProduction = vi.fn(() => Effect.succeed({} as never));
  const failProduction = vi.fn(() => Effect.succeed({} as never));
  const store = GeneratedDocumentStore.of({
    beginProduction,
    publishPdf,
    abandonProduction,
    failProduction,
  } as unknown as GeneratedDocumentStore["Service"]);
  return { store, beginProduction, publishPdf, abandonProduction, failProduction };
}

function makeBroker(options?: {
  readonly onRender?: () => Promise<void>;
  readonly renderResult?: unknown;
  readonly failPresentation?: boolean;
}) {
  const invoke = vi.fn((request: PreviewAutomationBroker.PreviewAutomationInvokeInput) =>
    request.operation === "documentPdfRender"
      ? Effect.promise(async () => {
          await options?.onRender?.();
          return options?.renderResult ?? renderResult;
        })
      : options?.failPresentation === true
        ? Effect.fail({ _tag: "PreviewAutomationNoAvailableHostError" } as never)
        : Effect.succeed({}),
  );
  const broker = PreviewAutomationBroker.PreviewAutomationBroker.of({
    invoke,
  } as unknown as PreviewAutomationBroker.PreviewAutomationBroker["Service"]);
  return { broker, invoke };
}

const makeProject = (projectId: ProjectId, workspaceRoot: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "PDF project",
  workspaceRoot,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});

const makeThread = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly worktreePath?: string | null;
}): OrchestrationThreadShell => ({
  id: input.threadId,
  projectId: input.projectId,
  title: "PDF thread",
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: input.worktreePath ?? null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const makeQuery = (input: {
  readonly thread: OrchestrationThreadShell | null;
  readonly project: OrchestrationProjectShell | null;
}) =>
  ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
    getThreadShellById: () =>
      Effect.succeed(input.thread === null ? Option.none() : Option.some(input.thread)),
    getProjectShellById: () =>
      Effect.succeed(input.project === null ? Option.none() : Option.some(input.project)),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape);

const makeInvocation = (
  threadId: ThreadId,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["documents:build"]),
) =>
  McpInvocationContext.McpInvocationContext.of({
    environmentId,
    threadId,
    providerSessionId: "session-html-pdf-test",
    providerInstanceId,
    capabilities,
    issuedAt: 1,
  });

function runBuild(
  effect: ReturnType<typeof buildScientPdfForInvocation>,
  input: {
    readonly invocation: McpInvocationContext.McpInvocationScope;
    readonly query: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
    readonly store: GeneratedDocumentStore["Service"];
    readonly broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"];
  },
) {
  return effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, input.invocation),
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, input.query),
    Effect.provideService(GeneratedDocumentStore, input.store),
    Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, input.broker),
    Effect.provide(assetLayer),
  );
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient PDF build handler", () => {
  it.effect("builds from the active worktree, publishes controlled evidence, and presents it", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* Effect.promise(() => fixture("scient-pdf-workspace-"));
      const worktreeRoot = yield* Effect.promise(() => fixture("scient-pdf-worktree-"));
      yield* Effect.promise(() => writeHtml(worktreeRoot));
      const projectId = ProjectId.make("project-html-pdf");
      const threadId = ThreadId.make("thread-html-pdf");
      const query = makeQuery({
        project: makeProject(projectId, workspaceRoot),
        thread: makeThread({ threadId, projectId, worktreePath: worktreeRoot }),
      });
      const store = makeStore();
      const broker = makeBroker();
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(worktreeRoot, "outputs"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(worktreeRoot, defaultBuildInput.outputPath), "old PDF"),
      );

      const result = yield* runBuild(buildScientPdfForInvocation(defaultBuildInput), {
        invocation: makeInvocation(threadId),
        query,
        store: store.store,
        broker: broker.broker,
      });

      expect(result).toMatchObject({
        sourcePath: "documents/report.html",
        outputPath: "outputs/report.pdf",
        source,
        title: "Rendered report",
        pageCount: 1,
        warnings: ["broken-images", "blocked-external-resources"],
        validation: "structural",
        visualReviewPerformed: false,
      });
      expect(store.beginProduction).toHaveBeenCalledWith(
        expect.objectContaining({ producerId: "scient.html-pdf" }),
      );
      expect(store.publishPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          provenanceKind: "controlled-render",
          validationProfile: "browser-export",
        }),
      );
      expect(broker.invoke).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          operation: "documentPdfRender",
          input: { assetRelativeUrl: expect.stringMatching(/^\/api\/assets\//u) },
        }),
      );
      const renderRequest = broker.invoke.mock.calls[0]?.[0];
      expect(renderRequest?.input).toMatchObject({
        assetRelativeUrl: expect.not.stringContaining(worktreeRoot),
      });
      expect(broker.invoke).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ operation: "documentPdfPresent", input: { source } }),
      );
      expect(store.abandonProduction).not.toHaveBeenCalled();
      expect(store.failProduction).not.toHaveBeenCalled();
      const writtenPdf = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(worktreeRoot, defaultBuildInput.outputPath)),
      );
      expect(writtenPdf).toEqual(Buffer.from(minimalPdf("controlled-render")));
    }),
  );

  it.effect("rejects missing authority and projectless invocations before rendering", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-pdf-authority-"));
      yield* Effect.promise(() => writeHtml(root));
      const threadId = ThreadId.make("thread-pdf-authority");
      const thread = makeThread({ threadId, projectId: null });
      const query = makeQuery({ project: null, thread });
      const store = makeStore();
      const broker = makeBroker();

      const missingCapability = yield* runBuild(buildScientPdfForInvocation(defaultBuildInput), {
        invocation: makeInvocation(threadId, new Set()),
        query,
        store: store.store,
        broker: broker.broker,
      }).pipe(Effect.result);
      expect(missingCapability).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ScientPdfBuildToolError", code: "capability-unavailable" },
      });

      const projectless = yield* runBuild(buildScientPdfForInvocation(defaultBuildInput), {
        invocation: makeInvocation(threadId),
        query,
        store: store.store,
        broker: broker.broker,
      }).pipe(Effect.result);
      expect(projectless).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ScientPdfBuildToolError", code: "project-required" },
      });
      expect(broker.invoke).not.toHaveBeenCalled();
      expect(store.beginProduction).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps a published revision successful when presentation is interrupted", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-pdf-presentation-"));
      yield* Effect.promise(() => writeHtml(root));
      const projectId = ProjectId.make("project-pdf-presentation");
      const threadId = ThreadId.make("thread-pdf-presentation");
      const query = makeQuery({
        project: makeProject(projectId, root),
        thread: makeThread({ threadId, projectId }),
      });
      const store = makeStore();
      const broker = makeBroker({ failPresentation: true });

      const result = yield* runBuild(buildScientPdfForInvocation(defaultBuildInput), {
        invocation: makeInvocation(threadId),
        query,
        store: store.store,
        broker: broker.broker,
      });

      expect(result.source).toBe(source);
      expect(result.warnings).toContain("presentation-unavailable");
      expect(store.publishPdf).toHaveBeenCalledOnce();
      expect(store.failProduction).not.toHaveBeenCalled();
      expect(store.abandonProduction).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects absolute, traversing, non-HTML, and symlink-escaping sources", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-pdf-paths-"));
      const outside = yield* Effect.promise(() => fixture("scient-pdf-outside-"));
      const outsideHtml = yield* Effect.promise(() => writeHtml(outside, "outside.html"));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "notes.txt"), "notes"));
      yield* Effect.promise(() => NodeFSP.symlink(outsideHtml, NodePath.join(root, "linked.html")));
      const projectId = ProjectId.make("project-pdf-paths");
      const threadId = ThreadId.make("thread-pdf-paths");
      const query = makeQuery({
        project: makeProject(projectId, root),
        thread: makeThread({ threadId, projectId }),
      });
      const store = makeStore();
      const broker = makeBroker();
      const context = {
        invocation: makeInvocation(threadId),
        query,
        store: store.store,
        broker: broker.broker,
      };

      for (const sourcePath of [outsideHtml, "../outside.html", "notes.txt", "linked.html"]) {
        const result = yield* runBuild(
          buildScientPdfForInvocation({ ...defaultBuildInput, sourcePath }),
          context,
        ).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ScientPdfBuildToolError", code: "invalid-source-path" },
        });
      }
      expect(broker.invoke).not.toHaveBeenCalled();
      expect(store.beginProduction).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects output paths outside the project before rendering", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-pdf-output-paths-"));
      const outside = yield* Effect.promise(() => fixture("scient-pdf-output-outside-"));
      yield* Effect.promise(() => writeHtml(root));
      yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(root, "linked-output")));
      const projectId = ProjectId.make("project-pdf-output-paths");
      const threadId = ThreadId.make("thread-pdf-output-paths");
      const query = makeQuery({
        project: makeProject(projectId, root),
        thread: makeThread({ threadId, projectId }),
      });
      const store = makeStore();
      const broker = makeBroker();
      const context = {
        invocation: makeInvocation(threadId),
        query,
        store: store.store,
        broker: broker.broker,
      };

      for (const outputPath of [
        NodePath.join(outside, "report.pdf"),
        "../report.pdf",
        "outputs/report.html",
        "linked-output/report.pdf",
      ]) {
        const result = yield* runBuild(
          buildScientPdfForInvocation({ ...defaultBuildInput, outputPath }),
          context,
        ).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ScientPdfBuildToolError", code: "invalid-output-path" },
        });
      }
      expect(broker.invoke).not.toHaveBeenCalled();
      expect(store.beginProduction).not.toHaveBeenCalled();
    }),
  );

  it.effect("abandons the attempt if the HTML changes while Chromium is rendering", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-pdf-race-"));
      const htmlPath = yield* Effect.promise(() => writeHtml(root));
      const projectId = ProjectId.make("project-pdf-race");
      const threadId = ThreadId.make("thread-pdf-race");
      const query = makeQuery({
        project: makeProject(projectId, root),
        thread: makeThread({ threadId, projectId }),
      });
      const store = makeStore();
      const broker = makeBroker({
        onRender: () => NodeFSP.appendFile(htmlPath, "<footer>changed</footer>"),
      });

      const result = yield* runBuild(buildScientPdfForInvocation(defaultBuildInput), {
        invocation: makeInvocation(threadId),
        query,
        store: store.store,
        broker: broker.broker,
      }).pipe(Effect.result);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ScientPdfBuildToolError", code: "source-changed" },
      });
      expect(store.abandonProduction).toHaveBeenCalledOnce();
      expect(store.publishPdf).not.toHaveBeenCalled();
      expect(broker.invoke).toHaveBeenCalledOnce();
      yield* Effect.promise(async () => {
        await expect(
          NodeFSP.access(NodePath.join(root, defaultBuildInput.outputPath)),
        ).rejects.toBeDefined();
      });
    }),
  );

  it.effect("abandons malformed renderer output and marks publication failures", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-pdf-failures-"));
      yield* Effect.promise(() => writeHtml(root));
      const projectId = ProjectId.make("project-pdf-failures");
      const threadId = ThreadId.make("thread-pdf-failures");
      const query = makeQuery({
        project: makeProject(projectId, root),
        thread: makeThread({ threadId, projectId }),
      });

      const malformedStore = makeStore();
      const malformedBroker = makeBroker({ renderResult: { bytesBase64: "%%%" } });
      const malformed = yield* runBuild(buildScientPdfForInvocation(defaultBuildInput), {
        invocation: makeInvocation(threadId),
        query,
        store: malformedStore.store,
        broker: malformedBroker.broker,
      }).pipe(Effect.result);
      expect(malformed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ScientPdfBuildToolError", code: "render-failed" },
      });
      expect(malformedStore.abandonProduction).toHaveBeenCalledOnce();

      const publishError = new GeneratedDocumentStoreError({
        operation: "write-revision",
        reason: "filesystem",
        detail: "fixture publication failure",
      });
      const failedStore = makeStore({ publishError });
      const outputPath = NodePath.join(root, defaultBuildInput.outputPath);
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(outputPath, "existing output"));
      const publication = yield* runBuild(buildScientPdfForInvocation(defaultBuildInput), {
        invocation: makeInvocation(threadId),
        query,
        store: failedStore.store,
        broker: makeBroker().broker,
      }).pipe(Effect.result);
      expect(publication).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ScientPdfBuildToolError", code: "publication-failed" },
      });
      expect(failedStore.failProduction).toHaveBeenCalledOnce();
      const unchangedOutput = yield* Effect.promise(() => NodeFSP.readFile(outputPath, "utf8"));
      expect(unchangedOutput).toBe("existing output");
    }),
  );

  it.effect("rejects an existing directory output before rendering or publication", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-pdf-output-write-"));
      yield* Effect.promise(() => writeHtml(root));
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, defaultBuildInput.outputPath), { recursive: true }),
      );
      const projectId = ProjectId.make("project-pdf-output-write");
      const threadId = ThreadId.make("thread-pdf-output-write");
      const query = makeQuery({
        project: makeProject(projectId, root),
        thread: makeThread({ threadId, projectId }),
      });
      const store = makeStore();
      const broker = makeBroker();

      const result = yield* runBuild(buildScientPdfForInvocation(defaultBuildInput), {
        invocation: makeInvocation(threadId),
        query,
        store: store.store,
        broker: broker.broker,
      }).pipe(Effect.result);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ScientPdfBuildToolError", code: "invalid-output-path" },
      });
      expect(store.beginProduction).not.toHaveBeenCalled();
      expect(store.publishPdf).not.toHaveBeenCalled();
      expect(broker.invoke).not.toHaveBeenCalled();
      const outputInfo = yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(root, defaultBuildInput.outputPath)),
      );
      expect(outputInfo.isDirectory()).toBe(true);
    }),
  );

  it.effect("returns a partial-publication receipt if the staged output cannot be committed", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-pdf-output-race-"));
      yield* Effect.promise(() => writeHtml(root));
      const outputPath = NodePath.join(root, defaultBuildInput.outputPath);
      const projectId = ProjectId.make("project-pdf-output-race");
      const threadId = ThreadId.make("thread-pdf-output-race");
      const query = makeQuery({
        project: makeProject(projectId, root),
        thread: makeThread({ threadId, projectId }),
      });
      const store = makeStore({
        onPublish: async () => {
          await NodeFSP.mkdir(outputPath, { recursive: true });
        },
      });
      const broker = makeBroker();

      const result = yield* runBuild(buildScientPdfForInvocation(defaultBuildInput), {
        invocation: makeInvocation(threadId),
        query,
        store: store.store,
        broker: broker.broker,
      }).pipe(Effect.result);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ScientPdfBuildToolError",
          code: "partial-publication",
          outputPath: defaultBuildInput.outputPath,
          publishedSource: source,
        },
      });
      expect(store.publishPdf).toHaveBeenCalledOnce();
      expect(store.abandonProduction).not.toHaveBeenCalled();
      expect(store.failProduction).not.toHaveBeenCalled();
      expect(broker.invoke).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ operation: "documentPdfPresent", input: { source } }),
      );
      const outputInfo = yield* Effect.promise(() => NodeFSP.stat(outputPath));
      expect(outputInfo.isDirectory()).toBe(true);
      const outputEntries = yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.dirname(outputPath)),
      );
      expect(outputEntries).toEqual([NodePath.basename(outputPath)]);
    }),
  );
});
