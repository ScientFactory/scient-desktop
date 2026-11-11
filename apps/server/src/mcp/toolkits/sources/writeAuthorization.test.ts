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
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { dispatchScientOperation } from "../../../scient/operations/AgentOperationDispatcher.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import {
  SourceIdentifierLookup,
  verifiableSourceIdentifier,
  type ResolveSourceIdentifier,
} from "../../../scient/sources/SourceIdentifierResolver.ts";
import {
  addScientSourceForInvocation,
  attachScientSourcePdfForInvocation,
  detachScientSourcePdfForInvocation,
  getScientSourceForInvocation,
  listScientSourcesForInvocation,
  removeScientSourceForInvocation,
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
}): WorkspaceBindingResolver["Service"] => {
  const root = input.project.workspaceRoot;
  const base = workspaceResolverForTest(
    new Map([
      [
        root,
        { projectId: input.project.id, scope: workspaceScopeForTest(`binding:${root}`, root) },
      ],
    ]),
  );
  const resolveThread = () =>
    base.resolveWorkspaceRoot(root).pipe(
      Effect.map((resolved) => ({
        ...resolved,
        binding: { ...resolved.binding, environmentId, hostProjectId: input.project.id },
      })),
    );
  return {
    ...base,
    resolveThread,
    assertCurrentThreadScope: () =>
      resolveThread().pipe(Effect.map((resolved) => resolved.binding)),
  };
};

const makeInvocation = (
  threadId: ThreadId,
  capabilities: ReadonlySet<AgentInvocationContext.OperationCapability>,
) =>
  AgentInvocationContext.AgentInvocationContext.of({
    environmentId,
    threadId,
    providerSessionId: "session-sources-write-test",
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
  },
) =>
  effect.pipe(
    Effect.provideService(AgentInvocationContext.AgentInvocationContext, input.invocation),
    Effect.provideService(WorkspaceBindingResolver, input.query),
    Effect.provideService(SourceIdentifierLookup, offlineLookup),
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
      expect(listed.records[0]).toEqual({
        sourceId: "source_pending",
        revision: 1,
        type: "article",
        title: "Agent added",
        creator: "Lovelace",
        issuedYear: 2026,
        containerTitle: "Scient Journal",
        doi: "10.1000/source_pending",
        hasPdf: false,
        addedBy: "agent",
      });

      const note = yield* provideContext(
        dispatchScientOperation(
          "sources.note.update",
          updateScientSourceNoteForInvocation({
            sourceId: "source_pending",
            expectedRevision: 1,
            note: "should not write",
          }),
        ),
        context,
      ).pipe(Effect.result);
      expect(note._tag).toBe("Failure");
      if (note._tag === "Failure") expect(note.failure._tag).toBe("AgentOperationUnavailable");

      const removed = yield* provideContext(
        dispatchScientOperation(
          "sources.remove",
          removeScientSourceForInvocation({ sourceId: "source_pending", expectedRevision: 1 }),
        ),
        context,
      ).pipe(Effect.result);
      expect(removed._tag).toBe("Failure");
      if (removed._tag === "Failure")
        expect(removed.failure._tag).toBe("AgentOperationUnavailable");

      const added = yield* provideContext(
        dispatchScientOperation(
          "sources.add",
          addScientSourceForInvocation({
            type: "article",
            title: "Should not write",
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
        ),
        context,
      ).pipe(Effect.result);
      expect(added._tag).toBe("Failure");
      if (added._tag === "Failure") expect(added.failure._tag).toBe("AgentOperationUnavailable");

      const attached = yield* provideContext(
        dispatchScientOperation(
          "sources.pdf.attach",
          attachScientSourcePdfForInvocation({
            sourceId: "source_pending",
            expectedRevision: 1,
            pdfRelativePath: "paper.pdf",
          }),
        ),
        context,
      ).pipe(Effect.result);
      expect(attached._tag).toBe("Failure");
      if (attached._tag === "Failure")
        expect(attached.failure._tag).toBe("AgentOperationUnavailable");

      const detached = yield* provideContext(
        dispatchScientOperation(
          "sources.pdf.detach",
          detachScientSourcePdfForInvocation({
            sourceId: "source_pending",
            attachmentId: "pdf_pending",
            expectedRevision: 1,
          }),
        ),
        context,
      ).pipe(Effect.result);
      expect(detached._tag).toBe("Failure");
      if (detached._tag === "Failure")
        expect(detached.failure._tag).toBe("AgentOperationUnavailable");
    }),
  );

  it.effect("adds a metadata-only source credited to the agent and repeats as a duplicate", () =>
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
        verification: "unchecked",
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
        review: "none",
      });
      expect(detail.verification).toEqual({
        state: "unchecked",
        identifier: { scheme: "doi", value: "10.1000/mcp-add" },
      });
      expect(detail.attachments).toEqual([]);

      const repeated = yield* provideContext(addScientSourceForInvocation(payload), context);
      expect(repeated.outcome).toBe("duplicate");
      expect(repeated.duplicate.matchingSourceIds).toEqual([added.sourceId]);

      const listed = yield* provideContext(listScientSourcesForInvocation({}), context);
      expect(listed.records).toHaveLength(1);
      expect(listed.records[0]).toMatchObject({
        addedBy: "agent",
        verification: "unchecked",
        hasPdf: false,
      });
    }),
  );
});
