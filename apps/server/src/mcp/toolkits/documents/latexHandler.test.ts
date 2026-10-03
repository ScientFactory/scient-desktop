// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ScientLatexBuildSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GeneratedDocumentStore } from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as LatexBuildService from "../../../scient/latex/LatexBuildService.ts";
import { resolveLatexDocument } from "../../../scient/latex/LatexProjectIndex.ts";
import {
  WorkspaceAuthorityGeneration,
  WorkspaceAuthorityScopeRevision,
  WorkspaceBindingId,
  type WorkspaceBindingRecordV1,
  WorkspaceBindingResolutionError,
  toSafeWorkspaceBindingDiagnostic,
} from "../../../scient/projectScope/WorkspaceBinding.ts";
import {
  WorkspaceBindingResolver,
  type WorkspaceBindingDiagnosticResolution,
} from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { buildScientLatexForInvocation } from "./latexHandler.ts";

const fixtures: string[] = [];
const now = "2026-08-29T12:00:00.000Z";
const environmentId = EnvironmentId.make("environment-latex-build-test");
const providerInstanceId = ProviderInstanceId.make("claude");
const defaultInput = { sourcePath: "main.tex", outputPath: "outputs/main.pdf" } as const;
const pdfBytes = new TextEncoder().encode("%PDF-1.4\n% immutable latex fixture\n%%EOF\n");

const source = {
  _tag: "generated-pdf",
  authority: "environment-latex-build-test",
  logicalDocumentKey: "latex:fixture/main.tex",
  title: "LaTeX fixture",
  fileName: "LaTeX fixture.pdf",
  capabilities: { canSaveCopy: true, canRevealSource: false },
  artifactId: "artifact-latex-1",
  revisionId: "revision-latex-1",
  bindingGeneration: 1,
  bindingStatus: "current",
  staleReason: null,
  pageCount: 3,
} as PdfSourceDescriptor;

const toolchain = {
  kind: "latexmk",
  executable: "/scient/latexmk",
  version: "4.86",
  probedAtEpochMs: 1,
  source: "scient-managed",
} as const;

function snapshot(overrides: Partial<ScientLatexBuildSnapshot> = {}): ScientLatexBuildSnapshot {
  return {
    logicalDocumentKey: "latex:fixture/main.tex",
    rootRelativePath: "main.tex",
    state: "idle",
    diagnostics: [],
    descriptor: null,
    failureSummary: null,
    startedAtEpochMs: null,
    finishedAtEpochMs: null,
    toolchain,
    pendingRerun: false,
    ...overrides,
  };
}

async function fixture(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

async function writeTex(root: string, relativePath = "main.tex"): Promise<string> {
  const absolutePath = NodePath.join(root, relativePath);
  await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
  await NodeFSP.writeFile(
    absolutePath,
    "\\documentclass{article}\n\\begin{document}Fixture\\end{document}\n",
  );
  return absolutePath;
}

const makeProject = (projectId: ProjectId, workspaceRoot: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "LaTeX project",
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
  title: "LaTeX thread",
  modelSelection: { instanceId: providerInstanceId, model: "claude-sonnet" },
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
  pullRequests: [],
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

const makeDynamicQuery = (input: {
  readonly thread: (threadId: ThreadId) => OrchestrationThreadShell | null;
  readonly project: (projectId: ProjectId) => OrchestrationProjectShell | null;
}) =>
  ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
    getThreadShellById: (threadId: ThreadId) => {
      const thread = input.thread(threadId);
      return Effect.succeed(thread === null ? Option.none() : Option.some(thread));
    },
    getProjectShellById: (projectId: ProjectId) => {
      const project = input.project(projectId);
      return Effect.succeed(project === null ? Option.none() : Option.some(project));
    },
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape);

const makeBinding = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly root: string;
}): WorkspaceBindingRecordV1 => ({
  schemaVersion: 1,
  bindingId: WorkspaceBindingId.make(`binding:${input.threadId}:${input.root}`),
  environmentId,
  hostProjectId: input.projectId,
  canonicalRoot: input.root,
  rootFileSystemIdentity: null,
  scientProjectId: "scient-project-latex-fixture",
  repositoryIdentity: null,
  worktreeIdentity: null,
  lineageBindingId: null,
  trustState: "verified",
  authorityGeneration: WorkspaceAuthorityGeneration.make(1),
  createdAt: now,
  lastVerifiedAt: now,
  supersededBy: null,
});

