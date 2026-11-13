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
  readScientProjectPins,
} from "@scientfactory/scient-sources/project-pins";
import { importScientSource, listScientSourceRecords } from "@scientfactory/scient-sources/store";
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
import { libraryImportPinInstance } from "../../../scient/sources/LibraryImportPins.ts";
import {
  libraryOverview,
  libraryTrash,
  removeLibrarySource,
} from "../../../scient/sources/LibrarySourcesRoutes.ts";
import {
  SourceIdentifierLookup,
  verifiableSourceIdentifier,
} from "../../../scient/sources/SourceIdentifierResolver.ts";
import {
  resolveScientLibraryStoreAt,
  ScientSourcesBackend,
} from "../../../scient/sources/SourcesBackend.ts";
import {
  removeScientSourceForInvocation,
  syncScientBibliographyForInvocation,
  updateScientSourceForInvocation,
} from "./handlers.ts";

const fixtures: string[] = [];
const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(base: string, name: string) {
  const root = NodePath.join(base, name);
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  return root;
}

async function setup() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-delete-for-good-")),
  );
  fixtures.push(base);
  const stateDir = NodePath.join(base, "state");
  const libraryRoot = scientLibraryRootFor(stateDir);
  await ensureScientLibrary(libraryRoot);
  return {
    base,
    root: await project(base, "paper"),
    thesis: await project(base, "thesis"),
    stateDir,
    libraryRoot,
    library: scientLibraryLocation(libraryRoot),
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

function candidate(title: string): ScientSourceCandidate {
  return {
    sourceKey: title,
    type: "article",
    customType: null,
    title,
    creators: [ada],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [],
    abstract: `Abstract of ${title}.`,
    containerTitle: "Scient Journal",
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

const configured = <A, E, R>(effect: Effect.Effect<A, E, R>, fixture: Fixture) =>
  effect.pipe(
    Effect.provideService(ServerConfig, { stateDir: fixture.stateDir } as ServerConfig["Service"]),
    Effect.provideService(ScientSourcesBackend, "library"),
  );

/** An agent call in the paper project, with Library write access and no registry. */
const agent = <A, E, R>(effect: Effect.Effect<A, E, R>, fixture: Fixture) => {
  const projectId = ProjectId.make("project-delete-for-good");
  const environmentId = EnvironmentId.make("environment-delete-for-good");
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
  return configured(
    effect.pipe(
      Effect.provideService(
        AgentInvocationContext.AgentInvocationContext,
        AgentInvocationContext.AgentInvocationContext.of({
          environmentId,
          threadId: ThreadId.make("thread-delete-for-good"),
          providerSessionId: "session-delete-for-good",
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
      Effect.provideService(SourceIdentifierLookup, async (identifiers) => {
        const identifier = verifiableSourceIdentifier(identifiers);
        return identifier ? { status: "unavailable", identifier } : null;
      }),
    ),
    fixture,
  );
};

describe("deleting a cited source for good", () => {
  it.effect("names the citing projects, deletes it, and keeps it deleted on the next write", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const { gone, kept } = yield* Effect.promise(async () => {
        const add = async (title: string) =>
          (await importScientSource({
            root: fixture.library,
            operationId: NodeCrypto.randomUUID(),
            candidate: candidate(title),
            actor: "user",
          }))!.record!;
        const gone = await add("Gone study");
        const kept = await add("Kept study");
        for (const [root, sourceId] of [
          [fixture.root, gone.sourceId],
          [fixture.root, kept.sourceId],
          [fixture.thesis, gone.sourceId],
        ] as const) {
          await pinScientLibrarySource({
            projectRoot: root,
            library: fixture.library,
            sourceId,
            actor: "user",
          });
        }
        await libraryImportPinInstance(fixture.library, fixture.root);
        await libraryImportPinInstance(fixture.library, fixture.thesis);
        return { gone, kept };
      });
      yield* agent(syncScientBibliographyForInvocation({}), fixture);
      const store = yield* configured(resolveScientLibraryStoreAt(fixture.root, "write"), fixture);
      if (!store) throw new Error("Expected the library backend.");
      const pinsBefore = yield* Effect.promise(() => readScientProjectPins(fixture.root));

      // The screen: the trash names both projects that keep citing it.
      yield* Effect.promise(() =>
        removeLibrarySource(store, { sourceId: gone.sourceId, expectedRevision: gone.revision }),
      );
      const trash = yield* Effect.promise(() =>
        libraryTrash(store, [
          { workspaceRoot: fixture.root, title: "Paper" },
          { workspaceRoot: fixture.thesis, title: "Thesis" },
        ]),
      );
      expect(trash.entries).toMatchObject([{ sourceId: gone.sourceId }]);
      expect(trash.entries[0]!.citedBy?.toSorted()).toEqual(["Paper", "Thesis"]);

      // The agent: deleting it for good says the same.
      const deleted = yield* agent(
        removeScientSourceForInvocation({
          sourceId: gone.sourceId,
          expectedRevision: gone.revision,
          permanent: true,
        }),
        fixture,
      );
      expect(deleted).toMatchObject({ outcome: "deleted" });
      expect(deleted.stillCitedBy?.toSorted()).toEqual(["paper", "thesis"]);

      // A new checkout: no instance map remembers the pins. A write on another source resolves
      // every pin and syncs the bibliography.
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(fixture.libraryRoot, "projects"), { recursive: true }),
      );
      yield* agent(
        updateScientSourceForInvocation({
          sourceId: kept.sourceId,
          expectedRevision: kept.revision,
          metadata: { ...editableMetadataFromRecord(kept), title: "Kept study, corrected" },
        }),
        fixture,
      );

      const records = yield* Effect.promise(() => listScientSourceRecords(fixture.library));
      expect(records.map((record) => record.title)).toEqual(["Kept study, corrected"]);
      expect(yield* Effect.promise(() => readScientProjectPins(fixture.root))).toMatchObject(
        pinsBefore.map((pin) =>
          pin.sourceId === gone.sourceId
            ? { sourceId: pin.sourceId, citationKey: pin.citationKey, work: pin.work }
            : { sourceId: pin.sourceId, citationKey: pin.citationKey },
        ),
      );
      const goneKey = pinsBefore.find((pin) => pin.sourceId === gone.sourceId)!.citationKey;
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(fixture.root, "references.bib"), "utf8"),
        ),
      ).toContain(`{${goneKey},`);
      const overview = yield* Effect.promise(() =>
        libraryOverview(store, { scope: "project", background: false }),
      );
      expect(overview.records).toContainEqual(
        expect.objectContaining({ sourceId: gone.sourceId, fromSnapshot: true }),
      );
    }),
  );
});
