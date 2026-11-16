// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { bibtexEntriesByKey } from "@scientfactory/scient-citations/bibliography";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import {
  listScientLibraryImportNotBrought,
  listScientLibraryRecentChanges,
} from "@scientfactory/scient-sources/library-changes";
import { readScientProjectPins } from "@scientfactory/scient-sources/project-pins";
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
import { beginBibliographyFileImport } from "../../../scient/sources/BibliographyFileAdapter.ts";
import {
  advanceSourceImport,
  importBibliographyFile,
} from "../../../scient/sources/ScientSourcesCoordinator.ts";
import type { ResolveSourceIdentifier } from "../../../scient/sources/SourceIdentifierResolver.ts";
import { ScientSourcesBackend } from "../../../scient/sources/SourcesBackend.ts";
import { fakeZoteroTransport, zoteroItem } from "../../../scient/sources/Zotero.testkit.ts";
import { ZoteroTransports } from "../../../scient/sources/ZoteroConnections.ts";
import {
  readSystematicReviewsForInvocation,
  updateSystematicReviewForInvocation,
} from "../systematicReviews/handlers.ts";
import { importScientSourcesFileForInvocation } from "./handlers.ts";
import { importZoteroForInvocation, refreshZoteroForInvocation } from "./zoteroHandlers.ts";

const fixtures: string[] = [];
const environmentId = EnvironmentId.make("environment-sources-intake");
const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sources-intake-")),
  );
  fixtures.push(base);
  const root = NodePath.join(base, "project");
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  const stateDir = NodePath.join(base, "state");
  const libraryRoot = scientLibraryRootFor(stateDir);
  return { root, stateDir, libraryRoot, library: scientLibraryLocation(libraryRoot) };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const ready = async () => ({ state: "ready" as const, apiVersion: 3, message: "Ready." });

/** A tool call in the project's thread, on the library backend. */
const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fixture: Fixture,
  options: {
    readonly write?: boolean;
    readonly zotero?: ReturnType<typeof fakeZoteroTransport>;
  } = {},
) => {
  const projectId = ProjectId.make("project-sources-intake");
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
        threadId: ThreadId.make("thread-sources-intake"),
        providerSessionId: "session-sources-intake",
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
    Effect.provideService(ZoteroTransports, {
      ...(options.zotero ? { local: options.zotero } : {}),
      inspectLocal: ready,
    }),
    Effect.provideService(ServerConfig, { stateDir: fixture.stateDir } as ServerConfig["Service"]),
    Effect.provideService(ScientSourcesBackend, "library"),
  );
};

/** A record another project brought into the library; it is not pinned here. */
async function libraryRecord(
  fixture: Fixture,
  sourceKey: string,
  overrides: Partial<ScientSourceCandidate>,
) {
  await ensureScientLibrary(fixture.libraryRoot);
  const imported = await importScientSource({
    root: fixture.library,
    operationId: NodeCrypto.randomUUID(),
    candidate: {
      sourceKey,
      type: "article",
      customType: null,
      title: null,
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
    },
  });
  if (!imported.record) throw new Error(`Expected ${sourceKey} to import.`);
  return imported.record;
}

const entry = (key: string, title: string, doi: string) =>
  `@article{${key},\n  title = {${title}},\n  author = {Lovelace, Ada},\n  year = {2026},\n  journal = {Scient Journal},\n  doi = {${doi}}\n}\n`;

/** Three works; the first is the library record `alreadyThere` makes. */
const REFERENCES = [
  entry("vasopressin2026", "Vasopressin timing in septic shock", "10.1000/vasopressin"),
  entry("lactate2026", "Lactate clearance after resuscitation", "10.1000/lactate"),
  entry("fluids2026", "Balanced fluids in children", "10.1000/fluids"),
].join("\n");

const alreadyThere = (fixture: Fixture) =>
  libraryRecord(fixture, "vasopressin", {
    title: "Vasopressin timing in septic shock",
    citationKey: "vasopressin2026",
    identifiers: [{ scheme: "doi", value: "10.1000/vasopressin" }],
  });