const makeResolverForQuery = (
  query: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
): WorkspaceBindingResolver["Service"] => {
  const resolveThread: WorkspaceBindingResolver["Service"]["resolveThread"] = Effect.fn(
    "TestLatexWorkspaceBindingResolver.resolveThread",
  )(function* (threadId) {
    const thread = yield* query.getThreadShellById(threadId).pipe(Effect.orDie);
    if (Option.isNone(thread)) {
      return yield* new WorkspaceBindingResolutionError({
        operation: "resolve-thread",
        kind: "thread-not-found",
      });
    }
    if (thread.value.projectId === null) {
      return yield* new WorkspaceBindingResolutionError({
        operation: "resolve-thread",
        kind: "project-required",
      });
    }
    const project = yield* query.getProjectShellById(thread.value.projectId).pipe(Effect.orDie);
    if (Option.isNone(project)) {
      return yield* new WorkspaceBindingResolutionError({
        operation: "resolve-project",
        kind: "project-not-found",
      });
    }
    return {
      binding: makeBinding({
        threadId,
        projectId: thread.value.projectId,
        root: thread.value.worktreePath ?? project.value.workspaceRoot,
      }),
      relation: "only-binding",
      relatedBindingCount: 0,
      scopeRevision: WorkspaceAuthorityScopeRevision.make(1),
    };
  });

  const assertCurrentThreadScope: WorkspaceBindingResolver["Service"]["assertCurrentThreadScope"] =
    Effect.fn("TestLatexWorkspaceBindingResolver.assertCurrentThreadScope")(function* (input) {
      const current = yield* resolveThread(input.threadId);
      if (
        current.binding.bindingId !== input.bindingId ||
        current.binding.authorityGeneration !== input.authorityGeneration ||
        current.scopeRevision !== input.scopeRevision
      ) {
        return yield* new WorkspaceBindingResolutionError({
          operation: "assert-current-thread-scope",
          kind: "stale-authority",
        });
      }
      return current.binding;
    });

  const diagnosticsForThread: WorkspaceBindingResolver["Service"]["diagnosticsForThread"] = (
    threadId,
  ) =>
    resolveThread(threadId).pipe(
      Effect.map((current): WorkspaceBindingDiagnosticResolution => ({
        binding: toSafeWorkspaceBindingDiagnostic(current.binding),
        relation: current.relation,
        relatedBindingCount: current.relatedBindingCount,
      })),
    );

  return WorkspaceBindingResolver.of({
    resolveWorkspaceRoot: () =>
      Effect.die("UI root resolution is not used by agent document tools"),
    assertCurrentWorkspaceScope: () =>
      Effect.die("UI root revalidation is not used by agent document tools"),
    resolveThread,
    resolveTrustedChild: ({ childThreadId }) => resolveThread(childThreadId),
    assertCurrentThreadScope,
    diagnosticsForThread,
  });
};

const makeInvocation = (
  threadId: ThreadId,
  capabilities: ReadonlySet<AgentInvocationContext.OperationCapability> = new Set([
    "documents:build",
  ]),
) =>
  AgentInvocationContext.AgentInvocationContext.of({
    environmentId,
    threadId,
    providerSessionId: "session-latex-build-test",
    providerInstanceId,
    capabilities,
    issuedAt: 1,
  });

function makeBuildService(options: {
  readonly initial: ScientLatexBuildSnapshot;
  readonly requested?: ScientLatexBuildSnapshot;
  readonly onStatus?: (index: number) => Effect.Effect<ScientLatexBuildSnapshot>;
}) {
  let current = options.initial;
  let statusIndex = 0;
  const status = vi.fn(() => {
    const index = statusIndex++;
    return options.onStatus?.(index) ?? Effect.succeed(current);
  });
  const requestBuild = vi.fn(() => {
    current = options.requested ?? current;
    return Effect.succeed(current);
  });
  const cancel = vi.fn(() => Effect.succeed(snapshot({ state: "cancelled" })));
  const resolveDocument = vi.fn((input: Parameters<typeof resolveLatexDocument>[0]) =>
    Effect.promise(() => resolveLatexDocument(input)),
  );
  const service = LatexBuildService.LatexBuildService.of({
    resolveDocument,
    requestBuild,
    status,
    cancel,
  });
  return { service, resolveDocument, requestBuild, status, cancel };
}

