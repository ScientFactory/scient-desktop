// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { bibtexEntriesByKey } from "@scientfactory/scient-citations/bibliography";
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
import {
  importScientSource,
  listScientSourceRecords,
  readScientSourceRecord,
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
import { ReferenceIdentifierLookup } from "../../../scient/references/ReferenceCheck.ts";
import { indexSourceFullText } from "../../../scient/sources/SourceFullText.ts";
import {
  SourceIdentifierLookup,
  verifiableSourceIdentifier,
} from "../../../scient/sources/SourceIdentifierResolver.ts";
import {
  changeLibraryReviewConflict,
  libraryReview,
  libraryReviewConflicts,
} from "../../../scient/sources/LibrarySourcesRoutes.ts";
import {
  ScientSourcesBackend,
  type ScientSourcesBackendKind,
} from "../../../scient/sources/SourcesBackend.ts";
import {
  readSystematicReviewsForInvocation,
  updateLibrarySystematicReviewForInvocation,
  updateSystematicReviewForInvocation,
} from "../systematicReviews/handlers.ts";
import {
  addScientSourceForInvocation,
  checkScientSourceQuotesForInvocation,
  citeScientSourcesForInvocation,
  getScientSourceForInvocation,
  listScientSourcesForInvocation,
  organizeLibrarySourcesForInvocation,
  readScientSourceTextForInvocation,
  resolveScientSourcesStore,
  searchScientSourcesForInvocation,
  syncScientBibliographyForInvocation,
  updateScientSourceForInvocation,
  updateScientSourceNoteForInvocation,
  updateLibrarySourceForInvocation,
} from "./handlers.ts";

const fixtures: string[] = [];
const environmentId = EnvironmentId.make("environment-sources-library");
const threadId = ThreadId.make("thread-sources-library");
const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sources-library-")),
  );
  fixtures.push(base);
  const root = NodePath.join(base, "project");
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  const stateDir = NodePath.join(base, "state");
  const libraryRoot = scientLibraryRootFor(stateDir);
  return { base, root, stateDir, libraryRoot, library: scientLibraryLocation(libraryRoot) };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fixture: Pick<Fixture, "root" | "stateDir">,
  options: { readonly write?: boolean; readonly backend?: ScientSourcesBackendKind } = {},
) => {
  const projectId = ProjectId.make("project-sources-library");
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
  const provided = effect.pipe(
    Effect.provideService(
      AgentInvocationContext.AgentInvocationContext,
      AgentInvocationContext.AgentInvocationContext.of({
        environmentId,
        threadId,
        providerSessionId: "session-sources-library",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(
          options.write === false ? ["sources:read"] : ["sources:read", "sources:write"],
        ),
        issuedAt: 1,
      }),
    ),
    Effect.provideService(WorkspaceBindingResolver, {
      ...base,
      resolveThread,
      assertCurrentThreadScope: () =>
        resolveThread().pipe(Effect.map((resolved) => resolved.binding)),
    }),
    // Registries are never reached: every identifier is reported unreachable.
    Effect.provideService(SourceIdentifierLookup, async (identifiers) => {
      const identifier = verifiableSourceIdentifier(identifiers);
      return identifier ? { status: "unavailable", identifier } : null;
    }),
    Effect.provideService(ReferenceIdentifierLookup, async (identifiers) =>
      identifiers.map((identifier) => ({ status: "unavailable" as const, identifier })),
    ),
    // The library backend reads only the state folder from the server configuration.
    Effect.provideService(ServerConfig, { stateDir: fixture.stateDir } as ServerConfig["Service"]),
  );
  return provided.pipe(Effect.provideService(ScientSourcesBackend, options.backend ?? "library"));
};

function candidate(
  sourceKey: string,
  overrides: Partial<ScientSourceCandidate> = {},
): ScientSourceCandidate {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title: `Sepsis study ${sourceKey}`,
    creators: [ada],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [],
    abstract: null,
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
    ...overrides,
  };
}

/** A record another project brought into the library; it is not pinned here. */
async function libraryRecord(
  fixture: Fixture,
  sourceKey: string,
  overrides: Partial<ScientSourceCandidate> = {},
  pdfPath?: string,
) {
  await ensureScientLibrary(fixture.libraryRoot);
  const imported = await importScientSource({
    root: fixture.library,
    operationId: NodeCrypto.randomUUID(),
    candidate: candidate(sourceKey, {
      ...overrides,
      ...(pdfPath ? { pdfAvailable: true, pdfFileName: `${sourceKey}.pdf` } : {}),
    }),
    allowPossibleMetadataMatch: true,
    ...(pdfPath ? { pdfPath } : {}),
  });
  if (!imported.record) throw new Error(`Expected ${sourceKey} to import.`);
  return imported.record;
}

/** A PDF whose single page holds the given line. */
function textPdf(line: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, "latin1");
}