async function writeReferences(fixture: Fixture) {
  await NodeFSP.writeFile(NodePath.join(fixture.root, "refs.bib"), REFERENCES);
}

async function folderBytes(root: string): Promise<ReadonlyArray<readonly [string, string]>> {
  const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  const files = await Promise.all(
    entries
      .filter((item) => item.isFile())
      .map(async (item) => {
        const path = NodePath.join(item.parentPath, item.name);
        return [NodePath.relative(root, path), await NodeFSP.readFile(path, "base64")] as const;
      }),
  );
  return files.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

const listed = (path: string) => NodeFSP.readdir(path).catch(() => [] as string[]);

const managedKeys = async (fixture: Fixture) =>
  [
    ...bibtexEntriesByKey(
      await NodeFSP.readFile(NodePath.join(fixture.root, "references.bib"), "utf8"),
    ).keys(),
  ].toSorted();

const pinKeys = async (fixture: Fixture) =>
  (await readScientProjectPins(fixture.root)).map((pin) => pin.citationKey).toSorted();

describe("Sources intake on the library backend", () => {
  it.effect("a reference file pins what it imports and what was already there", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      yield* Effect.promise(() => alreadyThere(fixture));
      yield* Effect.promise(() => writeReferences(fixture));

      const result = yield* run(
        importScientSourcesFileForInvocation({ relativePath: "refs.bib" }),
        fixture,
      );

      expect(result).toMatchObject({ importedCount: 2, alreadyInLibrary: 1 });
      const keys = yield* Effect.promise(() => pinKeys(fixture));
      expect(keys).toEqual(["fluids2026", "lactate2026", "vasopressin2026"]);
      expect(yield* Effect.promise(() => managedKeys(fixture))).toEqual(keys);
      expect(result.imported.map((item) => item.citationKey).toSorted()).toEqual([
        "fluids2026",
        "lactate2026",
      ]);
      // The durable import lives in the library; the project store is never touched.
      const library = fixture.libraryRoot;
      expect(
        yield* Effect.promise(() => listed(NodePath.join(library, "operations"))),
      ).toHaveLength(1);
      expect(yield* Effect.promise(() => listed(NodePath.join(library, "receipts")))).toHaveLength(
        1,
      );
      const projectStore = NodePath.join(fixture.root, ".scient", "sources");
      for (const folder of ["operations", "receipts", "staging"]) {
        expect(yield* Effect.promise(() => listed(NodePath.join(projectStore, folder)))).toEqual(
          [],
        );
      }
    }),
  );

  it.effect("with pin false, a reference file goes into the library only", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      yield* Effect.promise(() => writeReferences(fixture));
      const before = yield* Effect.promise(() => folderBytes(fixture.root));

      const result = yield* run(
        importScientSourcesFileForInvocation({ relativePath: "refs.bib", pin: false }),
        fixture,
      );

      expect(result).toMatchObject({ importedCount: 3, alreadyInLibrary: 0 });
      expect(yield* Effect.promise(() => listScientSourceRecords(fixture.library))).toHaveLength(3);
      expect(yield* Effect.promise(() => readScientProjectPins(fixture.root))).toEqual([]);
      expect(yield* Effect.promise(() => folderBytes(fixture.root))).toEqual(before);
    }),
  );

  it.effect("an import advanced later, from the library alone, pins the rest", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      yield* Effect.promise(() => ensureScientLibrary(fixture.libraryRoot));
      const { operation } = yield* Effect.promise(() =>
        beginBibliographyFileImport({
          root: fixture.library,
          projectRoot: fixture.root,
          pinInto: fixture.root,
          operationId: "file_import",
          fileName: "refs.bib",
          text: REFERENCES,
          actor: "user",
        }),
      );
      const first = yield* Effect.promise(() =>
        advanceSourceImport({ root: fixture.library, operationId: operation!.operationId }),
      );
      expect(first.items.filter((item) => item.state === "pending")).toHaveLength(2);
      expect(yield* Effect.promise(() => readScientProjectPins(fixture.root))).toHaveLength(1);

      // Resumed with no project in hand: the operation names where its sources are pinned.
      let current = first;
      while (current.state === "running") {
        current = yield* Effect.promise(() =>
          advanceSourceImport({ root: fixture.library, operationId: current.operationId }),
        );
      }

      expect(current.state).toBe("completed");
      const keys = yield* Effect.promise(() => pinKeys(fixture));
      expect(keys).toEqual(["fluids2026", "lactate2026", "vasopressin2026"]);
      expect(yield* Effect.promise(() => managedKeys(fixture))).toEqual(keys);
    }),
  );

  it.effect("what a Zotero import did not bring stays on record with the import", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const zotero = fakeZoteroTransport({
        items: new Map([
          [
            "ABCD2345",
            {
              item: zoteroItem("ABCD2345", {
                itemType: "book",
                title: "A book with a place",
                abstractNote: "A.",
                ...({ place: "Leiden", edition: "2nd" } as object),
              }),
              children: [
                zoteroItem("SNAP2345", {
                  itemType: "attachment",
                  contentType: "text/html",
                  linkMode: "imported_url",
                }),
              ],
            },
          ],
        ]),
      });
      const imported = yield* run(importZoteroForInvocation({ itemKeys: ["ABCD2345"] }), fixture, {
        zotero,
      });
      const sourceId = imported.items[0]!.sourceId!;

      // Long after the summary was dismissed: the import's line counts it, and lists it.
      const change = (yield* Effect.promise(() =>
        listScientLibraryRecentChanges(fixture.library, 50),
      )).changes.find((entry) => entry.kind === "import");
      expect(change).toMatchObject({ kind: "import", imported: 1, notBrought: 1 });
      expect(
        yield* Effect.promise(() => listScientLibraryImportNotBrought(fixture.library, change!.id)),
      ).toEqual([
        { what: "Web page snapshots", amount: "1 on 1 reference", sourceIds: [sourceId] },
      ]);
      expect(
        yield* Effect.promise(() => listScientLibraryImportNotBrought(fixture.library, "no-such")),
      ).toEqual([]);
    }),
  );

  it.effect("a Zotero import keeps its base in the library; a refresh reaches the pin", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const original = zoteroItem(
        "ABCD2345",
        {
          title: "Original title",
          version: 3,
          creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }],
          date: "2026",
        },
        "475425",
      );
      const items = new Map([["ABCD2345", { item: original, children: [] }]]);
      const zotero = fakeZoteroTransport({ items });

      const imported = yield* run(importZoteroForInvocation({ itemKeys: ["ABCD2345"] }), fixture, {
        zotero,
      });
      const sourceId = imported.items[0]!.sourceId!;
      expect(imported).toMatchObject({ imported: 1 });
      expect(
        yield* Effect.promise(() => listed(NodePath.join(fixture.libraryRoot, "zotero"))),
      ).toEqual([`${sourceId}.json`]);
      expect(yield* Effect.promise(() => readScientProjectPins(fixture.root))).toMatchObject([
        { sourceId, work: { title: "Original title" } },
      ]);

      items.set("ABCD2345", {
        item: zoteroItem(
          "ABCD2345",
          { ...original.data, version: 4, title: "Zotero's new title" },
          "475425",
        ),
        children: [],
      });
      const refreshed = yield* run(refreshZoteroForInvocation({}), fixture, { zotero });

      expect(refreshed.items).toMatchObject([{ sourceId, outcome: "updated" }]);
      expect(yield* Effect.promise(() => readScientProjectPins(fixture.root))).toMatchObject([
        { sourceId, work: { title: "Zotero's new title" } },
      ]);
    }),
  );

  it.effect(
    "a read-only review read with no library comes from the snapshot, writing nothing",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const record = yield* Effect.promise(() =>
          libraryRecord(fixture, "screened", {
            title: "Septic shock outcomes",
            abstract: "Mortality at 28 days.",
          }),
        );
        const { reviewId } = yield* run(
          updateSystematicReviewForInvocation({
            change: { action: "create-review", title: "Sepsis review" },
          }),
          fixture,
        );
        yield* run(
          updateSystematicReviewForInvocation({
            change: {
              action: "log-search",
              reviewId: reviewId!,
              database: "PubMed",
              query: "sepsis",
              searchedOn: "2026-11-11",
              sourceIds: [record.sourceId],
            },
          }),
          fixture,
        );
        yield* Effect.promise(() => NodeFSP.rm(fixture.libraryRoot, { recursive: true }));
        const before = yield* Effect.promise(() =>
          Promise.all([folderBytes(fixture.root), folderBytes(fixture.stateDir)]),
        );

        const read = yield* run(
          readSystematicReviewsForInvocation({ reviewId: reviewId! }),
          fixture,
          {
            write: false,
          },
        );
        const listedReviews = yield* run(readSystematicReviewsForInvocation({}), fixture, {
          write: false,
        });

        expect(read.review?.pending).toEqual([
          expect.objectContaining({
            sourceId: record.sourceId,
            title: "Septic shock outcomes",
            abstract: "Mortality at 28 days.",
            label: "From this review's snapshot",
          }),
        ]);
        expect(listedReviews).toMatchObject({ reviews: [{ reviewId }] });
        expect(
          yield* Effect.promise(() =>
            Promise.all([folderBytes(fixture.root), folderBytes(fixture.stateDir)]),
          ),
        ).toEqual(before);
      }),
  );
});

