// @effect-diagnostics nodeBuiltinImport:off -- Synthetic project filesystem fixtures only.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import {
  listScientSourceRecords,
  readScientSourceStagedMaterial,
  stagedScientSourcePdfAbsolutePath,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  addAgentSource,
  advanceSourceImport,
  beginLocalPdfImport,
  beginZoteroImport,
  cancelSourceImport,
  getScientSourcesOverview,
  retrySourceImport,
  uploadLocalPdfSource,
} from "../scient/sources/ScientSourcesCoordinator.ts";
import {
  observeSourceImport,
  type SourceImportObserver,
} from "../scient/sources/SourceImportObservation.ts";
import { getZoteroImportMaterial } from "../scient/sources/ZoteroLocalAdapter.ts";
import { discardLocalPdfImportMaterial } from "../scient/sources/LocalPdfSourceAdapter.ts";
import { AnalyticsService, type AnalyticsStatus } from "./AnalyticsService.ts";
import { makeSourceImportAnalytics } from "./SourceImportAnalytics.ts";

vi.mock("../scient/sources/ZoteroLocalAdapter.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scient/sources/ZoteroLocalAdapter.ts")>()),
  getZoteroImportMaterial: vi.fn(),
}));

vi.mock("../scient/sources/LocalPdfSourceAdapter.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../scient/sources/LocalPdfSourceAdapter.ts")>();
  return {
    ...original,
    discardLocalPdfImportMaterial: vi.fn(original.discardLocalPdfImportMaterial),
  };
});

const roots: string[] = [];
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const privateMarker = "PRIVATE_RESEARCH_CONTENT";
const candidate: ScientSourceCandidate = {
  sourceKey: "ABCD2345",
  type: "article",
  customType: null,
  title: privateMarker,
  creators: [],
  issuedRaw: null,
  issuedYear: null,
  identifiers: [{ scheme: "doi", value: "10.1000/private-research" }],
  abstract: privateMarker,
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

async function project() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-import-analytics-"));
  roots.push(root);
  await initializeScientProject({ root });
  return root;
}

function analyticsFixture(consent: AnalyticsStatus["consent"] = "product") {
  const events: { name: string; properties: Readonly<Record<string, unknown>> | undefined }[] = [];
  let status: AnalyticsStatus = { available: true, consent };
  let epoch = 0;
  const changeConsent = (next: AnalyticsStatus["consent"]) => {
    status = { available: true, consent: next };
    epoch += 1;
    return status;
  };
  const service = AnalyticsService.of({
    record: (name, properties) =>
      Effect.sync(() => {
        events.push({ name, properties });
      }),
    status: Effect.sync(() => status),
    collectionEpoch: Effect.sync(() => epoch),
    setConsent: (next) => Effect.sync(() => changeConsent(next)),
    deleteData: Effect.succeed(true),
    flush: Effect.void,
  });
  const observer = (trigger: "user" | "agent" = "user", provided = service) =>
    makeSourceImportAnalytics(trigger).pipe(Effect.provideService(AnalyticsService, provided));
  return { events, service, observer, changeConsent };
}