async function folderBytes(root: string): Promise<ReadonlyArray<readonly [string, string]>> {
  const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = NodePath.join(entry.parentPath, entry.name);
        return [NodePath.relative(root, path), await NodeFSP.readFile(path, "base64")] as const;
      }),
  );
  return files.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

const addSource = (fixture: Fixture, title: string, doi: string, pdfRelativePath?: string) =>
  run(
    addScientSourceForInvocation({
      type: "article",
      title,
      creators: [ada],
      issuedYear: 2026,
      identifiers: [{ scheme: "doi", value: doi }],
      containerTitle: "Scient Journal",
      ...(pdfRelativePath ? { pdfRelativePath } : {}),
    }),
    fixture,
  );

describe("Sources tools on the library backend", () => {
  it.effect("on the project backend, a full round of tool calls creates no library folder", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const opts = { backend: "project" } as const;
      const added = yield* run(
        addScientSourceForInvocation({
          type: "article",
          title: "Project study",
          creators: [ada],
          issuedYear: 2026,
          identifiers: [{ scheme: "doi", value: "10.1000/project" }],
        }),
        fixture,
        opts,
      );
      const sourceId = added.sourceId!;
      yield* run(listScientSourcesForInvocation({}), fixture, opts);
      const detail = yield* run(getScientSourceForInvocation({ sourceId }), fixture, opts);
      yield* run(
        updateScientSourceNoteForInvocation({
          sourceId,
          expectedRevision: detail.revision,
          note: "Why it matters.",
        }),
        fixture,
        opts,
      );
      yield* run(
        organizeLibrarySourcesForInvocation({
          change: { action: "create-collection", name: "Sepsis", sourceIds: [sourceId] },
        }),
        fixture,
        opts,
      );
      yield* run(citeScientSourcesForInvocation({ sources: [sourceId] }), fixture, opts);
      yield* run(syncScientBibliographyForInvocation({}), fixture, opts);
      yield* run(searchScientSourcesForInvocation({ query: "sepsis" }), fixture, opts);
      const review = yield* run(
        updateSystematicReviewForInvocation({
          change: { action: "create-review", title: "Sepsis review" },
        }),
        fixture,
        opts,
      );
      yield* run(readSystematicReviewsForInvocation({ reviewId: review.reviewId! }), fixture, opts);

      expect(yield* Effect.promise(() => exists(fixture.libraryRoot))).toBe(false);
      expect(
        yield* Effect.promise(() => exists(NodePath.join(fixture.root, ".scient", "library"))),
      ).toBe(false);
      expect(
        yield* Effect.promise(() => exists(NodePath.join(fixture.root, "references.bib"))),
      ).toBe(true);
    }),
  );

  it.effect("replaces a project note only from the note it read, and restores an earlier one", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const added = yield* addSource(fixture, "Noted trial", "10.1000/noted");
      const sourceId = added.sourceId!;
      const pin = (note: string, noteBase?: string) =>
        run(
          organizeLibrarySourcesForInvocation({
            change: { action: "pin", sourceId, note, ...(noteBase ? { noteBase } : {}) },
          }),
          fixture,
        );
      expect(yield* pin("First reading")).toMatchObject({ pin: { note: "First reading" } });
      expect(yield* pin("Blind rewrite")).toMatchObject({
        outcome: "stale",
        pin: { note: "First reading" },
      });
      expect(yield* pin("Second reading", "First reading")).toMatchObject({
        outcome: "existing",
        pin: { note: "Second reading" },
      });
      const detail = yield* run(getScientSourceForInvocation({ sourceId }), fixture);
      expect(detail.projectNoteHistory?.map((version) => [version.note, version.by])).toEqual([
        ["First reading", "agent"],
        ["Second reading", "agent"],
      ]);
      expect(yield* pin(detail.projectNoteHistory![0]!.note!, "Second reading")).toMatchObject({
        outcome: "existing",
        pin: { note: "First reading" },
      });
    }),
  );

  it.effect("pins what an agent adds; list, library scope and search mark the pins", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.root, "pinned.pdf"), textPdf("Sepsis pinned")),
      );
      const added = yield* addSource(
        fixture,
        "Pinned sepsis trial",
        "10.1000/pinned",
        "pinned.pdf",
      );
      expect(added).toMatchObject({ outcome: "imported", citationKey: "lovelace2026pinned" });
      const otherPdf = NodePath.join(fixture.base, "other.pdf");
      yield* Effect.promise(() => NodeFSP.writeFile(otherPdf, textPdf("Sepsis elsewhere")));
      const other = yield* Effect.promise(() =>
        libraryRecord(fixture, "other", { citationKey: "other2026" }, otherPdf),
      );

      const here = yield* run(listScientSourcesForInvocation({}), fixture);
      expect(here.total).toBe(1);
      expect(here.records).toMatchObject([
        { sourceId: added.sourceId, citationKey: "lovelace2026pinned", pinned: true },
      ]);
      const everything = yield* run(listScientSourcesForInvocation({ scope: "library" }), fixture);
      expect(everything.total).toBe(2);
      expect(
        Object.fromEntries(everything.records.map(({ sourceId, pinned }) => [sourceId, pinned])),
      ).toEqual({ [added.sourceId!]: true, [other.sourceId]: false });

      yield* Effect.promise(() => indexSourceFullText(fixture.library));
      const found = yield* run(searchScientSourcesForInvocation({ query: "sepsis" }), fixture);
      expect(
        Object.fromEntries(found.hits.map((hit) => [hit.sourceId, [hit.pinned, hit.citationKey]])),
      ).toEqual({
        [added.sourceId!]: [true, "lovelace2026pinned"],
        [other.sourceId]: [false, undefined],
      });
      expect((yield* Effect.promise(() => readScientProjectPins(fixture.root))).length).toBe(1);
    }),
  );

  it.effect("cite pins first under a suffixed key; references.bib holds exactly the pins", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const pinned = yield* addSource(fixture, "Pinned sepsis trial", "10.1000/pinned");
      // Free the preferred key in the library, then give it to another record.
      const record = (yield* Effect.promise(() =>
        readScientSourceRecord(fixture.library, pinned.sourceId!),
      ))!;
      yield* Effect.promise(() =>
        updateScientSourceMetadata({
          root: fixture.library,
          sourceId: record.sourceId,
          expectedRevision: record.revision,
          metadata: { ...editableMetadataFromRecord(record), citationKey: "renamed2026" },
        }),
      );
      const clashing = yield* Effect.promise(() =>
        libraryRecord(fixture, "clash", {
          citationKey: "lovelace2026pinned",
          identifiers: [{ scheme: "doi", value: "10.1000/clash" }],
        }),
      );
      yield* Effect.promise(() =>
        libraryRecord(fixture, "unpinned", { citationKey: "unpinned2026" }),
      );

      const cited = yield* run(
        citeScientSourcesForInvocation({ sources: [clashing.sourceId] }),
        fixture,
      );
      expect(cited).toMatchObject({
        citation: "[@lovelace2026pinneda]",
        sources: [{ sourceId: clashing.sourceId, citationKey: "lovelace2026pinneda" }],
        notFound: [],
        bibliography: "current",
      });
      const bibtex = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(fixture.root, "references.bib"), "utf8"),
      );
      expect([...bibtexEntriesByKey(bibtex).keys()].toSorted()).toEqual([
        "lovelace2026pinned",
        "lovelace2026pinneda",
      ]);
    }),
  );

  it.effect(
    "a read on a project not moved yet reads its v1 store; the first write call moves it",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const own = yield* Effect.promise(() =>
          importScientSource({
            root: fixture.root,
            operationId: NodeCrypto.randomUUID(),
            candidate: candidate("v1", { citationKey: "lovelace2026v1" }),
          }),
        );
        yield* Effect.promise(() => libraryRecord(fixture, "elsewhere"));
        const trees = () =>
          Effect.promise(() =>
            Promise.all([folderBytes(fixture.root), folderBytes(fixture.libraryRoot)]),
          );
        const before = yield* trees();

        const read = yield* run(listScientSourcesForInvocation({}), fixture, { write: false });
        expect(read.records.map((record) => record.sourceId)).toEqual([own.record!.sourceId]);
        expect(yield* trees()).toEqual(before);

        const written = yield* run(listScientSourcesForInvocation({}), fixture);
        expect(written.records).toMatchObject([
          { sourceId: own.record!.sourceId, citationKey: "lovelace2026v1", pinned: true },
        ]);
        expect(
          yield* Effect.promise(() => exists(NodePath.join(fixture.root, ".scient/sources"))),
        ).toBe(false);
        const afterMove = yield* run(listScientSourcesForInvocation({}), fixture, { write: false });
        expect(afterMove.records.map((record) => record.pinned)).toEqual([true]);
      }),
  );

  it.effect(
    "without sources:write an unresolved pin comes from its snapshot and nothing is written",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        // The pin was made on a collaborator's computer; this library has never seen the record.
        const theirs = scientLibraryLocation(
          scientLibraryRootFor(NodePath.join(fixture.base, "theirs")),
        );
        yield* Effect.promise(() => ensureScientLibrary(theirs.root));
        const imported = yield* Effect.promise(() =>
          importScientSource({
            root: theirs,
            operationId: NodeCrypto.randomUUID(),
            candidate: candidate("collaborator", { citationKey: "collab2026" }),
          }),
        );
        yield* Effect.promise(() =>
          pinScientLibrarySource({
            projectRoot: fixture.root,
            library: theirs,
            sourceId: imported.record!.sourceId,
            actor: "user",
          }),
        );
        yield* Effect.promise(() => ensureScientLibrary(fixture.libraryRoot));
        const before = yield* Effect.promise(() =>
          Promise.all([folderBytes(fixture.root), folderBytes(fixture.libraryRoot)]),
        );

        const read = yield* run(listScientSourcesForInvocation({}), fixture, { write: false });
        expect(read.records).toMatchObject([
          {
            sourceId: imported.record!.sourceId,
            citationKey: "collab2026",
            pinned: true,
            fromSnapshot: true,
          },
        ]);
        expect(
          yield* Effect.promise(() =>
            Promise.all([folderBytes(fixture.root), folderBytes(fixture.libraryRoot)]),
          ),
        ).toEqual(before);

        const written = yield* run(listScientSourcesForInvocation({}), fixture);
        expect(written.records[0]).not.toHaveProperty("fromSnapshot");
        expect(yield* Effect.promise(() => listScientSourceRecords(fixture.library))).toHaveLength(
          1,
        );
      }),
  );

  it.effect(
    "merge and its undo keep the pin's key and project source ID and the bibliography",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const pinned = yield* addSource(fixture, "Pinned sepsis trial", "10.1000/pinned");
        // The same work, kept by another project without its DOI.
        const twin = yield* Effect.promise(() =>
          libraryRecord(fixture, "twin", { title: "Pinned sepsis trial" }),
        );
        yield* run(syncScientBibliographyForInvocation({}), fixture);
        const bibliography = () =>
          Promise.all(
            ["references.bib", "references.json"].map((name) =>
              NodeFSP.readFile(NodePath.join(fixture.root, name), "utf8"),
            ),
          );
        const before = yield* Effect.promise(bibliography);
        const pinsBefore = yield* Effect.promise(() => readScientProjectPins(fixture.root));

        const merged = yield* run(
          organizeLibrarySourcesForInvocation({
            change: {
              action: "merge",
              sourceIds: [pinned.sourceId!, twin.sourceId],
              survivorId: twin.sourceId,
            },
          }),
          fixture,
        );
        expect(merged).toMatchObject({ outcome: "merged", survivorId: twin.sourceId });
        const pinsAfterMerge = yield* Effect.promise(() => readScientProjectPins(fixture.root));
        expect(
          pinsAfterMerge.map(({ citationKey, sourceId }) => ({ citationKey, sourceId })),
        ).toEqual(pinsBefore.map(({ citationKey, sourceId }) => ({ citationKey, sourceId })));
        expect(yield* Effect.promise(bibliography)).toEqual(before);
        const listed = yield* run(listScientSourcesForInvocation({}), fixture);
        expect(listed.records).toMatchObject([
          { sourceId: twin.sourceId, citationKey: pinsBefore[0]!.citationKey },
        ]);

        const mergeId = "merges" in merged ? merged.merges![0]!.mergeId : "";
        const undone = yield* run(
          organizeLibrarySourcesForInvocation({ change: { action: "undo-merge", mergeId } }),
          fixture,
        );
        expect(undone).toMatchObject({ outcome: "undone" });
        const pinsAfterUndo = yield* Effect.promise(() => readScientProjectPins(fixture.root));
        expect(
          pinsAfterUndo.map(({ citationKey, sourceId }) => ({ citationKey, sourceId })),
        ).toEqual(pinsBefore.map(({ citationKey, sourceId }) => ({ citationKey, sourceId })));
        expect(yield* Effect.promise(bibliography)).toEqual(before);
      }),
  );

  it.effect("lists possible duplicates and marks a pair not duplicates; project mode refuses", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const [one, two] = yield* Effect.promise(() =>
        Promise.all([
          libraryRecord(fixture, "copy-a", { title: "Shock trial" }),
          libraryRecord(fixture, "copy-b", { title: "Shock trial", publisher: "Press" }),
        ]),
      );
      const listed = yield* run(listScientSourcesForInvocation({ duplicates: true }), fixture);
      expect(listed.duplicates).toMatchObject({ pairsTotal: 1, merges: [], mergesTotal: 0 });
      expect(listed.duplicates?.pairs[0]?.sources.map((side) => side.sourceId).toSorted()).toEqual(
        [one.sourceId, two.sourceId].toSorted(),
      );

      const marked = yield* run(
        organizeLibrarySourcesForInvocation({
          change: { action: "mark-distinct", sourceIds: [one.sourceId, two.sourceId] },
        }),
        fixture,
      );
      expect(marked.outcome).toBe("marked");
      const after = yield* run(listScientSourcesForInvocation({ duplicates: true }), fixture);
      expect(after.duplicates?.pairsTotal).toBe(0);

      const refused = yield* run(listScientSourcesForInvocation({ duplicates: true }), fixture, {
        backend: "project",
      }).pipe(Effect.flip);
      expect(refused.message).toBe("Possible duplicates need the personal Library.");
    }),
  );

  it.effect("an edit refreshes this project's pin and review snapshots once", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const pinned = yield* addSource(fixture, "Pinned sepsis trial", "10.1000/pinned");
      const sourceId = pinned.sourceId!;
      const review = yield* run(
        updateSystematicReviewForInvocation({
          change: { action: "create-review", title: "Sepsis review" },
        }),
        fixture,
      );
      const reviewId = review.reviewId!;
      yield* run(
        updateSystematicReviewForInvocation({
          change: {
            action: "log-search",
            reviewId,
            database: "PubMed",
            query: "sepsis",
            searchedOn: "2026-11-11",
            sourceIds: [sourceId],
          },
        }),
        fixture,
      );
      const files = [
        NodePath.join(fixture.root, ".scient", "library", "pins.json"),
        NodePath.join(fixture.root, ".scient", "library", "reviews", `${reviewId}.works.json`),
      ];
      const edit = Effect.gen(function* () {
        const current = yield* run(getScientSourceForInvocation({ sourceId }), fixture);
        return yield* run(
          updateScientSourceForInvocation({
            sourceId,
            expectedRevision: current.revision,
            metadata: {
              ...editableMetadataFromRecord(
                (yield* Effect.promise(() => readScientSourceRecord(fixture.library, sourceId)))!,
              ),
              title: "Corrected sepsis trial",
            },
          }),
          fixture,
        );
      });

      expect(yield* edit).toMatchObject({ outcome: "updated" });
      const texts = yield* Effect.promise(() =>
        Promise.all(files.map((file) => NodeFSP.readFile(file, "utf8"))),
      );
      expect(texts.map((text) => text.includes("Corrected sepsis trial"))).toEqual([true, true]);
      const stamps = yield* Effect.promise(() =>
        Promise.all(files.map((file) => NodeFSP.stat(file).then((stats) => stats.mtimeMs))),
      );

      expect(yield* edit).toMatchObject({ outcome: "unchanged" });
      expect(
        yield* Effect.promise(() =>
          Promise.all(files.map((file) => NodeFSP.stat(file).then((stats) => stats.mtimeMs))),
        ),
      ).toEqual(stamps);
    }),
  );

  it.effect(
    "read-only search, read-text and quote-check leave the project and library untouched",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const pdfPath = NodePath.join(fixture.base, "readonly.pdf");
        yield* Effect.promise(() => NodeFSP.writeFile(pdfPath, textPdf("Read only library text")));
        const record = yield* Effect.promise(() =>
          libraryRecord(fixture, "readonly", { citationKey: "readonly2026" }, pdfPath),
        );
        const trees = () =>
          Effect.promise(() =>
            Promise.all([folderBytes(fixture.root), folderBytes(fixture.libraryRoot)]),
          );
        const before = yield* trees();

        const read = yield* run(
          readScientSourceTextForInvocation({ sourceId: record.sourceId }),
          fixture,
          { write: false },
        );
        expect(read).toMatchObject({ outcome: "read" });
        expect(
          read.outcome === "read" &&
            read.pages.some((page) => page.text.includes("Read only library text")),
        ).toBe(true);

        const found = yield* run(
          searchScientSourcesForInvocation({ query: "Read only library text" }),
          fixture,
          { write: false },
        );
        expect(found.hits).toEqual([]);
        expect(found.status.pending).toBe(1);

        const checked = yield* run(
          checkScientSourceQuotesForInvocation({
            quotes: [{ quote: "Read only library text", sourceId: record.sourceId }],
          }),
          fixture,
          { write: false },
        );
        expect(["exact", "normalized"]).toContain(checked.results[0]!.outcome);

        expect(yield* trees()).toEqual(before);

        // Negative control: the same read with write access stores the text in the library.
        const written = yield* run(
          readScientSourceTextForInvocation({ sourceId: record.sourceId }),
          fixture,
        );
        expect(written).toMatchObject({ outcome: "read" });
        expect(yield* trees()).not.toEqual(before);
      }),
  );

  it.effect("a merge that stops at a missing source still reports the merges that landed", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const pinned = yield* addSource(fixture, "Pinned sepsis trial", "10.1000/pinned-merge");
      const twin = yield* Effect.promise(() =>
        libraryRecord(fixture, "twin-merge", { title: "Pinned sepsis trial" }),
      );
      const missing = "library-source-missing";

      const merged = yield* run(
        organizeLibrarySourcesForInvocation({
          change: { action: "merge", sourceIds: [pinned.sourceId!, twin.sourceId, missing] },
        }),
        fixture,
      );
      expect(merged.outcome).toBe("merged");
      const merges = merged.outcome === "merged" ? (merged.merges ?? []) : [];
      expect(merges).toHaveLength(1);
      expect(merged.outcome === "merged" ? merged.notMerged : undefined).toEqual([missing]);

      const undone = yield* run(
        organizeLibrarySourcesForInvocation({
          change: { action: "undo-merge", mergeId: merges[0]!.mergeId },
        }),
        fixture,
      );
      expect(undone).toMatchObject({ outcome: "undone" });

      // Negative control: with nothing landed yet, a missing source is a plain not-found.
      const control = yield* run(
        organizeLibrarySourcesForInvocation({
          change: { action: "merge", sourceIds: [pinned.sourceId!, missing] },
        }),
        fixture,
      );
      expect(control).toMatchObject({ outcome: "not-found" });
      expect(control).not.toHaveProperty("notMerged");
    }),
  );

  it.effect("screens an unpinned library record, then reads it from the review's snapshot", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const record = yield* Effect.promise(() =>
        libraryRecord(fixture, "screened", { abstract: "Septic shock outcomes." }),
      );
      const review = yield* run(
        updateSystematicReviewForInvocation({
          change: { action: "create-review", title: "Sepsis review" },
        }),
        fixture,
      );
      const reviewId = review.reviewId!;
      yield* run(
        updateSystematicReviewForInvocation({
          change: {
            action: "log-search",
            reviewId,
            database: "PubMed",
            query: "sepsis",
            searchedOn: "2026-11-11",
            sourceIds: [record.sourceId],
          },
        }),
        fixture,
      );
      yield* run(
        updateSystematicReviewForInvocation({
          change: {
            action: "screen",
            reviewId,
            stage: "title-abstract",
            decisions: [{ sourceId: record.sourceId, decision: "include" }],
          },
        }),
        fixture,
      );
      expect(yield* Effect.promise(() => readScientProjectPins(fixture.root))).toEqual([]);
      const read = () =>
        run(readSystematicReviewsForInvocation({ reviewId, stage: "full-text" }), fixture);

      const fromLibrary = yield* read();
      expect(fromLibrary.review?.prisma).toMatchObject({ screened: 1 });
      expect(fromLibrary.review?.pending).toEqual([
        expect.objectContaining({ sourceId: record.sourceId, abstract: "Septic shock outcomes." }),
      ]);
      expect(fromLibrary.review?.pending[0]).not.toHaveProperty("label");

      yield* Effect.promise(() => NodeFSP.rm(fixture.libraryRoot, { recursive: true }));
      const fromSnapshot = yield* read();
      expect(fromSnapshot.review?.prisma).toMatchObject({ screened: 1 });
      expect(fromSnapshot.review?.pending).toEqual([
        expect.objectContaining({
          sourceId: record.sourceId,
          title: record.title,
          abstract: "Septic shock outcomes.",
          label: "From this review's snapshot",
        }),
      ]);
    }),
  );

  it.effect("an agent puts the sealed copy from before the move back into the project", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      yield* Effect.promise(() =>
        importScientSource({
          root: fixture.root,
          operationId: NodeCrypto.randomUUID(),
          candidate: candidate("v1"),
        }),
      );
      yield* run(listScientSourcesForInvocation({}), fixture);
      const records = NodePath.join(fixture.root, ".scient/sources/records");
      expect(yield* Effect.promise(() => exists(records))).toBe(false);
      expect(
        yield* run(
          organizeLibrarySourcesForInvocation({ change: { action: "restore-pre-move" } }),
          fixture,
        ),
      ).toEqual({ outcome: "restored", restoredSources: 1, restoredPdfs: 0 });
      expect(yield* Effect.promise(() => NodeFSP.readdir(records))).toHaveLength(1);
    }),
  );

  it.effect("an agent saves this project's package and imports it into another project", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const added = yield* addSource(fixture, "Packaged trial", "10.1000/packaged");
      yield* run(
        organizeLibrarySourcesForInvocation({
          change: { action: "pin", sourceId: added.sourceId!, note: "Why we cite it." },
        }),
        fixture,
      );
      const exported = yield* run(
        organizeLibrarySourcesForInvocation({
          change: { action: "export-package", relativePath: "handoff" },
        }),
        fixture,
      );
      expect(exported).toMatchObject({
        outcome: "exported",
        packagePath: "handoff",
        packageReport: { sources: 1, pins: 1, unavailable: 0 },
      });

      const other = yield* Effect.promise(async () => {
        const root = NodePath.join(fixture.base, "other");
        await NodeFSP.mkdir(root);
        await initializeScientProject({ root });
        await NodeFSP.cp(NodePath.join(fixture.root, "handoff"), NodePath.join(root, "handoff"), {
          recursive: true,
        });
        return { ...fixture, root, stateDir: NodePath.join(fixture.base, "other-state") };
      });
      expect(
        yield* run(
          organizeLibrarySourcesForInvocation({
            change: { action: "import-package", relativePath: "handoff" },
          }),
          other,
        ),
      ).toMatchObject({ outcome: "imported", packageReport: { sources: 1, pins: 1 } });
      expect(yield* Effect.promise(() => readScientProjectPins(other.root))).toMatchObject([
        { note: "Why we cite it." },
      ]);
    }),
  );

  it.effect("the list carries the move's summary until an agent dismisses it", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      yield* Effect.promise(async () => {
        await importScientSource({
          root: fixture.root,
          operationId: NodeCrypto.randomUUID(),
          candidate: candidate("v1"),
        });
        const bulk = NodePath.join(fixture.root, ".scient/sources/bulk-edits");
        await NodeFSP.mkdir(bulk, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(bulk, "batch_1.json"), "{}\n");
      });
      const moveOf = (result: object) => ("move" in result ? result.move : undefined);
      const readOnly = yield* run(listScientSourcesForInvocation({}), fixture, { write: false });
      expect(moveOf(readOnly)).toMatchObject({ state: "waiting" });

      const moved = yield* run(listScientSourcesForInvocation({}), fixture);
      expect(moveOf(moved)).toEqual({
        state: "done",
        message: expect.stringMatching(
          /^Your Library is in .+\. A copy of this project's sources from before the move is kept in \.scient\/library\/retained-before-library\/move_[0-9a-f]+\. Undo for bulk edits made before the move was not kept\.$/u,
        ),
      });
      expect(
        yield* run(
          organizeLibrarySourcesForInvocation({ change: { action: "dismiss-move-summary" } }),
          fixture,
        ),
      ).toEqual({ outcome: "dismissed" });
      expect(yield* run(listScientSourcesForInvocation({}), fixture)).not.toHaveProperty("move");

      const moveBack = () =>
        run(organizeLibrarySourcesForInvocation({ change: { action: "move-back" } }), fixture);
      expect(yield* moveBack()).toMatchObject({ outcome: "moved-back" });
      expect(yield* moveBack()).toEqual({ outcome: "not-moved" });
    }),
  );

  it.effect("a review's other version: listed, then kept, used or combined with a report", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const [first, second] = yield* Effect.promise(() =>
        Promise.all([libraryRecord(fixture, "first"), libraryRecord(fixture, "second")]),
      );
      const change = (
        action: Parameters<typeof updateSystematicReviewForInvocation>[0]["change"],
      ) => run(updateSystematicReviewForInvocation({ change: action }), fixture);
      const reviewId = (yield* change({ action: "create-review", title: "Sepsis review" }))
        .reviewId!;
      yield* change({
        action: "log-search",
        reviewId,
        database: "PubMed",
        query: "sepsis",
        searchedOn: "2026-11-11",
        sourceIds: [first.sourceId, second.sourceId],
      });
      yield* change({
        action: "screen",
        reviewId,
        stage: "title-abstract",
        decisions: [{ sourceId: first.sourceId, decision: "include" }],
      });
      const reviews = NodePath.join(fixture.root, ".scient/library/reviews");
      const reviewPath = NodePath.join(reviews, `${reviewId}.json`);
      // What a join writes for a copy of this project that decided otherwise.
      const plant = (edit: (review: Record<string, unknown>) => Record<string, unknown>) =>
        Effect.promise(async () => {
          const review = JSON.parse(await NodeFSP.readFile(reviewPath, "utf8"));
          const bytes = `${JSON.stringify(edit(review), null, 2)}\n`;
          const conflictId = NodeCrypto.createHash("sha256")
            .update(bytes)
            .digest("hex")
            .slice(0, 12);
          const folder = NodePath.join(fixture.root, ".scient/library/conflicts/reviews", reviewId);
          await NodeFSP.mkdir(folder, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(folder, `${conflictId}.json`), bytes);
          await NodeFSP.copyFile(
            NodePath.join(reviews, `${reviewId}.works.json`),
            NodePath.join(folder, `${conflictId}.works.json`),
          );
          return conflictId;
        });
      const excludedElsewhere = (review: Record<string, unknown>) => ({
        ...review,
        updatedAt: "2026-11-11T12:00:00.000Z",
        screening: [
          ...(review["screening"] as unknown[]),
          {
            sourceId: first.sourceId,
            stage: "title-abstract",
            decision: "exclude",
            decidedAt: "2026-11-11T12:00:00.000Z",
            decidedBy: "user",
          },
        ],
      });
      const store = yield* run(resolveScientSourcesStore(), fixture);
      if (store.kind !== "library") throw new Error("Expected the library backend.");

      const combined = yield* plant(excludedElsewhere);
      expect(
        (yield* Effect.promise(() => libraryReview(store, { reviewId }))).conflictVersions,
      ).toBe(1);
      expect(
        yield* Effect.promise(() => libraryReviewConflicts(store, { reviewId })),
      ).toMatchObject({
        current: { conflictId: null, decisions: 1 },
        versions: [{ conflictId: combined, decisions: 1, updatedAt: "2026-11-11T12:00:00.000Z" }],
        combineReport: null,
      });
      const read = () => run(readSystematicReviewsForInvocation({ reviewId }), fixture);
      expect((yield* read()).review?.conflicts).toEqual([
        expect.objectContaining({ conflictId: combined }),
      ]);
      const resolved = yield* run(
        updateLibrarySystematicReviewForInvocation({
          change: { action: "resolve-conflict", reviewId, conflictId: combined, pick: "combine" },
        }),
        fixture,
      );
      expect(resolved).toMatchObject({
        outcome: "resolved",
        combineReport: { reopened: [{ sourceId: first.sourceId, stage: "title-abstract" }] },
      });
      const afterCombine = (yield* read()).review;
      expect(afterCombine?.conflicts).toBeUndefined();
      expect(afterCombine?.combineReport?.reopened).toHaveLength(1);
      expect(
        yield* run(
          updateLibrarySystematicReviewForInvocation({
            change: { action: "dismiss-combine-report", reviewId },
          }),
          fixture,
        ),
      ).toMatchObject({ outcome: "dismissed" });
      expect((yield* read()).review?.combineReport).toBeUndefined();

      const inForce = yield* Effect.promise(() => NodeFSP.readFile(reviewPath, "utf8"));
      const kept = yield* plant(excludedElsewhere);
      expect(
        yield* Effect.promise(() =>
          changeLibraryReviewConflict(store, {
            reviewId,
            change: { action: "resolve", conflictId: kept, pick: "keep" },
          }),
        ),
      ).toEqual({ outcome: "resolved" });
      expect(yield* Effect.promise(() => NodeFSP.readFile(reviewPath, "utf8"))).toBe(inForce);

      const other = yield* plant((review) => ({ ...review, title: "Sepsis review, other copy" }));
      yield* Effect.promise(() =>
        changeLibraryReviewConflict(store, {
          reviewId,
          change: { action: "resolve", conflictId: other, pick: "use-other" },
        }),
      );
      expect((yield* read()).review?.title).toBe("Sepsis review, other copy");
      expect(
        (yield* Effect.promise(() => libraryReviewConflicts(store, { reviewId }))).versions,
      ).toEqual([]);
    }),
  );

  it.effect("an agent marks sources read and starred, and lists by either", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const first = yield* addSource(fixture, "Read this first", "10.1000/first");
      const second = yield* addSource(fixture, "Read this later", "10.1000/second");
      const sourceId = first.sourceId!;

      const marked = yield* run(
        updateLibrarySourceForInvocation({ sourceId, expectedRevision: 9, readingStatus: "read" }),
        fixture,
      );
      expect(marked).toEqual({
        outcome: "updated",
        sourceId,
        revision: 1,
        readingStatus: "read",
        starred: false,
      });
      yield* run(
        updateLibrarySourceForInvocation({
          sourceId: second.sourceId!,
          expectedRevision: 1,
          starred: true,
        }),
        fixture,
      );

      const ids = (input: Parameters<typeof listScientSourcesForInvocation>[0]) =>
        run(listScientSourcesForInvocation(input), fixture).pipe(
          Effect.map((listed) => listed.records.map((record) => record.sourceId)),
        );
      expect(yield* ids({ readingStatus: "read" })).toEqual([sourceId]);
      expect(yield* ids({ readingStatus: "unread", starred: true })).toEqual([second.sourceId]);
      expect(
        (yield* run(listScientSourcesForInvocation({ query: "first" }), fixture)).records,
      ).toMatchObject([{ sourceId, readingStatus: "read", starred: false }]);
      expect(yield* run(getScientSourceForInvocation({ sourceId }), fixture)).toMatchObject({
        revision: 1,
        readingStatus: "read",
        starred: false,
      });
      // A refused metadata edit leaves the reading state alone.
      const record = (yield* Effect.promise(() =>
        readScientSourceRecord(fixture.library, second.sourceId!),
      ))!;
      const refused = yield* run(
        updateLibrarySourceForInvocation({
          sourceId: second.sourceId!,
          expectedRevision: record.revision + 1,
          metadata: { ...editableMetadataFromRecord(record), title: "Edited too late" },
          readingStatus: "read",
        }),
        fixture,
      );
      expect(refused.outcome).toBe("stale");
      expect(yield* ids({ readingStatus: "read" })).toEqual([sourceId]);
      const empty = yield* Effect.flip(
        run(updateLibrarySourceForInvocation({ sourceId, expectedRevision: 1 }), fixture),
      );
      expect(empty.message).toBe("Give metadata, readingStatus or starred.");
    }),
  );
});
