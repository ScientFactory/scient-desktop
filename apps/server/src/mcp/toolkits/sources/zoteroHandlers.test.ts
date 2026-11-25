// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { listScientSourceRecords } from "@scientfactory/scient-sources/store";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { fakeZoteroTransport, zoteroItem } from "../../../scient/sources/Zotero.testkit.ts";
import { ZoteroTransports, type ZoteroAccess } from "../../../scient/sources/ZoteroConnections.ts";
import { ScientSourcesBackend } from "../../../scient/sources/SourcesBackend.ts";
import {
  browseZoteroForInvocation,
  importZoteroForInvocation,
  refreshZoteroForInvocation,
  sendToZoteroForInvocation,
} from "./zoteroHandlers.ts";

const roots: string[] = [];
const environmentId = EnvironmentId.make("environment-zotero-test");
const projectId = ProjectId.make("project-zotero-test");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-tools-"));
  roots.push(root);
  await initializeScientProject({ root });
  return root;
}

function inProject(root: string, transports: Omit<ZoteroAccess, "webKey">) {
  const fixture = workspaceResolverForTest(
    new Map([[root, { projectId, scope: workspaceScopeForTest(`binding:${root}`, root) }]]),
  );
  const resolveThread = () =>
    fixture.resolveWorkspaceRoot(root).pipe(
      Effect.map((resolved) => ({
        ...resolved,
        binding: { ...resolved.binding, environmentId, hostProjectId: projectId },
      })),
    );
  const resolver: WorkspaceBindingResolver["Service"] = {
    ...fixture,
    resolveThread,
    assertCurrentThreadScope: () =>
      resolveThread().pipe(Effect.map((resolved) => resolved.binding)),
  };
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        AgentInvocationContext.AgentInvocationContext,
        AgentInvocationContext.AgentInvocationContext.of({
          environmentId,
          threadId: ThreadId.make("thread-zotero-test"),
          providerSessionId: "session-zotero-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["sources:read", "sources:write"]),
          issuedAt: 1,
        }),
      ),
      Effect.provideService(WorkspaceBindingResolver, resolver),
      Effect.provideService(ZoteroTransports, transports),
      Effect.provideService(ScientSourcesBackend, "project"),
    );
}

const library = (libraryId: string | number = 0) => ({
  items: new Map([
    [
      "ABCD2345",
      {
        item: zoteroItem(
          "ABCD2345",
          { title: "First", abstractNote: "A.", collections: [] },
          libraryId,
        ),
        children: [],
      },
    ],
    [
      "EFGH2345",
      {
        item: zoteroItem("EFGH2345", { title: "Second", abstractNote: "B." }, libraryId),
        children: [],
      },
    ],
  ]),
});

const ready = async () => ({ state: "ready" as const, apiVersion: 3, message: "Ready." });

describe("Zotero agent tools", () => {
  it.effect("imports what the agent picked and marks it in the next browse", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(project);
      const local = fakeZoteroTransport(library());
      const run = inProject(root, { local, inspectLocal: ready });

      const imported = yield* run(importZoteroForInvocation({ itemKeys: ["ABCD2345"] }));
      const browse = yield* run(browseZoteroForInvocation({}));

      expect(imported).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
      const records = yield* Effect.promise(() => listScientSourceRecords(root));
      expect(records.map((record) => record.origin?.actor)).toEqual(["agent"]);
      expect(browse.items.find((item) => item.itemKey === "ABCD2345")?.sourceId).toBe(
        records[0]?.sourceId,
      );
      expect(browse.items.find((item) => item.itemKey === "EFGH2345")?.sourceId).toBeNull();
    }),
  );

  it.effect("takes a collection with its subcollections, as the panel does", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(project);
      const filed = (key: string, title: string, collection: string) =>
        [
          key,
          {
            item: zoteroItem(key, { title, abstractNote: "A.", collections: [collection] }),
            children: [],
          },
        ] as const;
      const local = fakeZoteroTransport({
        items: new Map([
          filed("ABCD2345", "In the collection", "TOPC2345"),
          filed("EFGH2345", "In a subcollection", "SUBC2345"),
          filed("JKLM2345", "Elsewhere", "OTHR2345"),
        ]),
        collections: [
          { key: "TOPC2345", name: "Thesis" },
          { key: "SUBC2345", name: "Chapter 1", parent: "TOPC2345" },
          { key: "OTHR2345", name: "Teaching" },
        ],
      });
      const run = inProject(root, { local, inspectLocal: ready });

      const browse = yield* run(browseZoteroForInvocation({ collectionKey: "TOPC2345" }));
      const imported = yield* run(importZoteroForInvocation({ collectionKey: "TOPC2345" }));

      expect(browse.items.map((item) => item.title).toSorted()).toEqual([
        "In a subcollection",
        "In the collection",
      ]);
      expect(imported).toMatchObject({ imported: 2, failed: 0 });
    }),
  );

  it.effect("tells the agent what Zotero holds that the import did not bring", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(project);
      const local = fakeZoteroTransport({
        items: new Map([
          [
            "ABCD2345",
            {
              item: zoteroItem("ABCD2345", {
                itemType: "book",
                title: "A book",
                abstractNote: "A.",
                ...({ place: "Leiden" } as object),
              }),
              children: [],
            },
          ],
          [
            "LONE2345",
            {
              item: zoteroItem("LONE2345", { itemType: "note", note: "<p>Ideas</p>" }),
              children: [],
            },
          ],
        ]),
      });
      const run = inProject(root, { local, inspectLocal: ready });

      const imported = yield* run(importZoteroForInvocation({ all: true }));

      expect(imported).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
      expect(
        (yield* Effect.promise(() => listScientSourceRecords(root))).map(({ title, type }) => ({
          title,
          type,
        })),
      ).toEqual([{ title: "A book", type: "book" }]);
      expect(imported.notBrought?.map(({ amount }) => amount)).toEqual(["1"]);
    }),
  );

  it.effect("imports the whole library once, skipping what is already there", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(project);
      const run = inProject(root, {
        local: fakeZoteroTransport(library("475425")),
        inspectLocal: ready,
      });

      const first = yield* run(importZoteroForInvocation({ all: true }));
      const second = yield* run(importZoteroForInvocation({ all: true }));
      const refreshed = yield* run(refreshZoteroForInvocation({}));

      expect(first).toMatchObject({ imported: 2, skipped: 0 });
      expect(second).toMatchObject({ imported: 0, skipped: 2 });
      expect(second.items.every((item) => item.duplicate === "same-origin")).toBe(true);
      expect(refreshed).toMatchObject({ connection: "local", unchanged: 2, items: [] });
    }),
  );

  it.effect("tells the agent what to do when Zotero cannot be reached", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(project);
      const run = inProject(root, {
        inspectLocal: async () => ({
          state: "unreachable",
          apiVersion: null,
          message: "Open Zotero on the computer running this project, then check again.",
        }),
      });

      const browse = yield* run(browseZoteroForInvocation({}));
      const importError = yield* run(importZoteroForInvocation({ all: true })).pipe(Effect.flip);
      const sendError = yield* run(sendToZoteroForInvocation({ sourceIds: ["source_x"] })).pipe(
        Effect.flip,
      );

      expect(browse).toMatchObject({ state: "unreachable", items: [] });
      expect(importError.code).toBe("operation-failed");
      expect(sendError.code).toBe("operation-failed");
    }),
  );
});
