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
  addScientSourceForInvocation,
  attachScientSourcePdfForInvocation,
  detachScientSourcePdfForInvocation,
  getScientSourceForInvocation,
  listScientSourcesForInvocation,
  removeScientSourceForInvocation,
  reviewScientSourceForInvocation,
  updateScientSourceNoteForInvocation,
} from "./handlers.ts";

const fixtures: string[] = [];
const now = "2026-08-16T00:00:00.000Z";
const environmentId = EnvironmentId.make("environment-sources-write-test");
const providerInstanceId = ProviderInstanceId.make("codex");

async function fixture(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

async function writeSource(
  root: string,
  input: {
    readonly sourceId: string;
    readonly title: string;
    readonly origin?: {
      readonly actor: "user" | "agent";
      readonly intake: "zotero" | "local-pdf" | "identifier";
      readonly operationId: string;
      readonly review: "none" | "pending";
    };
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
    abstract: null,
    containerTitle: "Scient Journal",
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: "en",
    url: null,
    tags: [],
    externalReferences: [],
    attachments: [],
    fieldProvenance: [],
    ...(input.origin ? { origin: input.origin } : {}),
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
  readonly projectId: ProjectId;
}): OrchestrationThreadShell =>
  ({
    id: input.threadId,
    projectId: input.projectId,
    title: "Sources thread",
    createdAt: now,
    updatedAt: now,
    worktreePath: null,
  }) as OrchestrationThreadShell;

const makeQuery = (input: {
  readonly project: OrchestrationProjectShell;
  readonly thread: OrchestrationThreadShell;
}) =>
  ({
    getThreadShellById: () => Effect.succeed(Option.some(input.thread)),
    getProjectShellById: () => Effect.succeed(Option.some(input.project)),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;

const makeInvocation = (
  threadId: ThreadId,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
) =>
  McpInvocationContext.McpInvocationContext.of({
    environmentId,
    threadId,
    providerSessionId: "session-sources-write-test",
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

describe("Scient Sources MCP write authorization", () => {
  it.effect("lets read-only sessions list sources but not mutate them", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-readonly-"));
      yield* Effect.promise(() =>
        writeSource(root, {
          sourceId: "source_pending",
          title: "Agent added",
          origin: {
            actor: "agent",
            intake: "identifier",
            operationId: "operation-1",
            review: "pending",
          },
        }),
      );
      const projectId = ProjectId.make("project-readonly");
      const threadId = ThreadId.make("thread-readonly");
      const context = {
        invocation: makeInvocation(threadId, new Set(["sources:read"])),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };

      const listed = yield* provideContext(listScientSourcesForInvocation({}), context);
      expect(listed.records[0]).toMatchObject({
        sourceId: "source_pending",
        review: "pending",
        addedBy: "agent",
        hasPdf: false,
      });

      const note = yield* provideContext(
        updateScientSourceNoteForInvocation({
          sourceId: "source_pending",
          expectedRevision: 1,
          note: "should not write",
        }),
        context,
      ).pipe(Effect.result);
      expect(note._tag).toBe("Failure");
      if (note._tag === "Failure") expect(note.failure.code).toBe("capability-unavailable");

      const removed = yield* provideContext(
        removeScientSourceForInvocation({ sourceId: "source_pending", expectedRevision: 1 }),
        context,
      ).pipe(Effect.result);
      expect(removed._tag).toBe("Failure");
      if (removed._tag === "Failure") expect(removed.failure.code).toBe("capability-unavailable");

      const reviewed = yield* provideContext(
        reviewScientSourceForInvocation({
          sourceId: "source_pending",
          expectedRevision: 1,
          action: "reject",
        }),
        context,
      ).pipe(Effect.result);
      expect(reviewed._tag).toBe("Failure");
      if (reviewed._tag === "Failure") expect(reviewed.failure.code).toBe("capability-unavailable");

      const added = yield* provideContext(
        addScientSourceForInvocation({
          type: "article",
          title: "Should not write",
          creators: [
            { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
          ],
          issuedRaw: "2026",
          issuedYear: 2026,
          identifiers: [{ scheme: "doi", value: "10.1000/readonly" }],
          abstract: null,
          containerTitle: null,
          publisher: null,
          volume: null,
          issue: null,
          pages: null,
          language: null,
          url: null,
          tags: [],
        }),
        context,
      ).pipe(Effect.result);
      expect(added._tag).toBe("Failure");
      if (added._tag === "Failure") expect(added.failure.code).toBe("capability-unavailable");

      const attached = yield* provideContext(
        attachScientSourcePdfForInvocation({
          sourceId: "source_pending",
          expectedRevision: 1,
          pdfRelativePath: "paper.pdf",
        }),
        context,
      ).pipe(Effect.result);
      expect(attached._tag).toBe("Failure");
      if (attached._tag === "Failure") expect(attached.failure.code).toBe("capability-unavailable");

      const detached = yield* provideContext(
        detachScientSourcePdfForInvocation({
          sourceId: "source_pending",
          attachmentId: "pdf_pending",
          expectedRevision: 1,
        }),
        context,
      ).pipe(Effect.result);
      expect(detached._tag).toBe("Failure");
      if (detached._tag === "Failure") expect(detached.failure.code).toBe("capability-unavailable");
    }),
  );

  it.effect("approves pending review and rejects by removing the source", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-review-"));
      yield* Effect.promise(() =>
        Promise.all([
          writeSource(root, {
            sourceId: "source_approve",
            title: "Approve me",
            origin: {
              actor: "agent",
              intake: "local-pdf",
              operationId: "operation-approve",
              review: "pending",
            },
          }),
          writeSource(root, {
            sourceId: "source_reject",
            title: "Reject me",
            origin: {
              actor: "agent",
              intake: "identifier",
              operationId: "operation-reject",
              review: "pending",
            },
          }),
        ]),
      );
      const projectId = ProjectId.make("project-review");
      const threadId = ThreadId.make("thread-review");
      const context = {
        invocation: makeInvocation(threadId, new Set(["sources:read", "sources:write"])),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };

      const approved = yield* provideContext(
        reviewScientSourceForInvocation({
          sourceId: "source_approve",
          expectedRevision: 1,
          action: "approve",
        }),
        context,
      );
      expect(approved).toMatchObject({
        action: "approve",
        outcome: "updated",
        sourceId: "source_approve",
        revision: 2,
      });

      const rejected = yield* provideContext(
        reviewScientSourceForInvocation({
          sourceId: "source_reject",
          expectedRevision: 1,
          action: "reject",
        }),
        context,
      );
      expect(rejected).toMatchObject({
        action: "reject",
        outcome: "removed",
        sourceId: "source_reject",
      });

      const listed = yield* provideContext(listScientSourcesForInvocation({}), context);
      expect(listed.records.map((record) => record.sourceId).sort()).toEqual(["source_approve"]);
      expect(listed.records[0]).toMatchObject({ review: "none", addedBy: "agent" });

      const detail = yield* provideContext(
        getScientSourceForInvocation({ sourceId: "source_approve" }),
        context,
      );
      expect(detail.origin).toMatchObject({
        actor: "agent",
        intake: "local-pdf",
        review: "none",
      });
    }),
  );

  it.effect("does not remove a user-owned source through review reject", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-user-reject-"));
      yield* Effect.promise(() =>
        writeSource(root, {
          sourceId: "source_user",
          title: "User owned",
          origin: {
            actor: "user",
            intake: "local-pdf",
            operationId: "operation-user",
            review: "none",
          },
        }),
      );
      const projectId = ProjectId.make("project-user-reject");
      const threadId = ThreadId.make("thread-user-reject");
      const context = {
        invocation: makeInvocation(threadId, new Set(["sources:read", "sources:write"])),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };

      const rejected = yield* provideContext(
        reviewScientSourceForInvocation({
          sourceId: "source_user",
          expectedRevision: 1,
          action: "reject",
        }),
        context,
      ).pipe(Effect.result);
      expect(rejected._tag).toBe("Failure");

      const listed = yield* provideContext(listScientSourcesForInvocation({}), context);
      expect(listed.records.map((record) => record.sourceId)).toEqual(["source_user"]);
    }),
  );

  it.effect("adds a metadata-only source as pending review and repeats as a duplicate", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fixture("scient-sources-add-"));
      const projectId = ProjectId.make("project-add");
      const threadId = ThreadId.make("thread-add");
      const context = {
        invocation: makeInvocation(threadId, new Set(["sources:read", "sources:write"])),
        query: makeQuery({
          project: makeProject(projectId, root),
          thread: makeThread({ threadId, projectId }),
        }),
      };
      const payload = {
        type: "article" as const,
        title: "Agent DOI article",
        creators: [
          {
            creatorType: "author" as const,
            givenName: "Ada",
            familyName: "Lovelace",
            literalName: null,
          },
        ],
        issuedRaw: "2026",
        issuedYear: 2026,
        identifiers: [{ scheme: "doi", value: "10.1000/mcp-add" }],
        abstract: null,
        containerTitle: "Journal",
        publisher: null,
        volume: null,
        issue: null,
        pages: null,
        language: "en",
        url: null,
        tags: [] as const,
      };

      const invalid = yield* provideContext(
        addScientSourceForInvocation({
          type: "article",
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
        }),
        context,
      );
      expect(invalid.outcome).toBe("invalid");
      expect(invalid.sourceId).toBeNull();

      const added = yield* provideContext(addScientSourceForInvocation(payload), context);
      expect(added).toMatchObject({
        outcome: "imported",
        review: "pending",
        duplicate: { kind: "new" },
      });
      expect(added.sourceId).toBeTruthy();

      const detail = yield* provideContext(
        getScientSourceForInvocation({ sourceId: added.sourceId ?? "" }),
        context,
      );
      expect(detail.origin).toMatchObject({
        actor: "agent",
        intake: "identifier",
        review: "pending",
      });
      expect(detail.attachments).toEqual([]);

      const repeated = yield* provideContext(addScientSourceForInvocation(payload), context);
      expect(repeated.outcome).toBe("duplicate");
      expect(repeated.duplicate.matchingSourceIds).toEqual([added.sourceId]);

      const listed = yield* provideContext(listScientSourcesForInvocation({}), context);
      expect(listed.records).toHaveLength(1);
      expect(listed.records[0]).toMatchObject({
        addedBy: "agent",
        review: "pending",
        hasPdf: false,
      });
    }),
  );
});