function makeStore(revisionPath: string) {
  const retainRevision = vi.fn(() => Effect.acquireRelease(Effect.void, () => Effect.void));
  const resolveRevision = vi.fn(() =>
    Effect.succeed({
      artifact: {} as never,
      path: revisionPath,
      fileName: "LaTeX fixture.pdf",
      title: "LaTeX fixture",
      revision: { size: pdfBytes.byteLength, mtimeMs: 1 },
    }),
  );
  const store = GeneratedDocumentStore.of({
    retainRevision,
    resolveRevision,
  } as unknown as GeneratedDocumentStore["Service"]);
  return { store, retainRevision, resolveRevision };
}

function makeBroker(failPresentation = false) {
  const invoke = vi.fn(() =>
    failPresentation
      ? Effect.fail({ _tag: "PreviewAutomationNoAvailableHostError" } as never)
      : Effect.succeed({}),
  );
  const broker = PreviewAutomationBroker.PreviewAutomationBroker.of({
    invoke,
  } as unknown as PreviewAutomationBroker.PreviewAutomationBroker["Service"]);
  return { broker, invoke };
}

function runBuild(
  effect: ReturnType<typeof buildScientLatexForInvocation>,
  input: {
    readonly invocation: AgentInvocationContext.AgentInvocationScope;
    readonly query: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
    readonly resolver?: WorkspaceBindingResolver["Service"];
    readonly builds: LatexBuildService.LatexBuildService["Service"];
    readonly store: GeneratedDocumentStore["Service"];
    readonly broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"];
  },
) {
  return effect.pipe(
    Effect.provideService(AgentInvocationContext.AgentInvocationContext, input.invocation),
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, input.query),
    Effect.provideService(
      WorkspaceBindingResolver,
      input.resolver ?? makeResolverForQuery(input.query),
    ),
    Effect.provideService(LatexBuildService.LatexBuildService, input.builds),
    Effect.provideService(GeneratedDocumentStore, input.store),
    Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, input.broker),
    Effect.provide(NodeServices.layer),
  );
}

