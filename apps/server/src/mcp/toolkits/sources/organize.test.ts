// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { writeScientSourceCategories } from "@scientfactory/scient-sources/categories-store";
import {
  readScientSourceRecord,
  SCIENT_SOURCE_RECORDS_DIRECTORY,
} from "@scientfactory/scient-sources/store";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import {
  bulkUpdateScientSourcesForInvocation,
  listScientSourcesForInvocation,
  organizeScientSourcesForInvocation,
  readScientSourceCollectionsForInvocation,
} from "./handlers.ts";

const fixtures: string[] = [];
const environmentId = EnvironmentId.make("environment-sources-organize");
const threadId = ThreadId.make("thread-sources-organize");

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(
  sources: ReadonlyArray<{
    readonly sourceId: string;
    readonly title: string;
    readonly tags?: ReadonlyArray<string>;
    readonly doi?: string;
  }>,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sources-organize-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  const identity = await readScientProjectIdentity(root);
  const directory = NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY);
  await NodeFSP.mkdir(directory, { recursive: true });
  for (const source of sources) {
    const record = {
      formatVersion: 1,
      sourceId: source.sourceId,
      projectId: identity.projectId,
      revision: 1,
      type: "article",
      title: source.title,
      creators: [],
      issuedRaw: null,
      issuedYear: 2024,
      identifiers: source.doi ? [{ scheme: "doi", value: source.doi }] : [],
      abstract: null,
      containerTitle: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
      tags: source.tags ?? [],
      externalReferences: [],
      attachments: [],
      fieldProvenance: [],
      importedAt: "2026-11-10T12:00:00.000Z",
    };
    await NodeFSP.writeFile(
      NodePath.join(directory, `${source.sourceId}.json`),
      JSON.stringify(record),
      "utf8",
    );
  }
  return root;
}

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>, root: string) => {
  const projectId = ProjectId.make("project-sources-organize");
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
        threadId,
        providerSessionId: "session-sources-organize",
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
  );
};

