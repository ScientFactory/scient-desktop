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
  resolveScientSourcesProject,
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
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["sources:read"]),
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

  it.effect("rejects General Chat and credentials without Sources capability", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-general-chat");
      const thread = makeThread({ threadId, projectId: null });
      const query = makeQuery({ project: null, thread });
      const generalChat = yield* provideContext(resolveScientSourcesProject(), {
        invocation: makeInvocation(threadId),
        query,
      }).pipe(Effect.result);
      expect(generalChat._tag).toBe("Failure");
      if (generalChat._tag === "Failure") expect(generalChat.failure.code).toBe("project-required");

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
});
