// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { editableMetadataFromRecord } from "@scientfactory/scient-sources";
import {
  readScientSourceRecord,
  SCIENT_SOURCE_RECORDS_DIRECTORY,
} from "@scientfactory/scient-sources/store";
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
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { WorkspaceBindingResolutionError } from "../../../scient/projectScope/WorkspaceBinding.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { AnalyticsService } from "../../../telemetry/AnalyticsService.ts";
import {
  SourceIdentifierLookup,
  verifiableSourceIdentifier,
  type ResolveSourceIdentifier,
} from "../../../scient/sources/SourceIdentifierResolver.ts";
import { SourceIdentifierBatchLookup } from "../../../scient/sources/SourceIdentifierAdd.ts";
import {
  getScientSourceForInvocation,
  listScientSourcesForInvocation,
  addScientSourceForInvocation,
  checkScientSourceForInvocation,
  removeScientSourceForInvocation,
  restoreScientSourceForInvocation,
  revertScientSourceForInvocation,
  attachScientSourcePdfForInvocation,
  detachScientSourcePdfForInvocation,
  exportScientSourcesForInvocation,
  importScientSourcesFileForInvocation,
  resolveScientSourcesProject,
  updateScientSourceNoteForInvocation,
  updateScientSourceForInvocation,
} from "./handlers.ts";

const fixtures: string[] = [];
const now = "2026-08-13T12:00:00.000Z";
const environmentId = EnvironmentId.make("environment-sources-test");
const providerInstanceId = ProviderInstanceId.make("codex");

