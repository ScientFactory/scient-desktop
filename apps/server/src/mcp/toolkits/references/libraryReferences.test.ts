// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  editableMetadataFromRecord,
  type ScientSourceCandidate,
} from "@scientfactory/scient-sources";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import {
  pinScientLibrarySource,
  renameScientProjectPinKey,
} from "@scientfactory/scient-sources/project-pins";
import {
  importScientSource,
  readScientSourceRecord,
  removeScientSource,
  updateScientSourceMetadata,
} from "@scientfactory/scient-sources/store";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ServerConfig } from "../../../config.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import {
  ReferenceIdentifierLookup,
  type ResolveIdentifierBatch,
} from "../../../scient/references/ReferenceCheck.ts";
import { ScientSourcesBackend } from "../../../scient/sources/SourcesBackend.ts";
import { checkReferencesForInvocation, resolveReferencesForInvocation } from "./handlers.ts";

const fixtures: string[] = [];
const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const lookup: ResolveIdentifierBatch = async (identifiers) =>
  identifiers.map((identifier) => ({
    status: "found" as const,
    identifier,
    retrievedAt: "2026-11-13T12:00:00.000Z",
    metadata: {
      type: "article",
      title: "Library study",
      creators: [ada],
      issuedRaw: "2026",
      issuedYear: 2026,
      identifiers: [],
      abstract: null,
      abstractSections: [],
      containerTitle: "Sleep Journal",
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
    },
  }));

function candidate(title: string, doi: string): ScientSourceCandidate {
  return {
    sourceKey: title,
    type: "article",
    customType: null,
    title,
    creators: [ada],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: doi }],
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
}

async function setup() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-references-library-")),
  );
  fixtures.push(base);
  const root = NodePath.join(base, "project");
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  const stateDir = NodePath.join(base, "state");
  const libraryRoot = scientLibraryRootFor(stateDir);
  await ensureScientLibrary(libraryRoot);
  const library = scientLibraryLocation(libraryRoot);
  const add = async (title: string, doi: string) =>
    (await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate(title, doi),
      actor: "user",
    }))!.record!;
  const cited = await add("Library study", "10.1000/cited");
  const gone = await add("Gone study", "10.1000/gone");
  for (const source of [cited, gone]) {
    await pinScientLibrarySource({
      projectRoot: root,
      library,
      sourceId: source.sourceId,
      actor: "user",
    });
  }
  // This project cites the first under a key of its own; the second only from its snapshot.
  await renameScientProjectPinKey({
    projectRoot: root,
    citationKey: cited.citationKey!,
    to: "ours",
  });
  await removeScientSource({
    root: library,
    sourceId: gone.sourceId,
    expectedRevision: gone.revision,
  });
  await NodeFSP.writeFile(
    NodePath.join(root, "paper.md"),
    `Sleep matters [@ours]. So it was [@${gone.citationKey}].\n`,
  );
  return { base, root, stateDir, libraryRoot, library, cited };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** An agent call in the project on the library backend, with Library write access. */
const agent = <A, E, R>(effect: Effect.Effect<A, E, R>, fixture: Fixture) => {
  const projectId = ProjectId.make("project-references-library");
  const environmentId = EnvironmentId.make("environment-references-library");
  const { root } = fixture;
  const base = workspaceResolverForTest(
    new Map([[root, { projectId, scope: workspaceScopeForTest(`binding:${root}`, root) }]]),
  );
  const resolveThread = () =>
    base.resolveWorkspaceRoot(root).pipe(
      Effect.map((resolved) => ({
        ...resolved,
        binding: { ...resolved.binding, environmentId, hostProjectId: projectId },
      })),
    );
  return effect.pipe(
    Effect.provideService(
      AgentInvocationContext.AgentInvocationContext,
      AgentInvocationContext.AgentInvocationContext.of({
        environmentId,
        threadId: ThreadId.make("thread-references-library"),
        providerSessionId: "session-references-library",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["sources:read", "sources:write"]),
        issuedAt: 1,
      }),
    ),
    Effect.provideService(WorkspaceBindingResolver, {
      ...base,
      resolveThread,
      assertCurrentThreadScope: () =>
        resolveThread().pipe(Effect.map((resolved) => resolved.binding)),
    }),
    Effect.provideService(ReferenceIdentifierLookup, lookup),
    Effect.provideService(ServerConfig, { stateDir: fixture.stateDir } as ServerConfig["Service"]),
    Effect.provideService(ScientSourcesBackend, "library"),
  );
};

async function folderBytes(root: string): Promise<ReadonlyArray<readonly [string, string]>> {
  const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true });
  const files: Array<readonly [string, string]> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = NodePath.join(entry.parentPath, entry.name);
    files.push([path, NodeCrypto.hash("sha256", await NodeFSP.readFile(path))]);
  }
  return files.toSorted(([left], [right]) => left.localeCompare(right));
}

describe("reference checks on the library backend", () => {
  it.effect("check the Library and the project's citations, and fix Library records", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const before = yield* Effect.promise(() => folderBytes(fixture.base));
      const library = yield* agent(checkReferencesForInvocation({}), fixture);
      expect(yield* Effect.promise(() => folderBytes(fixture.base))).toEqual(before);
      expect(library.ledger.map((entry) => entry.sourceId)).toEqual([fixture.cited.sourceId]);
      const fix = library.findings.find((finding) => finding.fix?.kind === "source-field")?.fix;
      expect(fix).toMatchObject({ field: "containerTitle", value: "Sleep Journal" });

      // A document citing a project key and a snapshot-only pin: neither is missing.
      const document = yield* agent(checkReferencesForInvocation({ path: "paper.md" }), fixture);
      expect(document.findings.filter((finding) => finding.kind === "cited-not-listed")).toEqual(
        [],
      );
      expect(document.references).toBe(2);

      // A fix applies to the Library record, only at the revision the check saw.
      const current = (yield* Effect.promise(() =>
        readScientSourceRecord(fixture.library, fixture.cited.sourceId),
      ))!;
      yield* Effect.promise(() =>
        updateScientSourceMetadata({
          root: fixture.library,
          sourceId: current.sourceId,
          expectedRevision: current.revision,
          metadata: { ...editableMetadataFromRecord(current), pages: "1-9" },
        }),
      );
      const stale = yield* agent(resolveReferencesForInvocation({ apply: [fix!] }), fixture);
      expect(stale.fixes).toMatchObject([{ outcome: "stale" }]);
      const again = yield* agent(checkReferencesForInvocation({}), fixture);
      const fresh = again.findings.find((finding) => finding.fix?.kind === "source-field")!.fix!;
      const applied = yield* agent(resolveReferencesForInvocation({ apply: [fresh] }), fixture);
      expect(applied.fixes).toMatchObject([{ outcome: "applied" }]);
      expect(
        yield* Effect.promise(() =>
          readScientSourceRecord(fixture.library, fixture.cited.sourceId),
        ),
      ).toMatchObject({ containerTitle: "Sleep Journal", revision: current.revision + 2 });
    }),
  );
});