async function makeContext(root: string, build: ReturnType<typeof makeBuildService>) {
  const revisionPath = NodePath.join(root, ".revision.pdf");
  await NodeFSP.writeFile(revisionPath, pdfBytes);
  const projectId = ProjectId.make(`project-${NodePath.basename(root)}`);
  const threadId = ThreadId.make(`thread-${NodePath.basename(root)}`);
  const store = makeStore(revisionPath);
  const broker = makeBroker();
  return {
    threadId,
    store,
    broker,
    context: {
      invocation: makeInvocation(threadId),
      query: makeQuery({
        project: makeProject(projectId, root),
        thread: makeThread({ threadId, projectId }),
      }),
      builds: build.service,
      store: store.store,
      broker: broker.broker,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient LaTeX build handler", () => {
  it.effect("joins an active root build and returns a paced retry without re-requesting it", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-join-"));
      yield* Effect.promise(() => writeTex(root));
      yield* Effect.promise(() =>
        writeTex(root, "chapters/results.tex").then((path) =>
          NodeFSP.writeFile(path, "% !TEX root = ../main.tex\nResults\n"),
        ),
      );
      const active = snapshot({ state: "running", rootRelativePath: "main.tex" });
      const builds = makeBuildService({ initial: active });
      const { context } = yield* Effect.promise(() => makeContext(root, builds));

      const result = yield* runBuild(
        buildScientLatexForInvocation(
          { sourcePath: "chapters/results.tex", outputPath: "paper.pdf" },
          { waitBudgetMs: 0, retryAfterMs: 1_750 },
        ),
        context,
      );

      expect(result).toMatchObject({
        status: "in-progress",
        sourcePath: "chapters/results.tex",
        rootSourcePath: "main.tex",
        outputPath: "paper.pdf",
        buildState: "running",
        retryAfterMs: 1_750,
        toolchain: { executable: "latexmk" },
      });
      expect(builds.requestBuild).not.toHaveBeenCalled();
    }),
  );

  it.effect("builds once, then rematerializes the retained revision on repeated calls", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-materialize-"));
      yield* Effect.promise(() => writeTex(root));
      const succeeded = snapshot({
        state: "succeeded",
        descriptor: source,
        startedAtEpochMs: 1,
        finishedAtEpochMs: 2,
      });
      const builds = makeBuildService({ initial: snapshot(), requested: succeeded });
      const { context, store, broker } = yield* Effect.promise(() => makeContext(root, builds));
      const outputPath = NodePath.join(root, defaultInput.outputPath);
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(outputPath, "old output"));

      const first = yield* runBuild(buildScientLatexForInvocation(defaultInput), context);
      yield* Effect.promise(() => NodeFSP.writeFile(outputPath, "tampered output"));
      const second = yield* runBuild(buildScientLatexForInvocation(defaultInput), context);

      expect(first).toMatchObject({
        status: "completed",
        sourcePath: "main.tex",
        rootSourcePath: "main.tex",
        outputPath: "outputs/main.pdf",
        source,
        pageCount: 3,
        byteLength: pdfBytes.byteLength,
        validation: "structural",
        visualReviewPerformed: false,
        toolchain: { executable: "latexmk" },
      });
      expect(second.status).toBe("completed");
      expect(builds.requestBuild).toHaveBeenCalledOnce();
      expect(store.retainRevision).toHaveBeenCalledTimes(2);
      expect(store.resolveRevision).toHaveBeenCalledTimes(2);
      expect(broker.invoke).toHaveBeenCalledTimes(2);
      const written = yield* Effect.promise(() => NodeFSP.readFile(outputPath));
      expect(written).toEqual(Buffer.from(pdfBytes));
    }),
  );

  it.effect("presents the resolved LaTeX root instead of the requested subordinate file", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-present-root-"));
      yield* Effect.promise(() => writeTex(root));
      yield* Effect.promise(() =>
        writeTex(root, "chapters/results.tex").then((path) =>
          NodeFSP.writeFile(path, "% !TEX root = ../main.tex\nResults\n"),
        ),
      );
      const succeeded = snapshot({
        state: "succeeded",
        rootRelativePath: "main.tex",
        descriptor: source,
      });
      const builds = makeBuildService({ initial: succeeded });
      const { context, broker } = yield* Effect.promise(() => makeContext(root, builds));

      const result = yield* runBuild(
        buildScientLatexForInvocation({
          sourcePath: "chapters/results.tex",
          outputPath: "paper.pdf",
        }),
        context,
      );

      expect(result).toMatchObject({
        status: "completed",
        sourcePath: "chapters/results.tex",
        rootSourcePath: "main.tex",
      });
      expect(broker.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "documentLatexPresent",
          input: { sourcePath: "chapters/results.tex", rootSourcePath: "main.tex" },
        }),
      );
    }),
  );

  it.effect("builds an included source from its unique static document root", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-static-root-"));
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "chapters"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "main.tex"),
          String.raw`\documentclass{article}\begin{document}\input{chapters/results}\end{document}`,
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "chapters/results.tex"), "Results."),
      );
      const succeeded = snapshot({
        state: "succeeded",
        rootRelativePath: "main.tex",
        descriptor: source,
      });
      const builds = makeBuildService({ initial: succeeded });
      const { context } = yield* Effect.promise(() => makeContext(root, builds));

      const result = yield* runBuild(
        buildScientLatexForInvocation({
          sourcePath: "chapters/results.tex",
          outputPath: "paper.pdf",
        }),
        context,
      );

      expect(result).toMatchObject({
        status: "completed",
        sourcePath: "chapters/results.tex",
        rootSourcePath: "main.tex",
      });
      const canonicalRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
      expect(builds.resolveDocument).toHaveBeenCalledWith({
        workspaceRoot: canonicalRoot,
        sourceRelativePath: "chapters/results.tex",
      });
      expect(builds.requestBuild).not.toHaveBeenCalled();
    }),
  );

  it.effect("requires a root choice for shared sources and builds the explicit root", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-ambiguous-root-"));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "paper-a.tex"),
          String.raw`\documentclass{article}\begin{document}\input{shared}\end{document}`,
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "paper-b.tex"),
          String.raw`\documentclass{article}\begin{document}\input{shared}\end{document}`,
        ),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "shared.tex"), "Shared."));
      const succeeded = snapshot({
        state: "succeeded",
        rootRelativePath: "paper-a.tex",
        descriptor: source,
      });
      const builds = makeBuildService({ initial: succeeded });
      const { context } = yield* Effect.promise(() => makeContext(root, builds));

      const ambiguous = yield* runBuild(
        buildScientLatexForInvocation({ sourcePath: "shared.tex", outputPath: "paper.pdf" }),
        context,
      ).pipe(Effect.result);
      expect(ambiguous).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ScientLatexBuildToolError",
          code: "build-failed",
          message: expect.stringContaining("multiple documents"),
        },
      });

      const selected = yield* runBuild(
        buildScientLatexForInvocation({
          sourcePath: "shared.tex",
          rootSourcePath: "paper-a.tex",
          outputPath: "paper.pdf",
        }),
        context,
      );
      expect(selected).toMatchObject({
        status: "completed",
        sourcePath: "shared.tex",
        rootSourcePath: "paper-a.tex",
      });
    }),
  );

  it.effect("never commits a revision that changed while its project copy was staged", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-stale-"));
      yield* Effect.promise(() => writeTex(root));
      const succeeded = snapshot({ state: "succeeded", descriptor: source });
      const queued = snapshot({ state: "queued", descriptor: source });
      const builds = makeBuildService({
        initial: succeeded,
        onStatus: (index) => Effect.succeed(index === 0 ? succeeded : queued),
      });
      const { context, broker } = yield* Effect.promise(() => makeContext(root, builds));
      const outputPath = NodePath.join(root, defaultInput.outputPath);
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(outputPath, "previous current output"));

      const result = yield* runBuild(
        buildScientLatexForInvocation(defaultInput, { waitBudgetMs: 0 }),
        context,
      );

      expect(result).toMatchObject({ status: "in-progress", buildState: "queued" });
      expect(yield* Effect.promise(() => NodeFSP.readFile(outputPath, "utf8"))).toBe(
        "previous current output",
      );
      expect(broker.invoke).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects missing authority and projectless invocations before building", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-authority-"));
      yield* Effect.promise(() => writeTex(root));
      const builds = makeBuildService({ initial: snapshot() });
      const { context, threadId } = yield* Effect.promise(() => makeContext(root, builds));

      const denied = yield* runBuild(buildScientLatexForInvocation(defaultInput), {
        ...context,
        invocation: makeInvocation(threadId, new Set()),
      }).pipe(Effect.result);
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ScientLatexBuildToolError", code: "capability-unavailable" },
      });

      const projectless = yield* runBuild(buildScientLatexForInvocation(defaultInput), {
        ...context,
        query: makeQuery({
          project: null,
          thread: makeThread({ threadId, projectId: null }),
        }),
      }).pipe(Effect.result);
      expect(projectless).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ScientLatexBuildToolError", code: "project-required" },
      });
      expect(builds.requestBuild).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects source and output traversal, wrong types, and symlink escapes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-paths-"));
      const outside = yield* Effect.promise(() => fixture("scient-latex-outside-"));
      yield* Effect.promise(() => writeTex(root));
      const outsideTex = yield* Effect.promise(() => writeTex(outside, "outside.tex"));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "notes.txt"), "notes"));
      yield* Effect.promise(() => NodeFSP.symlink(outsideTex, NodePath.join(root, "linked.tex")));
      yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(root, "linked-output")));
      const builds = makeBuildService({ initial: snapshot() });
      const { context } = yield* Effect.promise(() => makeContext(root, builds));

      for (const sourcePath of [outsideTex, "../outside.tex", "notes.txt", "linked.tex"]) {
        const result = yield* runBuild(
          buildScientLatexForInvocation({ ...defaultInput, sourcePath }),
          context,
        ).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ScientLatexBuildToolError", code: "invalid-source-path" },
        });
      }
      for (const outputPath of [
        NodePath.join(outside, "paper.pdf"),
        "../paper.pdf",
        "paper.html",
        "linked-output/paper.pdf",
        "paper.pdf\0ignored",
      ]) {
        const result = yield* runBuild(
          buildScientLatexForInvocation({ ...defaultInput, outputPath }),
          context,
        ).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ScientLatexBuildToolError", code: "invalid-output-path" },
        });
      }
      expect(builds.requestBuild).not.toHaveBeenCalled();
    }),
  );

  it.effect("returns compiler evidence for missing toolchains and fatal LaTeX errors", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-errors-"));
      yield* Effect.promise(() => writeTex(root));
      const unavailable = snapshot({
        state: "failed",
        toolchain: { ...toolchain, kind: null, executable: null, version: null },
        failureSummary: "No LaTeX toolchain found on this computer.",
      });
      const unavailableBuilds = makeBuildService({ initial: unavailable, requested: unavailable });
      const unavailableContext = yield* Effect.promise(() => makeContext(root, unavailableBuilds));
      const noToolchain = yield* runBuild(
        buildScientLatexForInvocation(defaultInput),
        unavailableContext.context,
      ).pipe(Effect.result);
      expect(noToolchain).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ScientLatexBuildToolError",
          code: "toolchain-unavailable",
          rootSourcePath: "main.tex",
        },
      });

      const failed = snapshot({
        state: "failed",
        failureSummary: "LaTeX compilation failed.",
        diagnostics: [
          { severity: "warning", file: "main.tex", line: null, message: "x".repeat(3_000) },
          ...Array.from({ length: 70 }, (_, index) => ({
            severity: "warning" as const,
            file: "main.tex",
            line: index + 1,
            message: `Warning ${index}`,
          })),
          { severity: "error", file: "main.tex", line: 18, message: "Extra \\middle" },
        ],
      });
      const failedBuilds = makeBuildService({ initial: failed, requested: failed });
      const failedContext = yield* Effect.promise(() => makeContext(root, failedBuilds));
      const compileFailure = yield* runBuild(
        buildScientLatexForInvocation(defaultInput),
        failedContext.context,
      ).pipe(Effect.result);
      expect(compileFailure._tag).toBe("Failure");
      if (compileFailure._tag === "Failure") {
        expect(compileFailure.failure).toMatchObject({
          _tag: "ScientLatexBuildToolError",
          code: "build-failed",
        });
        const diagnostics = compileFailure.failure.diagnostics ?? [];
        expect(diagnostics).toHaveLength(64);
        expect(diagnostics[0]).toMatchObject({
          severity: "error",
          message: "Extra \\middle",
        });
        expect(diagnostics[1]?.message).toHaveLength(2_048);
      }
    }),
  );

  it.effect("returns a partial-publication receipt when the project output races", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-output-race-"));
      yield* Effect.promise(() => writeTex(root));
      const succeeded = snapshot({ state: "succeeded", descriptor: source });
      const outputPath = NodePath.join(root, defaultInput.outputPath);
      const builds = makeBuildService({
        initial: succeeded,
        onStatus: (index) =>
          index === 0
            ? Effect.succeed(succeeded)
            : Effect.promise(async () => {
                await NodeFSP.mkdir(outputPath, { recursive: true });
                return succeeded;
              }),
      });
      const { context } = yield* Effect.promise(() => makeContext(root, builds));

      const result = yield* runBuild(buildScientLatexForInvocation(defaultInput), context).pipe(
        Effect.result,
      );

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ScientLatexBuildToolError",
          code: "partial-publication",
          outputPath: "outputs/main.pdf",
          publishedSource: source,
        },
      });
      expect((yield* Effect.promise(() => NodeFSP.stat(outputPath))).isDirectory()).toBe(true);
    }),
  );

  it.effect("refuses project output and presentation when the active worktree changes", () =>
    Effect.gen(function* () {
      const firstRoot = yield* Effect.promise(() => fixture("scient-latex-authority-first-"));
      const secondRoot = yield* Effect.promise(() => fixture("scient-latex-authority-second-"));
      yield* Effect.promise(() => Promise.all([writeTex(firstRoot), writeTex(secondRoot)]));
      const revisionPath = NodePath.join(firstRoot, ".revision.pdf");
      yield* Effect.promise(() => NodeFSP.writeFile(revisionPath, pdfBytes));
      const projectId = ProjectId.make("project-latex-authority-switch");
      const threadId = ThreadId.make("thread-latex-authority-switch");
      let activeThread = makeThread({ threadId, projectId, worktreePath: firstRoot });
      const project = makeProject(projectId, firstRoot);
      const query = makeDynamicQuery({
        thread: (candidate) => (candidate === threadId ? activeThread : null),
        project: (candidate) => (candidate === projectId ? project : null),
      });
      const succeeded = snapshot({ state: "succeeded", descriptor: source });
      const builds = makeBuildService({
        initial: succeeded,
        onStatus: (index) => {
          if (index === 1) {
            activeThread = makeThread({ threadId, projectId, worktreePath: secondRoot });
          }
          return Effect.succeed(succeeded);
        },
      });
      const store = makeStore(revisionPath);
      const broker = makeBroker();

      const result = yield* runBuild(buildScientLatexForInvocation(defaultInput), {
        invocation: makeInvocation(threadId),
        query,
        builds: builds.service,
        store: store.store,
        broker: broker.broker,
      }).pipe(Effect.result);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ScientLatexBuildToolError",
          code: "partial-publication",
          outputPath: defaultInput.outputPath,
          publishedSource: source,
        },
      });
      expect(store.retainRevision).toHaveBeenCalledOnce();
      expect(broker.invoke).not.toHaveBeenCalled();
      yield* Effect.promise(async () => {
        await expect(
          NodeFSP.access(NodePath.join(firstRoot, defaultInput.outputPath)),
        ).rejects.toBeDefined();
        await expect(
          NodeFSP.access(NodePath.join(secondRoot, defaultInput.outputPath)),
        ).rejects.toBeDefined();
      });
    }),
  );

  it.effect("keeps two worktrees of one project on separate LaTeX write authorities", () =>
    Effect.gen(function* () {
      const firstRoot = yield* Effect.promise(() => fixture("scient-latex-worktree-one-"));
      const secondRoot = yield* Effect.promise(() => fixture("scient-latex-worktree-two-"));
      yield* Effect.promise(() => Promise.all([writeTex(firstRoot), writeTex(secondRoot)]));
      const firstRevision = NodePath.join(firstRoot, ".revision.pdf");
      const secondRevision = NodePath.join(secondRoot, ".revision.pdf");
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(firstRevision, pdfBytes),
          NodeFSP.writeFile(secondRevision, pdfBytes),
        ]),
      );
      const projectId = ProjectId.make("project-latex-two-worktrees");
      const firstThreadId = ThreadId.make("thread-latex-worktree-one");
      const secondThreadId = ThreadId.make("thread-latex-worktree-two");
      const project = makeProject(projectId, firstRoot);
      const threads = new Map<ThreadId, OrchestrationThreadShell>([
        [
          firstThreadId,
          makeThread({ threadId: firstThreadId, projectId, worktreePath: firstRoot }),
        ],
        [
          secondThreadId,
          makeThread({ threadId: secondThreadId, projectId, worktreePath: secondRoot }),
        ],
      ]);
      const query = makeDynamicQuery({
        thread: (threadId) => threads.get(threadId) ?? null,
        project: (candidate) => (candidate === projectId ? project : null),
      });
      const succeeded = snapshot({ state: "succeeded", descriptor: source });
      const firstOutput = "outputs/first.pdf";
      const secondOutput = "outputs/second.pdf";

      yield* runBuild(buildScientLatexForInvocation({ ...defaultInput, outputPath: firstOutput }), {
        invocation: makeInvocation(firstThreadId),
        query,
        builds: makeBuildService({ initial: succeeded }).service,
        store: makeStore(firstRevision).store,
        broker: makeBroker().broker,
      });
      yield* runBuild(
        buildScientLatexForInvocation({ ...defaultInput, outputPath: secondOutput }),
        {
          invocation: makeInvocation(secondThreadId),
          query,
          builds: makeBuildService({ initial: succeeded }).service,
          store: makeStore(secondRevision).store,
          broker: makeBroker().broker,
        },
      );

      yield* Effect.promise(async () => {
        await expect(
          NodeFSP.access(NodePath.join(firstRoot, firstOutput)),
        ).resolves.toBeUndefined();
        await expect(
          NodeFSP.access(NodePath.join(secondRoot, secondOutput)),
        ).resolves.toBeUndefined();
        await expect(NodeFSP.access(NodePath.join(firstRoot, secondOutput))).rejects.toBeDefined();
        await expect(NodeFSP.access(NodePath.join(secondRoot, firstOutput))).rejects.toBeDefined();
      });
    }),
  );

  it.effect("keeps publication successful when the PDF cannot be presented", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-latex-presentation-"));
      yield* Effect.promise(() => writeTex(root));
      const succeeded = snapshot({ state: "succeeded", descriptor: source });
      const builds = makeBuildService({ initial: succeeded });
      const built = yield* Effect.promise(() => makeContext(root, builds));
      const broker = makeBroker(true);

      const result = yield* runBuild(buildScientLatexForInvocation(defaultInput), {
        ...built.context,
        broker: broker.broker,
      });

      expect(result).toMatchObject({
        status: "completed",
        warnings: ["presentation-unavailable"],
        visualReviewPerformed: false,
      });
      expect(broker.invoke).toHaveBeenCalledOnce();
    }),
  );
});
