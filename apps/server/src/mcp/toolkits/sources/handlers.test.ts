// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { SCIENT_SOURCE_RECORDS_DIRECTORY } from "@scientfactory/scient-sources/store";
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
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  getScientSourceForInvocation,
  listScientSourcesForInvocation,
  addScientSourceForInvocation,
  attachScientSourcePdfForInvocation,
  detachScientSourcePdfForInvocation,
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
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set([
    "sources:read",
    "sources:write",
  ]),
) =>
  McpInvocationContext.McpInvocationContext.of({
    environmentId,
    threadId,
    providerSessionId: "session-sources-test",
    providerInstanceId,
    capabilities,
    issuedAt: 1,
  });

const provideContext = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly invocation: McpInvocationContext.McpInvocationScope;
    readonly query: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
  },
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, input.invocation),
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, input.query),
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

  it.effect("rejects a legacy projectless thread and credentials without Sources capability", () =>
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

      const missingCapability = yield* provideContext(resolveScientSourcesProject(), {
        invocation: makeInvocation(threadId, new Set(["preview"])),
        query,
      }).pipe(Effect.result);
      expect(missingCapability._tag).toBe("Failure");
      if (missingCapability._tag === "Failure") {
        expect(missingCapability.failure.code).toBe("capability-unavailable");
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

  it.effect("adds an idempotent metadata-only agent source with pending provenance", () =>
    Effect.gen(function* () {
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
      const added = yield* provideContext(addScientSourceForInvocation(input), context);
      expect(added.outcome).toBe("imported");
      expect(added.review).toBe("pending");
      expect(added.sourceId).toMatch(/^source_/);
      expect(added.revision).toBe(1);
      expect(added.validationIssues).toEqual([]);

      const repeated = yield* provideContext(addScientSourceForInvocation(input), context);
      expect(repeated.outcome).toBe("duplicate");
      expect(repeated.sourceId).toBe(added.sourceId);
      expect(repeated.revision).toBe(1);
      expect(repeated.duplicate.kind).toBe("same-identifier");

      const detail = yield* provideContext(
        getScientSourceForInvocation({ sourceId: added.sourceId ?? "" }),
        context,
      );
      expect(detail.origin).toMatchObject({
        actor: "agent",
        intake: "identifier",
        review: "pending",
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
      expect(added).toMatchObject({ outcome: "imported", review: "pending", revision: 1 });
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
        removedAttachmentCount: 1,
      });
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
      expect(added).toMatchObject({ outcome: "imported", review: "pending", revision: 1 });
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
});