async function fixture(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

async function writeProjectPdf(root: string, relativePath: string, body: string) {
  const pdfPath = NodePath.join(root, ...relativePath.split("/"));
  await NodeFSP.mkdir(NodePath.dirname(pdfPath), { recursive: true });
  await NodeFSP.writeFile(pdfPath, `%PDF-1.7\n${body}\n`, "utf8");
  return pdfPath;
}

async function writeSource(
  root: string,
  input: {
    readonly sourceId: string;
    readonly title: string;
    readonly abstract?: string | null;
    readonly hasPdf?: boolean;
  },
) {
  const identity = await readScientProjectIdentity(root);
  const record = {
    formatVersion: 1 as const,
    sourceId: input.sourceId,
    projectId: identity.projectId,
    revision: 1,
    type: "article" as const,
    customType: null,
    title: input.title,
    creators: [
      {
        creatorType: "author",
        givenName: "Ada",
        familyName: "Lovelace",
        literalName: null,
      },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: `10.1000/${input.sourceId}` }],
    abstract: input.abstract ?? null,
    containerTitle: "Scient Journal",
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: "en",
    url: null,
    tags: [],
    externalReferences: [],
    attachments:
      input.hasPdf === true
        ? [
            {
              attachmentId: `pdf_${input.sourceId}`,
              kind: "pdf" as const,
              fileName: "paper.pdf",
              mediaType: "application/pdf" as const,
              sha256: "a".repeat(64),
              byteLength: 100,
              relativePath: `files/sha256/aa/${"a".repeat(64)}.pdf`,
              importedAt: now,
            },
          ]
        : [],
    fieldProvenance: [],
    importedAt: now,
  };
  const recordsDirectory = NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY);
  await NodeFSP.mkdir(recordsDirectory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(recordsDirectory, `${input.sourceId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

const makeProject = (projectId: ProjectId, workspaceRoot: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "Scient project",
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
  title: "Sources thread",
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
  pullRequests: [],
});

const makeQuery = (input: {
  readonly thread: OrchestrationThreadShell | null;
  readonly project: OrchestrationProjectShell | null;
}): WorkspaceBindingResolver["Service"] => {
  const resolveThread = Effect.fn("SourcesTest.resolveThread")(function* () {
    if (!input.thread || input.thread.projectId === null)
      return yield* new WorkspaceBindingResolutionError({
        operation: "test-resolve",
        kind: "project-required",
      });
    if (!input.project)
      return yield* new WorkspaceBindingResolutionError({
        operation: "test-resolve",
        kind: "project-not-found",
      });
    const root = input.thread.worktreePath ?? input.project.workspaceRoot;
    const fixture = workspaceResolverForTest(
      new Map([
        [
          root,
          { projectId: input.project.id, scope: workspaceScopeForTest(`binding:${root}`, root) },
        ],
      ]),
    );
    const resolved = yield* fixture.resolveWorkspaceRoot(root);
    return {
      ...resolved,
      binding: { ...resolved.binding, environmentId, hostProjectId: input.project.id },
    };
  });
  return {
    ...workspaceResolverForTest(new Map()),
    resolveThread,
    assertCurrentThreadScope: (scope) =>
      resolveThread().pipe(
        Effect.flatMap((resolved) =>
          resolved.binding.bindingId === scope.bindingId &&
          resolved.binding.authorityGeneration === scope.authorityGeneration
            ? Effect.succeed(resolved.binding)
            : Effect.fail(
                new WorkspaceBindingResolutionError({
                  operation: "test-assert",
                  kind: "stale-authority",
                }),
              ),
        ),
      ),
  };
};

const makeInvocation = (
  threadId: ThreadId,
  capabilities: ReadonlySet<AgentInvocationContext.OperationCapability> = new Set([
    "sources:read",
    "sources:write",
  ]),
) =>
  AgentInvocationContext.AgentInvocationContext.of({
    environmentId,
    threadId,
    providerSessionId: "session-sources-test",
    providerInstanceId,
    capabilities,
    issuedAt: 1,
  });

const offlineLookup: ResolveSourceIdentifier = async (identifiers) => {
  const identifier = verifiableSourceIdentifier(identifiers);
  return identifier ? { status: "unavailable", identifier } : null;
};

const provideContext = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly invocation: AgentInvocationContext.AgentInvocationScope;
    readonly query: WorkspaceBindingResolver["Service"];
    readonly lookup?: ResolveSourceIdentifier;
  },
) =>
  effect.pipe(
    Effect.provideService(AgentInvocationContext.AgentInvocationContext, input.invocation),
    Effect.provideService(WorkspaceBindingResolver, input.query),
    Effect.provideService(SourceIdentifierLookup, input.lookup ?? offlineLookup),
  );

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient Sources MCP handlers", () => {
  it.effect("resolves the current project on every call and prefers its active worktree", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* Effect.promise(() => fixture("scient-sources-workspace-"));
      const worktreeRoot = yield* Effect.promise(() => fixture("scient-sources-worktree-"));
      yield* Effect.promise(() =>
        writeSource(workspaceRoot, { sourceId: "source_workspace", title: "Workspace source" }),
      );
      yield* Effect.promise(() =>
        writeSource(worktreeRoot, { sourceId: "source_worktree", title: "Worktree source" }),
      );
      const projectId = ProjectId.make("project-sources");
      const threadId = ThreadId.make("thread-sources");
      const project = makeProject(projectId, workspaceRoot);
      const thread = makeThread({ threadId, projectId, worktreePath: worktreeRoot });
      const query = makeQuery({ project, thread });
      const invocation = makeInvocation(threadId);

      const resolved = yield* provideContext(resolveScientSourcesProject(), {
        invocation,
        query,
      });
      expect(resolved).toEqual({ projectId, root: worktreeRoot });

      const listed = yield* provideContext(listScientSourcesForInvocation({}), {
        invocation,
        query,
      });
      expect(listed.records.map((record) => record.sourceId)).toEqual(["source_worktree"]);
    }),
  );

  it.effect("rejects a legacy projectless thread", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-legacy-projectless");
      const thread = makeThread({ threadId, projectId: null });
      const query = makeQuery({ project: null, thread });
      const projectlessThread = yield* provideContext(resolveScientSourcesProject(), {
        invocation: makeInvocation(threadId),
        query,
      }).pipe(Effect.result);
      expect(projectlessThread._tag).toBe("Failure");
      if (projectlessThread._tag === "Failure") {
        expect(projectlessThread.failure.code).toBe("project-required");
      }
    }),
  );

  it.effect("returns no more than 50 summaries and exposes explicit pagination", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-bounded-"));
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 55 }, (_, index) =>
            writeSource(root, {
              sourceId: `source_${String(index).padStart(2, "0")}`,
              title: `Bounded source ${index}`,
              hasPdf: index === 0,
            }),
          ),
        ),
      );
      const projectId = ProjectId.make("project-bounded");
      const threadId = ThreadId.make("thread-bounded");
      const project = makeProject(projectId, root);
      const thread = makeThread({ threadId, projectId });
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({ project, thread }),
      };

      const firstPage = yield* provideContext(
        listScientSourcesForInvocation({ limit: 50 }),
        context,
      );
      expect(firstPage.records).toHaveLength(50);
      expect(firstPage.total).toBe(55);
      expect(firstPage.nextOffset).toBe(50);

      const secondPage = yield* provideContext(
        listScientSourcesForInvocation({ limit: 50, offset: firstPage.nextOffset ?? 0 }),
        context,
      );
      expect(secondPage.records).toHaveLength(5);
      expect(secondPage.nextOffset).toBeNull();
    }),
  );

  it.effect("does not read a source from another project or reveal host paths", () =>
    Effect.gen(function* () {
      const firstRoot = yield* Effect.promise(() => fixture("scient-sources-first-"));
      const secondRoot = yield* Effect.promise(() => fixture("scient-sources-second-"));
      yield* Effect.promise(() =>
        writeSource(firstRoot, {
          sourceId: "source_first",
          title: "First source",
          abstract: "a".repeat(50_010),
          hasPdf: true,
        }),
      );
      yield* Effect.promise(() =>
        writeSource(secondRoot, { sourceId: "source_second", title: "Second source" }),
      );
      const projectId = ProjectId.make("project-first");
      const threadId = ThreadId.make("thread-first");
      const project = makeProject(projectId, firstRoot);
      const thread = makeThread({ threadId, projectId });
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({ project, thread }),
      };

      const detail = yield* provideContext(
        getScientSourceForInvocation({ sourceId: "source_first" }),
        context,
      );
      expect(detail.abstract).toHaveLength(50_000);
      expect(detail.abstractTruncated).toBe(true);
      expect(detail.attachments).toHaveLength(1);
      expect(detail.attachments[0]).not.toHaveProperty("relativePath");

      const crossProject = yield* provideContext(
        getScientSourceForInvocation({ sourceId: "source_second" }),
        context,
      ).pipe(Effect.result);
      expect(crossProject._tag).toBe("Failure");
      if (crossProject._tag === "Failure") expect(crossProject.failure.code).toBe("not-found");
    }),
  );

  it.effect("updates the canonical project note with optimistic revision safety", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-note-"));
      yield* Effect.promise(() =>
        writeSource(root, { sourceId: "source_note", title: "Noteworthy source" }),
      );
      const projectId = ProjectId.make("project-note");
      const threadId = ThreadId.make("thread-note");
      const project = makeProject(projectId, root);
      const thread = makeThread({ threadId, projectId });
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({ project, thread }),
      };

      const updated = yield* provideContext(
        updateScientSourceNoteForInvocation({
          sourceId: "source_note",
          expectedRevision: 1,
          note: "Compare with the **replication** cohort.",
        }),
        context,
      );
      expect(updated).toEqual({
        outcome: "updated",
        sourceId: "source_note",
        revision: 2,
        note: "Compare with the **replication** cohort.",
      });

      const detail = yield* provideContext(
        getScientSourceForInvocation({ sourceId: "source_note" }),
        context,
      );
      expect(detail.note).toBe("Compare with the **replication** cohort.");
      expect(detail.updatedBy).toBe("agent");

      const stale = yield* provideContext(
        updateScientSourceNoteForInvocation({
          sourceId: "source_note",
          expectedRevision: 1,
          note: "Do not overwrite the newer note.",
        }),
        context,
      );
      expect(stale).toEqual({ ...updated, outcome: "stale" });
    }),
  );

  it.effect("checks a source's identifier and credits the agent", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-check-"));
      yield* Effect.promise(() => writeSource(root, { sourceId: "source_check", title: "Check" }));
      const projectId = ProjectId.make("project-check");
      const threadId = ThreadId.make("thread-check");
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };
      const checked = yield* provideContext(
        checkScientSourceForInvocation({ sourceId: "source_check" }),
        context,
      );
      expect(checked).toMatchObject({
        outcome: "updated",
        revision: 2,
        registry: "unavailable",
        verification: { state: "unchecked", identifier: { scheme: "doi" } },
      });
      const record = yield* Effect.promise(() => readScientSourceRecord(root, "source_check"));
      expect(record?.updatedBy).toBe("agent");
    }),
  );

  it.effect("moves an agent removal to the trash, restores it, and reverts an edit", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-trash-"));
      yield* Effect.promise(() => writeSource(root, { sourceId: "source_kept", title: "Kept" }));
      const projectId = ProjectId.make("project-trash");
      const threadId = ThreadId.make("thread-trash");
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };

      const removed = yield* provideContext(
        removeScientSourceForInvocation({ sourceId: "source_kept", expectedRevision: 1 }),
        context,
      );
      expect(removed).toEqual({
        outcome: "removed",
        sourceId: "source_kept",
        revision: 1,
        restorable: true,
      });
      const trash = yield* provideContext(
        listScientSourcesForInvocation({ inTrash: true }),
        context,
      );
      expect(trash.records).toMatchObject([
        { sourceId: "source_kept", revision: 1, removedBy: "agent" },
      ]);
      expect((yield* provideContext(listScientSourcesForInvocation({}), context)).records).toEqual(
        [],
      );

      const restored = yield* provideContext(
        restoreScientSourceForInvocation({ sourceId: "source_kept" }),
        context,
      );
      expect(restored).toEqual({
        outcome: "restored",
        sourceId: "source_kept",
        revision: 2,
        matchingSourceIds: [],
      });

      const stored = yield* Effect.promise(() => readScientSourceRecord(root, "source_kept"));
      if (!stored) throw new Error("Expected the restored source.");
      const edited = yield* provideContext(
        updateScientSourceForInvocation({
          sourceId: "source_kept",
          expectedRevision: stored.revision,
          metadata: { ...editableMetadataFromRecord(stored), title: "Wrong" },
        }),
        context,
      );
      expect(edited.outcome).toBe("updated");
      const history = yield* provideContext(
        getScientSourceForInvocation({ sourceId: "source_kept" }),
        context,
      );
      expect(
        history.revisions.map(({ revision, savedBy, changes }) => ({ revision, savedBy, changes })),
      ).toEqual([
        { revision: 3, savedBy: "agent", changes: ["title"] },
        { revision: 2, savedBy: "agent", changes: [] },
        { revision: 1, savedBy: "user", changes: [] },
      ]);
      const reverted = yield* provideContext(
        revertScientSourceForInvocation({
          sourceId: "source_kept",
          expectedRevision: 3,
          toRevision: 2,
        }),
        context,
      );
      expect(reverted).toMatchObject({ outcome: "reverted", revision: 4 });
      const back = yield* provideContext(
        getScientSourceForInvocation({ sourceId: "source_kept" }),
        context,
      );
      expect(back).toMatchObject({ title: "Kept", updatedBy: "agent" });

      yield* provideContext(
        removeScientSourceForInvocation({ sourceId: "source_kept", expectedRevision: 4 }),
        context,
      );
      expect(
        yield* provideContext(
          removeScientSourceForInvocation({
            sourceId: "source_kept",
            expectedRevision: 3,
            permanent: true,
          }),
          context,
        ),
      ).toMatchObject({ outcome: "stale", revision: 4 });
      expect(
        yield* provideContext(
          removeScientSourceForInvocation({
            sourceId: "source_kept",
            expectedRevision: 4,
            permanent: true,
          }),
          context,
        ),
      ).toEqual({ outcome: "deleted", sourceId: "source_kept", revision: null });
      expect(
        (yield* provideContext(listScientSourcesForInvocation({ inTrash: true }), context)).records,
      ).toEqual([]);
    }),
  );

  it.effect("adds an idempotent metadata-only agent source with agent provenance", () =>
    Effect.gen(function* () {
      const events: { name: string; properties: Readonly<Record<string, unknown>> | undefined }[] =
        [];
      const analytics = AnalyticsService.of({
        recordOwners: () => Effect.void,
        record: (name, properties) =>
          Effect.sync(() => {
            events.push({ name, properties });
          }),
        status: Effect.succeed({ available: true, consent: "product" }),
        collectionEpoch: Effect.succeed(0),
        flush: Effect.void,
      });
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-add-"));
      const projectId = ProjectId.make("project-agent-add");
      const threadId = ThreadId.make("thread-agent-add");
      const project = makeProject(projectId, root);
      const thread = makeThread({ threadId, projectId });
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({ project, thread }),
      };
      const input = {
        type: "article" as const,
        customType: null,
        title: "A Deterministic Agent Source",
        creators: [
          {
            creatorType: "author",
            givenName: "Ada",
            familyName: "Lovelace",
            literalName: null,
          },
        ],
        issuedRaw: "2026",
        issuedYear: 2026,
        identifiers: [{ scheme: "doi", value: "10.1000/agent-source" }],
        abstract: "A source added from the current research conversation.",
        abstractSections: [{ title: "Summary", paragraphs: ["A structured summary."] }],
        containerTitle: "Scient Journal",
        publisher: null,
        volume: null,
        issue: null,
        pages: null,
        language: "en",
        url: "https://doi.org/10.1000/agent-source",
        tags: ["agent-added", "review"],
        enrich: false,
        allowPossibleMetadataMatch: false,
      };
      const added = yield* provideContext(addScientSourceForInvocation(input), context).pipe(
        Effect.provideService(AnalyticsService, analytics),
      );
      expect(added).toMatchObject({ outcome: "imported", verification: "unchecked" });
      expect(added.sourceId).toMatch(/^source_/);
      expect(added.revision).toBe(1);
      expect(added.validationIssues).toEqual([]);

      const repeated = yield* provideContext(addScientSourceForInvocation(input), context).pipe(
        Effect.provideService(AnalyticsService, analytics),
      );
      expect(repeated.outcome).toBe("duplicate");
      expect(repeated.sourceId).toBe(added.sourceId);
      expect(repeated.revision).toBe(1);
      expect(repeated.duplicate.kind).toBe("same-identifier");
      expect(events.map((event) => event.name)).toEqual([
        "scient.operation.started",
        "scient.operation.completed",
        "scient.operation.started",
        "scient.operation.skipped",
      ]);
      expect(events[1]?.properties).toMatchObject({
        operationKind: "source-import",
        trigger: "agent",
      });
      expect(
        events.flatMap((event) => Object.values(event.properties ?? {})).join(" "),
      ).not.toMatch(/Deterministic|10\.1000|Ada|source_|project-agent|thread-agent/u);

      const detail = yield* provideContext(
        getScientSourceForInvocation({ sourceId: added.sourceId ?? "" }),
        context,
      );
      expect(detail.origin).toMatchObject({
        actor: "agent",
        intake: "identifier",
        review: "none",
      });
      expect(detail.fieldProvenance.some((entry) => entry.origin === "agent")).toBe(true);
      expect(detail.fieldProvenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "abstractSections", origin: "agent" }),
        ]),
      );
      expect(detail.attachments).toEqual([]);

      const updated = yield* provideContext(
        updateScientSourceForInvocation({
          sourceId: detail.sourceId,
          expectedRevision: detail.revision,
          metadata: {
            type: detail.type,
            customType: detail.customType ?? null,
            title: "A Corrected Agent Source",
            creators: detail.creators,
            issuedRaw: detail.issuedRaw,
            issuedYear: detail.issuedYear,
            identifiers: detail.identifiers,
            abstract: detail.abstract,
            containerTitle: detail.containerTitle,
            publisher: detail.publisher,
            volume: detail.volume,
            issue: detail.issue,
            pages: detail.pages,
            language: detail.language,
            url: detail.url,
            tags: [...detail.tags, "corrected"],
          },
          allowPossibleMetadataMatch: false,
        }),
        context,
      );
      expect(updated).toMatchObject({
        outcome: "updated",
        sourceId: detail.sourceId,
        revision: 2,
        validationIssues: [],
      });
      const edited = yield* provideContext(
        getScientSourceForInvocation({ sourceId: detail.sourceId }),
        context,
      );
      expect(edited.updatedBy).toBe("agent");
      expect(edited.fieldProvenance).toEqual(
        expect.arrayContaining([{ field: "title", origin: "agent", sourceField: null }]),
      );
      expect(edited.verification).toEqual(detail.verification);
    }),
  );

  it.effect("adds a mixed identifier list as separate agent sources and reports each entry", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-batch-"));
      const projectId = ProjectId.make("project-agent-batch");
      const threadId = ThreadId.make("thread-agent-batch");
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };
      const added = yield* provideContext(
        addScientSourceForInvocation({
          identifierList: ["10.1000/batch.1", "arXiv:1706.03762", "not an identifier"],
        }),
        context,
      ).pipe(
        Effect.provideService(SourceIdentifierBatchLookup, async (identifiers) =>
          identifiers.map((identifier) =>
            identifier.scheme === "doi"
              ? {
                  status: "found" as const,
                  identifier,
                  retrievedAt: "2026-11-10T12:00:00.000Z",
                  metadata: {
                    type: "article" as const,
                    title: "Batch article",
                    creators: [],
                    issuedRaw: "2024",
                    issuedYear: 2024,
                    identifiers: [identifier],
                    abstract: null,
                    abstractSections: [],
                    containerTitle: null,
                    publisher: null,
                    volume: null,
                    issue: null,
                    pages: null,
                    language: null,
                    url: null,
                  },
                }
              : { status: "not-found" as const, identifier },
          ),
        ),
      );

      expect(added).toMatchObject({
        outcome: "batch",
        message: "Added 1 of 3. 1 not found. 1 not an identifier.",
        results: [
          { input: "10.1000/batch.1", outcome: "imported", verification: "verified" },
          { input: "arXiv:1706.03762", outcome: "identifier-not-found" },
          { input: "not an identifier", outcome: "unrecognized" },
        ],
      });
      const listed = yield* provideContext(listScientSourcesForInvocation({}), context);
      expect(listed.records).toMatchObject([{ title: "Batch article", addedBy: "agent" }]);

      const mixed = yield* provideContext(
        addScientSourceForInvocation({ identifierList: ["10.1000/batch.2"], title: "Other" }),
        context,
      );
      expect(mixed).toMatchObject({ outcome: "invalid", validationIssues: [{ field: "title" }] });
    }),
  );

  it.effect("adds and attaches a project-relative agent PDF without exposing its path", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-pdf-"));
      const pdfPath = NodePath.join(root, "reference_ledger", "agent-paper.pdf");
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(pdfPath), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(pdfPath, "%PDF-1.7\nagent\n", "utf8"));
      const projectId = ProjectId.make("project-agent-pdf");
      const threadId = ThreadId.make("thread-agent-pdf");
      const project = makeProject(projectId, root);
      const thread = makeThread({ threadId, projectId });
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({ project, thread }),
      };
      const added = yield* provideContext(
        addScientSourceForInvocation({
          type: "article",
          customType: null,
          title: "Agent PDF source",
          creators: [
            {
              creatorType: "author",
              givenName: "Ada",
              familyName: "Lovelace",
              literalName: null,
            },
          ],
          issuedRaw: "2026",
          issuedYear: 2026,
          identifiers: [{ scheme: "doi", value: "10.1000/agent-pdf" }],
          abstract: null,
          containerTitle: null,
          publisher: null,
          volume: null,
          issue: null,
          pages: null,
          language: null,
          url: null,
          tags: [],
          pdfRelativePath: "reference_ledger/agent-paper.pdf",
          enrich: false,
          allowPossibleMetadataMatch: false,
        }),
        context,
      );
      expect(added).toMatchObject({ outcome: "imported", verification: "unchecked", revision: 1 });
      const detail = yield* provideContext(
        getScientSourceForInvocation({ sourceId: added.sourceId ?? "" }),
        context,
      );
      expect(detail.origin).toMatchObject({ actor: "agent", intake: "local-pdf" });
      expect(detail.attachments).toMatchObject([
        { fileName: "agent-paper.pdf", mediaType: "application/pdf" },
      ]);
      expect(detail.attachments[0]).not.toHaveProperty("relativePath");

      const attachedAgain = yield* provideContext(
        attachScientSourcePdfForInvocation({
          sourceId: detail.sourceId,
          expectedRevision: detail.revision,
          pdfRelativePath: "reference_ledger/agent-paper.pdf",
        }),
        context,
      );
      expect(attachedAgain).toEqual({
        outcome: "unchanged",
        sourceId: detail.sourceId,
        revision: detail.revision,
      });
      const stale = yield* provideContext(
        attachScientSourcePdfForInvocation({
          sourceId: detail.sourceId,
          expectedRevision: detail.revision + 9,
          pdfRelativePath: "reference_ledger/agent-paper.pdf",
        }),
        context,
      );
      expect(stale).toEqual({
        outcome: "stale",
        sourceId: detail.sourceId,
        revision: detail.revision,
      });
      const detached = yield* provideContext(
        detachScientSourcePdfForInvocation({
          sourceId: detail.sourceId,
          attachmentId: detail.attachments[0]?.attachmentId ?? "",
          expectedRevision: detail.revision,
        }),
        context,
      );
      expect(detached).toMatchObject({
        outcome: "removed",
        sourceId: detail.sourceId,
        revision: detail.revision + 1,
      });
      expect(detached).not.toHaveProperty("removedAttachmentCount");
    }),
  );

  it.effect("adds a project PDF without fabricated citation metadata", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-pdf-only-"));
      const pdfPath = NodePath.join(root, "papers", "untitled.pdf");
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(pdfPath), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(pdfPath, "%PDF-1.7\nagent\n", "utf8"));
      const projectId = ProjectId.make("project-agent-pdf-only");
      const threadId = ThreadId.make("thread-agent-pdf-only");
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };
      const added = yield* provideContext(
        addScientSourceForInvocation({ pdfRelativePath: "papers/untitled.pdf" }),
        context,
      );
      expect(added).toMatchObject({ outcome: "imported", verification: "unverified", revision: 1 });
    }),
  );

  it.effect("verifies a PDF's DOI without treating its filename title as a claim", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-pdf-doi-"));
      yield* Effect.promise(() => writeProjectPdf(root, "papers/paper_final.pdf", "file-doi"));
      const projectId = ProjectId.make("project-agent-pdf-doi");
      const threadId = ThreadId.make("thread-agent-pdf-doi");
      const identifier = { scheme: "doi", value: "10.1000/registered-pdf" };
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
        lookup: (async () => ({
          status: "found",
          identifier,
          retrievedAt: now,
          metadata: {
            type: "article",
            title: "Registered Title of the Work",
            creators: [],
            issuedRaw: null,
            issuedYear: null,
            identifiers: [identifier],
            abstract: null,
            abstractSections: [],
            containerTitle: null,
            publisher: null,
            volume: null,
            issue: null,
            pages: null,
            language: null,
            url: null,
          },
        })) satisfies ResolveSourceIdentifier,
      };
      const added = yield* provideContext(
        addScientSourceForInvocation({
          pdfRelativePath: "papers/paper_final.pdf",
          identifiers: [identifier],
        }),
        context,
      );
      expect(added).toMatchObject({ outcome: "imported", verification: "verified" });
      const detail = yield* provideContext(
        getScientSourceForInvocation({ sourceId: added.sourceId ?? "" }),
        context,
      );
      expect(detail.title).toBe("Registered Title of the Work");
    }),
  );

  it.effect("treats distinct PDFs that share a filename as separate sources", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-pdf-identity-"));
      yield* Effect.promise(() =>
        Promise.all([
          writeProjectPdf(root, "a/paper.pdf", "file-a"),
          writeProjectPdf(root, "b/paper.pdf", "file-b"),
        ]),
      );
      const projectId = ProjectId.make("project-agent-pdf-identity");
      const threadId = ThreadId.make("thread-agent-pdf-identity");
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };
      const first = yield* provideContext(
        addScientSourceForInvocation({ pdfRelativePath: "a/paper.pdf" }),
        context,
      );
      const second = yield* provideContext(
        addScientSourceForInvocation({ pdfRelativePath: "b/paper.pdf" }),
        context,
      );
      const repeated = yield* provideContext(
        addScientSourceForInvocation({ pdfRelativePath: "a/paper.pdf" }),
        context,
      );
      expect(first.outcome).toBe("imported");
      expect(second.outcome).toBe("imported");
      expect(first.sourceId).toBeTruthy();
      expect(second.sourceId).toBeTruthy();
      expect(second.sourceId).not.toBe(first.sourceId);
      expect(repeated).toMatchObject({
        outcome: "duplicate",
        sourceId: first.sourceId,
        duplicate: { kind: "same-pdf" },
      });
      const listed = yield* provideContext(listScientSourcesForInvocation({}), context);
      expect(listed.total).toBe(2);
      const originals = yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.readFile(NodePath.join(root, "a", "paper.pdf"), "utf8"),
          NodeFSP.readFile(NodePath.join(root, "b", "paper.pdf"), "utf8"),
        ]),
      );
      expect(originals).toEqual(["%PDF-1.7\nfile-a\n", "%PDF-1.7\nfile-b\n"]);
    }),
  );

  it.effect("collapses identical PDF bytes and the same DOI even when paths differ", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-pdf-collapse-"));
      yield* Effect.promise(() =>
        Promise.all([
          writeProjectPdf(root, "a/paper.pdf", "same-bytes"),
          writeProjectPdf(root, "b/paper.pdf", "same-bytes"),
          writeProjectPdf(root, "d/paper.pdf", "doi-a"),
          writeProjectPdf(root, "e/paper.pdf", "doi-b"),
        ]),
      );
      const projectId = ProjectId.make("project-agent-pdf-collapse");
      const threadId = ThreadId.make("thread-agent-pdf-collapse");
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };
      const firstCopy = yield* provideContext(
        addScientSourceForInvocation({ pdfRelativePath: "a/paper.pdf" }),
        context,
      );
      const secondCopy = yield* provideContext(
        addScientSourceForInvocation({ pdfRelativePath: "b/paper.pdf" }),
        context,
      );
      expect(firstCopy.outcome).toBe("imported");
      expect(secondCopy).toMatchObject({
        outcome: "duplicate",
        sourceId: firstCopy.sourceId,
        duplicate: { kind: "same-pdf" },
      });

      const doi = { scheme: "doi" as const, value: "10.1000/shared-pdf-work" };
      const firstDoi = yield* provideContext(
        addScientSourceForInvocation({
          identifiers: [doi],
          pdfRelativePath: "d/paper.pdf",
        }),
        context,
      );
      const secondDoi = yield* provideContext(
        addScientSourceForInvocation({
          identifiers: [doi],
          pdfRelativePath: "e/paper.pdf",
        }),
        context,
      );
      expect(firstDoi.outcome).toBe("imported");
      expect(secondDoi).toMatchObject({
        outcome: "duplicate",
        sourceId: firstDoi.sourceId,
        duplicate: { kind: "same-identifier" },
      });
      expect(firstDoi.sourceId).not.toBe(firstCopy.sourceId);

      const listed = yield* provideContext(listScientSourcesForInvocation({}), context);
      expect(listed.total).toBe(2);
    }),
  );

  it.effect("imports concurrent distinct PDFs and reuses a blob when attaching later", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-pdf-stress-"));
      const relativePaths = ["w/paper.pdf", "x/paper.pdf", "y/paper.pdf", "z/paper.pdf"] as const;
      yield* Effect.promise(() =>
        Promise.all(
          relativePaths.map((relativePath, index) =>
            writeProjectPdf(root, relativePath, `concurrent-${index}`),
          ),
        ),
      );
      const projectId = ProjectId.make("project-agent-pdf-stress");
      const threadId = ThreadId.make("thread-agent-pdf-stress");
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };
      const concurrent = yield* Effect.all(
        [
          provideContext(
            addScientSourceForInvocation({ pdfRelativePath: relativePaths[0] }),
            context,
          ),
          provideContext(
            addScientSourceForInvocation({ pdfRelativePath: relativePaths[1] }),
            context,
          ),
          provideContext(
            addScientSourceForInvocation({ pdfRelativePath: relativePaths[2] }),
            context,
          ),
          provideContext(
            addScientSourceForInvocation({ pdfRelativePath: relativePaths[3] }),
            context,
          ),
          provideContext(
            addScientSourceForInvocation({ pdfRelativePath: relativePaths[0] }),
            context,
          ),
        ],
        { concurrency: "unbounded" },
      );
      const [firstPath, secondPath, thirdPath, fourthPath, firstPathAgain] = concurrent;
      expect([secondPath.outcome, thirdPath.outcome, fourthPath.outcome]).toEqual([
        "imported",
        "imported",
        "imported",
      ]);
      expect([firstPath.outcome, firstPathAgain.outcome].toSorted()).toEqual([
        "duplicate",
        "imported",
      ]);
      const imported = concurrent.filter((result) => result.outcome === "imported");
      expect(imported).toHaveLength(4);
      expect(new Set(imported.map((result) => result.sourceId)).size).toBe(4);
      const firstImported = firstPath.outcome === "imported" ? firstPath : firstPathAgain;
      expect(firstImported.outcome).toBe("imported");

      const metadata = yield* provideContext(
        addScientSourceForInvocation({
          type: "article",
          title: "Metadata-only companion",
          creators: [
            {
              creatorType: "author",
              givenName: "Ada",
              familyName: "Lovelace",
              literalName: null,
            },
          ],
          issuedRaw: "2026",
          issuedYear: 2026,
          identifiers: [{ scheme: "doi", value: "10.1000/companion" }],
        }),
        context,
      );
      expect(metadata.outcome).toBe("imported");
      const pdfSource = yield* provideContext(
        getScientSourceForInvocation({ sourceId: firstImported.sourceId ?? "" }),
        context,
      );
      const attached = yield* provideContext(
        attachScientSourcePdfForInvocation({
          sourceId: metadata.sourceId ?? "",
          expectedRevision: metadata.revision ?? 1,
          pdfRelativePath: relativePaths[0],
        }),
        context,
      );
      expect(attached).toEqual({
        outcome: "attached",
        sourceId: metadata.sourceId,
        revision: (metadata.revision ?? 1) + 1,
      });
      const companion = yield* provideContext(
        getScientSourceForInvocation({ sourceId: metadata.sourceId ?? "" }),
        context,
      );
      expect(companion.attachments[0]?.sha256).toBe(pdfSource.attachments[0]?.sha256);
      expect(companion.attachments[0]?.attachmentId).not.toBe(
        pdfSource.attachments[0]?.attachmentId,
      );
    }),
  );

  it.effect("checks an agent's DOI and stores the registry's metadata", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-verified-"));
      const projectId = ProjectId.make("project-agent-verified");
      const threadId = ThreadId.make("thread-agent-verified");
      const identifier = { scheme: "doi", value: "10.1000/registered" };
      const lookup: ResolveSourceIdentifier = async () => ({
        status: "found",
        identifier,
        retrievedAt: now,
        metadata: {
          type: "article",
          title: "Registered Title of the Work",
          creators: [
            { creatorType: "author", givenName: "Grace", familyName: "Hopper", literalName: null },
          ],
          issuedRaw: "1952-05-01",
          issuedYear: 1952,
          identifiers: [identifier],
          abstract: null,
          abstractSections: [],
          containerTitle: "Registry Journal",
          publisher: null,
          volume: "7",
          issue: null,
          pages: null,
          language: null,
          url: "https://doi.org/10.1000/registered",
        },
      });
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
        lookup,
      };
      const claim = {
        type: "article" as const,
        creators: [
          { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
        ],
        issuedYear: 2026,
        identifiers: [identifier],
      };

      const mismatch = yield* provideContext(
        addScientSourceForInvocation({ ...claim, title: "An Unrelated Paper About Rivers" }),
        context,
      );
      expect(mismatch).toMatchObject({
        outcome: "identifier-mismatch",
        sourceId: null,
        revision: null,
        resolved: {
          title: "Registered Title of the Work",
          creators: ["Grace Hopper"],
          issuedYear: 1952,
          containerTitle: "Registry Journal",
        },
        message: expect.stringContaining("10.1000/registered"),
      });
      expect((yield* provideContext(listScientSourcesForInvocation({}), context)).total).toBe(0);

      const added = yield* provideContext(
        addScientSourceForInvocation({ ...claim, title: "registered title of the work" }),
        context,
      );
      expect(added).toMatchObject({ outcome: "imported", verification: "verified" });
      const detail = yield* provideContext(
        getScientSourceForInvocation({ sourceId: added.sourceId ?? "" }),
        context,
      );
      expect(detail).toMatchObject({
        title: "Registered Title of the Work",
        creators: [{ familyName: "Hopper" }],
        issuedYear: 1952,
        containerTitle: "Registry Journal",
        verification: { state: "verified", identifier, checkedAt: now },
      });
      expect(detail.fieldProvenance).toEqual(
        expect.arrayContaining([
          {
            field: "title",
            origin: "doi",
            sourceField: "title",
            sourceIdentifier: identifier,
            retrievedAt: now,
          },
        ]),
      );
    }),
  );

  it.effect("rejects agent source metadata without a usable identity", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-invalid-"));
      const projectId = ProjectId.make("project-agent-invalid");
      const threadId = ThreadId.make("thread-agent-invalid");
      const project = makeProject(projectId, root);
      const thread = makeThread({ threadId, projectId });
      const result = yield* provideContext(
        addScientSourceForInvocation({
          type: "article",
          customType: null,
          title: null,
          creators: [],
          issuedRaw: null,
          issuedYear: null,
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
          enrich: false,
          allowPossibleMetadataMatch: false,
        }),
        { invocation: makeInvocation(threadId), query: makeQuery({ project, thread }) },
      );
      expect(result.outcome).toBe("invalid");
      expect(result.sourceId).toBeNull();
      expect(result.validationIssues.some((issue) => issue.field === "identity")).toBe(true);
    }),
  );

  it.effect("imports a project reference file as the agent and exports the Library back", () =>
    Effect.gen(function* () {
      const analytics = AnalyticsService.of({
        recordOwners: () => Effect.void,
        record: () => Effect.void,
        status: Effect.succeed({ available: true, consent: "product" }),
        collectionEpoch: Effect.succeed(0),
        flush: Effect.void,
      });
      const root = yield* Effect.promise(() => fixture("scient-sources-agent-file-"));
      const projectId = ProjectId.make("project-agent-file");
      const threadId = ThreadId.make("thread-agent-file");
      const context = {
        invocation: makeInvocation(threadId),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "refs.ris"),
          [
            "TY  - JOUR",
            "ID  - rossi2020sleep",
            "TI  - Sleep and memory",
            "AU  - Rossi, Giulia",
            "PY  - 2020",
            "DO  - 10.1000/sleep.1",
            "CY  - Boston",
            "ER  - ",
            "",
          ].join("\n"),
        ),
      );
      const imported = yield* provideContext(
        importScientSourcesFileForInvocation({ relativePath: "refs.ris" }),
        context,
      ).pipe(Effect.provideService(AnalyticsService, analytics));
      expect(imported).toMatchObject({
        format: "ris",
        importedCount: 1,
        imported: [{ citationKey: "rossi2020sleep" }],
        alreadyInLibrary: 0,
        remaining: 0,
        notKept: [{ field: "CY", entryCount: 1, citationKeys: ["rossi2020sleep"] }],
      });
      const listed = yield* provideContext(listScientSourcesForInvocation({}), context);
      expect(listed.records[0]).toMatchObject({ addedBy: "agent", verification: "unchecked" });

      const missing = yield* provideContext(
        importScientSourcesFileForInvocation({ relativePath: "absent.bib" }),
        context,
      ).pipe(Effect.provideService(AnalyticsService, analytics), Effect.flip);
      expect(missing.message).toBe("The reference file absent.bib was not found.");

      const exported = yield* provideContext(
        exportScientSourcesForInvocation({ relativePath: "library.bib", format: "bibtex" }),
        context,
      );
      expect(exported).toEqual({
        outcome: "written",
        relativePath: "library.bib",
        sourceCount: 1,
        missingSourceIds: [],
      });
      const written = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "library.bib"), "utf8"),
      );
      expect(written).toContain("@article{rossi2020sleep,");
      const again = yield* provideContext(
        exportScientSourcesForInvocation({ relativePath: "library.bib", format: "bibtex" }),
        context,
      );
      expect(again.outcome).toBe("exists");
    }),
  );
});