describe("Sources organize tools", () => {
  it.effect("gives agents the same collections, saved searches and bulk edits as the panel", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        project([
          { sourceId: "source_trial", title: "Sepsis trial", tags: ["RCT"] },
          { sourceId: "source_cohort", title: "Sepsis cohort" },
          { sourceId: "source_other", title: "Unrelated" },
        ]),
      );

      const created = yield* provide(
        organizeScientSourcesForInvocation({
          change: {
            action: "create-collection",
            name: "Sepsis",
            sourceIds: ["source_trial", "source_cohort", "source_unknown"],
          },
        }),
        root,
      );
      expect(created).toMatchObject({
        outcome: "created",
        collection: {
          name: "Sepsis",
          sourceIds: ["source_trial", "source_cohort"],
          updatedBy: "agent",
        },
        unknownSourceIds: ["source_unknown"],
      });
      const collectionId = created.collection?.collectionId ?? "";

      const bulk = yield* provide(
        bulkUpdateScientSourcesForInvocation({
          change: { sourceIds: ["source_trial", "source_cohort"], addTags: ["Screened"] },
        }),
        root,
      );
      expect(bulk.sources.map((entry) => entry.outcome)).toEqual(["updated", "updated"]);
      const trial = yield* Effect.promise(() => readScientSourceRecord(root, "source_trial"));
      expect(trial).toMatchObject({ tags: ["RCT", "Screened"], updatedBy: "agent", revision: 2 });

      const saved = yield* provide(
        organizeScientSourcesForInvocation({
          change: {
            action: "save-search",
            name: "Screened RCTs",
            filter: { tags: ["rct", "screened"] },
          },
        }),
        root,
      );
      const searchId = saved.savedSearch?.searchId ?? "";

      const bySearch = yield* provide(
        listScientSourcesForInvocation({ savedSearchId: searchId }),
        root,
      );
      expect(bySearch.records.map((record) => record.sourceId)).toEqual(["source_trial"]);
      expect(bySearch.records[0]?.tags).toEqual(["RCT", "Screened"]);

      const byCollection = yield* provide(
        listScientSourcesForInvocation({ collectionId, query: "cohort" }),
        root,
      );
      expect(byCollection.records.map((record) => record.sourceId)).toEqual(["source_cohort"]);

      const overview = yield* provide(readScientSourceCollectionsForInvocation(), root);
      expect(overview).toEqual({
        collections: [{ collectionId, name: "Sepsis", sourceCount: 2 }],
        savedSearches: [{ searchId, name: "Screened RCTs", filter: { tags: ["rct", "screened"] } }],
        tags: [
          { tag: "Screened", count: 2 },
          { tag: "RCT", count: 1 },
        ],
        studyDesigns: [],
        topics: [],
      });
    }),
  );

  it.effect("filters by study design and topic, and sorts into nested themes with one Undo", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        project([
          { sourceId: "source_trial", title: "Sepsis trial", doi: "10.1000/trial" },
          { sourceId: "source_cohort", title: "Sepsis cohort", doi: "10.1000/cohort" },
          { sourceId: "source_edited", title: "DOI changed since", doi: "10.1000/new" },
        ]),
      );
      const topic = { scheme: "openalex" as const, id: "T1", name: "Sepsis care", score: 0.9 };
      yield* Effect.promise(() =>
        writeScientSourceCategories(root, {
          source_trial: {
            basis: "doi:10.1000/trial",
            checkedAt: "2026-11-11T00:00:00.000Z",
            studyDesign: "randomized-trial",
            topics: [topic],
          },
          source_cohort: {
            basis: "doi:10.1000/cohort",
            checkedAt: "2026-11-11T00:00:00.000Z",
            studyDesign: "cohort",
            topics: [topic],
          },
          // Looked up by an identifier the source no longer has, so it no longer applies.
          source_edited: {
            basis: "doi:10.1000/old",
            checkedAt: "2026-11-11T00:00:00.000Z",
            studyDesign: "randomized-trial",
          },
        }),
      );
      const trials = yield* provide(
        listScientSourcesForInvocation({ studyDesign: "randomized-trial" }),
        root,
      );
      expect(trials.records.map((record) => [record.sourceId, record.topics])).toEqual([
        ["source_trial", ["Sepsis care"]],
      ]);
      const byTopic = yield* provide(
        listScientSourcesForInvocation({ topic: "sepsis CARE" }),
        root,
      );
      expect(byTopic.total).toBe(2);

      const sorted = yield* provide(
        bulkUpdateScientSourcesForInvocation({
          change: {
            themes: [
              { name: "Trials", parent: "Sepsis", sourceIds: ["source_trial"] },
              { name: "Cohorts", parent: "Sepsis", sourceIds: ["source_cohort"] },
            ],
          },
        }),
        root,
      );
      const overview = yield* provide(readScientSourceCollectionsForInvocation(), root);
      const parent = overview.collections.find((collection) => collection.name === "Sepsis");
      expect(
        overview.collections.map((collection) => [
          collection.name,
          collection.parentCollectionId === parent?.collectionId,
          collection.sourceCount,
        ]),
      ).toEqual([
        ["Sepsis", false, 0],
        ["Trials", true, 1],
        ["Cohorts", true, 1],
      ]);
      const inParent = yield* provide(
        listScientSourcesForInvocation({ collectionId: parent!.collectionId }),
        root,
      );
      expect(inParent.total).toBe(2);

      yield* provide(
        bulkUpdateScientSourcesForInvocation({ change: { undoBatchId: sorted.undo!.batchId } }),
        root,
      );
      const undone = yield* provide(readScientSourceCollectionsForInvocation(), root);
      expect(undone.collections).toEqual([]);
    }),
  );

  it.effect("reports an unknown saved search instead of listing everything", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => project([{ sourceId: "source_a", title: "A" }]));
      const result = yield* provide(
        listScientSourcesForInvocation({ savedSearchId: "search_missing" }),
        root,
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("not-found");
    }),
  );
});