async function localOperation(root: string, operationId: string, content = privateMarker) {
  const sourcePath = NodePath.join(root, `${operationId}.pdf`);
  const body = `%PDF-1.7\n${content}\n`;
  await NodeFSP.writeFile(sourcePath, body, "utf8");
  const { item } = await uploadLocalPdfSource({ root, sourcePath, fileName: `${operationId}.pdf` });
  const itemKey = item.candidate.sourceKey;
  await beginLocalPdfImport({
    root,
    operationId,
    itemKeys: [itemKey],
    possibleMetadataMatchOverrides: [],
  });
  return { itemKey, body };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("source import outcome analytics", () => {
  it.effect(
    "keeps a saved source completion when later batch cleanup fails and retry skips it",
    () =>
      Effect.gen(function* () {
        const f = analyticsFixture();
        const observer = yield* f.observer();
        yield* Effect.promise(async () => {
          const root = await project();
          const keys = [];
          for (const name of ["first", "second"]) {
            const path = NodePath.join(root, `${name}.pdf`);
            await NodeFSP.writeFile(path, `%PDF-1.7\n${name}\n`, "utf8");
            const { item } = await uploadLocalPdfSource({
              root,
              sourcePath: path,
              fileName: `${name}.pdf`,
            });
            keys.push(item.candidate.sourceKey);
          }
          const operationId = "cleanup";
          await beginLocalPdfImport({
            root,
            operationId,
            itemKeys: keys,
            possibleMetadataMatchOverrides: [],
          });
          vi.mocked(discardLocalPdfImportMaterial).mockRejectedValueOnce(
            new Error("PRIVATE cleanup failure"),
          );
          const failed = await advanceSourceImport({ root, operationId }, observer);
          expect(failed.items.map((item) => item.state)).toEqual(["failed", "pending"]);
          expect(await listScientSourceRecords(root)).toHaveLength(1);
          await retrySourceImport({ root, operationId, itemKeys: [keys[0]!] });
          const retried = await advanceSourceImport({ root, operationId }, observer);
          expect(retried.items.map((item) => item.state)).toEqual(["skipped", "pending"]);
          await advanceSourceImport({ root, operationId }, observer);
          expect(await listScientSourceRecords(root)).toHaveLength(2);
          expect(f.events.map((event) => event.name)).toEqual([
            "scient.operation.started",
            "scient.operation.completed",
            "scient.operation.started",
            "scient.operation.skipped",
            "scient.operation.started",
            "scient.operation.completed",
          ]);
          expect(encodeJson(f.events)).not.toContain("PRIVATE");
        });
      }),
  );
  it.effect(
    "counts actual saved items once; duplicate skips and polling are not useful completions",
    () =>
      Effect.gen(function* () {
        const f = analyticsFixture();
        const observer = yield* f.observer();
        yield* Effect.promise(async () => {
          const root = await project();
          await localOperation(root, "first");
          expect(f.events).toHaveLength(0);
          await Promise.all([
            advanceSourceImport({ root, operationId: "first" }, observer),
            advanceSourceImport({ root, operationId: "first" }, observer),
          ]);
          await getScientSourcesOverview(root);
          await advanceSourceImport({ root, operationId: "first" }, observer);
          await localOperation(root, "duplicate");
          const duplicate = await advanceSourceImport({ root, operationId: "duplicate" }, observer);
          expect(duplicate.items[0]?.state).toBe("skipped");
          expect(await listScientSourceRecords(root)).toHaveLength(1);
          expect(f.events.map((event) => event.name)).toEqual([
            "scient.operation.started",
            "scient.operation.completed",
            "scient.operation.started",
            "scient.operation.skipped",
          ]);
          expect(f.events[1]?.properties).toMatchObject({
            operationKind: "source-import",
            trigger: "user",
            reviewRequired: false,
          });
          expect(encodeJson(f.events)).not.toMatch(
            /PRIVATE_RESEARCH_CONTENT|scient-import-analytics|\.pdf|sourceKey|sourceId|operationId/u,
          );
        });
      }),
  );

  it.effect(
    "records a failed item and its real retry, never treating a settled batch as success",
    () =>
      Effect.gen(function* () {
        const f = analyticsFixture();
        const observer = yield* f.observer();
        yield* Effect.promise(async () => {
          const root = await project();
          const operationId = "retry";
          const { itemKey, body } = await localOperation(root, operationId);
          const material = await readScientSourceStagedMaterial(root, itemKey);
          const stagedPath = await stagedScientSourcePdfAbsolutePath(root, material);
          await NodeFSP.writeFile(stagedPath, "%PDF-1.7\nchanged\n", "utf8");
          const failed = await advanceSourceImport({ root, operationId }, observer);
          expect(failed.state).toBe("completed");
          expect(failed.items[0]?.state).toBe("failed");
          await advanceSourceImport({ root, operationId }, observer);
          await NodeFSP.writeFile(stagedPath, body, "utf8");
          await retrySourceImport({ root, operationId, itemKeys: [itemKey] });
          expect(f.events).toHaveLength(2);
          expect((await advanceSourceImport({ root, operationId }, observer)).items[0]?.state).toBe(
            "imported",
          );
          expect(f.events.map((event) => event.name)).toEqual([
            "scient.operation.started",
            "scient.operation.failed",
            "scient.operation.started",
            "scient.operation.completed",
          ]);
          expect(f.events[1]?.properties?.failureClass).toBe("unknown");
        });
      }),
  );

  it.effect("does not count cancelled unprocessed work or restored terminal history", () =>
    Effect.gen(function* () {
      const f = analyticsFixture();
      const observer = yield* f.observer();
      yield* Effect.promise(async () => {
        const root = await project();
        await localOperation(root, "cancelled");
        await cancelSourceImport({ root, operationId: "cancelled" });
        await advanceSourceImport({ root, operationId: "cancelled" }, observer);
        await localOperation(root, "historical");
        await advanceSourceImport({ root, operationId: "historical" });
        await advanceSourceImport({ root, operationId: "historical" }, observer);
        expect(f.events).toHaveLength(0);
      });
    }),
  );

  it.effect(
    "observes mixed Zotero batch results without exporting source metadata or error text",
    () =>
      Effect.gen(function* () {
        const f = analyticsFixture();
        const observer = yield* f.observer();
        yield* Effect.promise(async () => {
          const root = await project();
          vi.mocked(getZoteroImportMaterial)
            .mockResolvedValueOnce({ candidate, pdfPath: null })
            .mockRejectedValueOnce(new Error(`secret /private/path ${privateMarker}`));
          await beginZoteroImport({
            root,
            operationId: "zotero",
            itemKeys: ["ABCD2345", "ABCD2346"],
            possibleMetadataMatchOverrides: [],
          });
          expect((await advanceSourceImport({ root, operationId: "zotero" }, observer)).state).toBe(
            "running",
          );
          const completed = await advanceSourceImport({ root, operationId: "zotero" }, observer);
          expect(completed.items.map((item) => item.state)).toEqual(["imported", "failed"]);
          expect(f.events.map((event) => event.name)).toEqual([
            "scient.operation.started",
            "scient.operation.completed",
            "scient.operation.started",
            "scient.operation.failed",
          ]);
          expect(encodeJson(f.events)).not.toMatch(/PRIVATE|private|ABCD|sourceKey|\.pdf/u);
        });
      }),
  );

  for (const initial of ["off", "product"] as const) {
    it.effect(`does not replay an in-progress import after ${initial} -> Off -> Product`, () =>
      Effect.gen(function* () {
        const f = analyticsFixture(initial);
        const observer = yield* f.observer();
        yield* Effect.promise(async () => {
          const root = await project();
          const resetDuringAttempt: SourceImportObserver = async () => {
            const finish = await observer?.();
            f.changeConsent("off");
            f.changeConsent("product");
            return finish;
          };
          await localOperation(root, "before");
          await advanceSourceImport({ root, operationId: "before" }, resetDuringAttempt);
          expect(f.events.map((event) => event.name)).toEqual(
            initial === "off" ? [] : ["scient.operation.started"],
          );
          await localOperation(root, "after", "new private content");
          await advanceSourceImport({ root, operationId: "after" }, observer);
          expect(f.events.slice(-2).map((event) => event.name)).toEqual([
            "scient.operation.started",
            "scient.operation.completed",
          ]);
        });
      }),
    );
  }

  it.effect(
    "leaves actual import and duplicate behavior intact when the analytics service defects",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => project());
        const f = analyticsFixture();
        for (const service of [
          { ...f.service, status: Effect.die("analytics status failure") },
          { ...f.service, record: () => Effect.die("analytics record failure") },
        ]) {
          const observer = yield* f.observer("agent", service);
          yield* Effect.promise(() => addAgentSource({ root, candidate }, observer));
        }
        expect(yield* Effect.promise(() => listScientSourceRecords(root))).toHaveLength(1);
        expect(f.events).toHaveLength(0);
      }),
  );

  it("keeps the exact product result/error and execution count even when observers throw", async () => {
    const result = { private: privateMarker };
    const failure = new Error(privateMarker);
    let runs = 0;
    const observers: SourceImportObserver[] = [
      async () => {
        throw new Error("start failed");
      },
      async () => async () => {
        throw new Error("finish failed");
      },
    ];
    for (const observer of observers) {
      expect(
        await observeSourceImport(
          observer,
          async () => {
            runs += 1;
            return result;
          },
          () => "imported",
        ),
      ).toBe(result);
      await expect(
        observeSourceImport(
          observer,
          async () => {
            runs += 1;
            throw failure;
          },
          () => "imported",
        ),
      ).rejects.toBe(failure);
    }
    expect(runs).toBe(4);
  });

  it.effect("has no global observer state and closes each attempt at most once", () =>
    Effect.gen(function* () {
      expect(yield* makeSourceImportAnalytics("user")).toBeUndefined();
      const f = analyticsFixture();
      const observer = yield* f.observer("agent");
      yield* Effect.promise(async () => {
        const finish = await observer?.();
        await Promise.all([finish?.("imported"), finish?.("failed")]);
      });
      expect(f.events.map((event) => event.name)).toEqual([
        "scient.operation.started",
        "scient.operation.completed",
      ]);
      expect(f.events[1]?.properties).toMatchObject({ trigger: "agent", reviewRequired: true });
    }),
  );

  it.effect(
    "does not inspect a result while Off, or turn a classifier defect into a product error",
    () =>
      Effect.gen(function* () {
        const f = analyticsFixture("off");
        const observer = yield* f.observer();
        const result = { private: privateMarker };
        const classify = vi.fn(() => {
          throw new Error("classification failed");
        });
        expect(
          yield* Effect.promise(() => observeSourceImport(observer, async () => result, classify)),
        ).toBe(result);
        expect(classify).not.toHaveBeenCalled();
        yield* f.service.setConsent("product");
        expect(
          yield* Effect.promise(() => observeSourceImport(observer, async () => result, classify)),
        ).toBe(result);
        expect(classify).toHaveBeenCalledTimes(1);
        expect(f.events.map((event) => event.name)).toEqual(["scient.operation.started"]);
      }),
  );
});