describe("a reference file with two entries for one work and an author list cut short", () => {
  // The manual-review kit's references.bib: seven entries, six works.
  const KIT = String.raw`
@article{vaswani2017attention, title = {Attention Is All You Need}, author = {Vaswani, Ashish and Shazeer, Noam}, journal = {Advances in Neural Information Processing Systems}, year = {2017}, doi = {10.48550/arXiv.1706.03762}}
@inproceedings{devlin2019bert, title = {{BERT}: Pre-training of Deep Bidirectional Transformers for Language Understanding}, author = {Devlin, Jacob and Chang, Ming-Wei}, booktitle = {Proceedings of NAACL-HLT 2019}, year = {2019}, doi = {10.18653/v1/N19-1423}}
@article{lecun2015deep, title = {Deep learning}, author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}, journal = {Nature}, volume = {521}, pages = {436--444}, year = {2015}, doi = {10.1038/nature14539}}
@article{he2016resnet, title = {Deep Residual Learning for Image Recognition}, author = {He, Kaiming and Zhang, Xiangyu}, journal = {CVPR}, year = {2016}, doi = {10.1109/CVPR.2016.90}}
@article{jumper2021alphafold, title = {Highly accurate protein structure prediction with {AlphaFold}}, author = {Jumper, John and Evans, Richard and Pritzel, Alexander and others}, journal = {Nature}, volume = {596}, pages = {583--589}, year = {2021}, doi = {10.1038/s41586-021-03819-2}}
@book{goodfellow2016deep, title = {Deep Learning}, author = {Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron}, publisher = {MIT Press}, year = {2016}, isbn = {9780262035613}}
@article{lecun2015deep_copy, title = {Deep Learning}, author = {LeCun, Y. and Bengio, Y. and Hinton, G.}, journal = {Nature}, year = {2015}, doi = {10.1038/nature14539}}
`;
  const person = (familyName: string, givenName: string) => ({
    creatorType: "author",
    givenName,
    familyName,
    literalName: null,
  });
  const ALPHAFOLD_AUTHORS = [
    person("Jumper", "John"),
    person("Evans", "Richard"),
    person("Pritzel", "Alexander"),
    person("Green", "Tim"),
    person("Figurnov", "Michael"),
  ];
  const alphaFoldRegistry: ResolveSourceIdentifier = async ([identifier]) =>
    identifier?.value === "10.1038/s41586-021-03819-2"
      ? {
          status: "found",
          identifier,
          retrievedAt: "2026-11-15T00:00:00.000Z",
          metadata: {
            type: "article",
            title: "Highly accurate protein structure prediction with AlphaFold",
            creators: ALPHAFOLD_AUTHORS,
            issuedRaw: "2021-07-15",
            issuedYear: 2021,
            identifiers: [identifier],
            abstract: null,
            abstractSections: [],
            containerTitle: "Nature",
            publisher: null,
            volume: "596",
            issue: null,
            pages: "583-589",
            language: null,
            url: null,
          },
        }
      : identifier
        ? { status: "unavailable", identifier }
        : null;
  const importKit = (fixture: Fixture, operationId: string, resolve?: ResolveSourceIdentifier) =>
    importBibliographyFile({
      root: fixture.library,
      projectRoot: fixture.root,
      pinInto: fixture.root,
      operationId,
      fileName: "references.bib",
      text: KIT,
      actor: "user",
      ...(resolve ? { resolveIdentifier: resolve } : {}),
    });

  it("keeps both keys of the one work in the project, and takes the full author list from the DOI", async () => {
    const fixture = await setup();
    await ensureScientLibrary(fixture.libraryRoot);
    const { operation, report } = await importKit(fixture, "kit_1", alphaFoldRegistry);

    expect(operation?.items.filter((item) => item.state === "imported")).toHaveLength(6);
    expect(report).toMatchObject({
      entryCount: 7,
      importCount: 6,
      sameWork: [{ citationKey: "lecun2015deep_copy", sameAs: "lecun2015deep", identifier: "DOI" }],
    });
    expect(report.unreadable).toEqual([]);
    const records = await listScientSourceRecords(fixture.library);
    expect(records).toHaveLength(6);
    const pins = await readScientProjectPins(fixture.root);
    const deep = pins.filter((pin) => pin.citationKey.startsWith("lecun2015deep"));
    expect(deep.map((pin) => pin.citationKey)).toEqual(["lecun2015deep", "lecun2015deep_copy"]);
    expect(new Set(deep.map((pin) => pin.sourceId)).size).toBe(1);
    expect(await managedKeys(fixture)).toEqual(pins.map((pin) => pin.citationKey).toSorted());
    const deepItem = operation?.items.find((item) =>
      item.citationKeys?.some((key) => key.citationKey === "lecun2015deep"),
    );
    expect(deepItem?.citationKeys).toEqual([
      { citationKey: "lecun2015deep", outcome: "added" },
      { citationKey: "lecun2015deep_copy", outcome: "added" },
    ]);

    const alphaFold = records.find((record) => record.citationKey === "jumper2021alphafold");
    expect(alphaFold?.creators).toEqual(ALPHAFOLD_AUTHORS);
    expect(alphaFold?.incompleteCreatorRoles).toBeUndefined();
    // Only the authors come from the registry; the file's date stays.
    expect(alphaFold?.issuedRaw).toBe("2021");
    expect(operation?.items.find((item) => item.sourceId === alphaFold?.sourceId)).toMatchObject({
      authorList: "completed",
    });

    // The same file again adds no work and no key, and still says what it found.
    const again = await importKit(fixture, "kit_2", alphaFoldRegistry);
    expect(again.operation?.items.map((item) => item.state)).toEqual(
      Array.from({ length: 6 }, () => "skipped"),
    );
    expect(await listScientSourceRecords(fixture.library)).toHaveLength(6);
    expect(await readScientProjectPins(fixture.root)).toEqual(pins);
  });

  it("keeps an author list cut short as such when its DOI cannot fill it in", async () => {
    const fixture = await setup();
    await ensureScientLibrary(fixture.libraryRoot);
    const { operation } = await importKit(fixture, "kit_offline");

    const alphaFold = (await listScientSourceRecords(fixture.library)).find(
      (record) => record.citationKey === "jumper2021alphafold",
    );
    expect(alphaFold?.incompleteCreatorRoles).toEqual(["author"]);
    expect(operation?.items.find((item) => item.sourceId === alphaFold?.sourceId)).toMatchObject({
      authorList: "incomplete",
    });
    const managed = await NodeFSP.readFile(NodePath.join(fixture.root, "references.bib"), "utf8");
    expect(managed).toContain(
      "author = {Jumper, John and Evans, Richard and Pritzel, Alexander and others}",
    );
  });
});
