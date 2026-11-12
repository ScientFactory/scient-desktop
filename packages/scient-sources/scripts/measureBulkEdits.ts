// @effect-diagnostics nodeBuiltinImport:off -- A measurement script that builds real library and project folders.
/**
 * Times a bulk tag and its Undo on a large store, then pinning and unpinning; the scale gate reruns it.
 *   node scripts/measureBulkEdits.ts [--records 20000] [--edit 1000] [--backend library|project]
 *     [--part 100: in consecutive parts as the panel sends them, Undo newest first] [--pins-only]
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import { initializeScientProject } from "@scientfactory/project-init";

import { bulkUpdateScientSources } from "../src/collections.ts";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
  type ScientSourceStoreLocation,
} from "../src/libraryRoot.ts";
import type { ScientSourceCandidate } from "../src/model.ts";
import { changeScientProjectPins } from "../src/projectPins.ts";
import {
  importScientSource,
  readScientSourceRecord,
  SCIENT_SOURCES_DIRECTORY,
} from "../src/store.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    records: { type: "string", default: "20000" },
    edit: { type: "string", default: "1000" },
    backend: { type: "string", default: "library" },
    keep: { type: "boolean", default: false },
    part: { type: "string", default: "0" },
    "pins-only": { type: "boolean", default: false },
  },
});
const RECORDS = Number.parseInt(values.records, 10);
const EDIT = Number.parseInt(values.edit, 10);
const BACKEND = values.backend === "project" ? "project" : "library";
const PART = Number.parseInt(values.part, 10);

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

function candidate(index: number): ScientSourceCandidate {
  return {
    sourceKey: `measure-${index}`,
    type: "article",
    customType: null,
    title: `Synthetic study ${index}`,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: `Author${index}`, literalName: null },
    ],
    issuedRaw: String(1990 + (index % 35)),
    issuedYear: 1990 + (index % 35),
    identifiers: [{ scheme: "doi", value: `10.5555/measure.${index}` }],
    abstract: `An abstract of synthetic study ${index}. `.repeat(12),
    containerTitle: `Journal ${index % 40}`,
    publisher: null,
    volume: String(index % 30),
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [`tag-${index % 25}`],
    externalReferences: [],
    fieldProvenance: [],
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

/** One real import as a template, then the rest written as the store writes them. */
async function fillStore(
  location: ScientSourceStoreLocation,
  recordsDirectory: string,
): Promise<string[]> {
  const first = (
    await importScientSource({
      root: location,
      operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
      candidate: candidate(0),
      actor: "user",
      intake: "file",
    })
  ).record!;
  const template = (await readScientSourceRecord(location, first.sourceId))!;
  const sourceIds = [first.sourceId];
  for (let index = 1; index < RECORDS; index += 1) {
    const sourceId = `src_${sha256(`measure:${index}`).slice(0, 32)}`;
    const {
      sourceKey: _key,
      pdfAvailable: _a,
      pdfFileName: _f,
      pdfAttachmentCount: _c,
      ...rest
    } = candidate(index);
    await NodeFSP.writeFile(
      NodePath.join(recordsDirectory, `${sourceId}.json`),
      `${JSON.stringify({ ...template, ...rest, sourceId, citationKey: `author${index}` }, null, 2)}\n`,
    );
    sourceIds.push(sourceId);
  }
  return sourceIds;
}

const time = async <A>(run: () => Promise<A>): Promise<{ ms: number; value: A }> => {
  const started = performance.now();
  const value = await run();
  return { ms: Math.round(performance.now() - started), value };
};

const base = await NodeFSP.realpath(
  await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-bulk-measure-")),
);
try {
  const project = NodePath.join(base, "project");
  await NodeFSP.mkdir(project);
  await initializeScientProject({ root: project });
  const libraryRoot = scientLibraryRootFor(NodePath.join(base, "state"));
  await ensureScientLibrary(libraryRoot);
  const library = scientLibraryLocation(libraryRoot);
  const location: ScientSourceStoreLocation = BACKEND === "library" ? library : project;
  const recordsDirectory =
    BACKEND === "library"
      ? NodePath.join(libraryRoot, "records")
      : NodePath.join(project, ...SCIENT_SOURCES_DIRECTORY.split("/"), "records");
  const built = await time(() => fillStore(location, recordsDirectory));
  const sourceIds = built.value;
  const edited = sourceIds.slice(0, EDIT);
  const loadBefore = NodeOS.loadavg().map((value) => Math.round(value * 100) / 100);

  if (PART > 0) {
    const partMs: number[] = [];
    const batchIds: string[] = [];
    const started = performance.now();
    for (let start = 0; start < edited.length; start += PART) {
      const part = await time(() =>
        bulkUpdateScientSources({
          root: location,
          change: { sourceIds: edited.slice(start, start + PART), addTags: ["measured"] },
          actor: "user",
        }),
      );
      partMs.push(part.ms);
      if (part.value.undo) batchIds.push(part.value.undo.batchId);
    }
    const editMs = Math.round(performance.now() - started);
    const undoMs: number[] = [];
    const undoStarted = performance.now();
    for (const batchId of batchIds.toReversed()) {
      const part = await time(() =>
        bulkUpdateScientSources({
          root: location,
          change: { undoBatchId: batchId },
          actor: "user",
        }),
      );
      undoMs.push(part.ms);
    }
    const undoTotalMs = Math.round(performance.now() - undoStarted);
    const summary = (values: ReadonlyArray<number>) => ({
      first: values[0],
      max: Math.max(...values),
      median: values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)],
    });
    console.log(
      JSON.stringify(
        {
          machine: `${NodeOS.cpus()[0]?.model ?? "unknown"}, ${NodeOS.cpus().length} cores, ${Math.round(NodeOS.totalmem() / 2 ** 30)} GiB, ${NodeOS.type()} ${NodeOS.release()}, Node ${NodeProcess.version}`,
          backend: BACKEND,
          records: RECORDS,
          edited: edited.length,
          part: PART,
          parts: partMs.length,
          loadBefore,
          edit: { totalMs: editMs, firstProgressMs: partMs[0], perPartMs: summary(partMs) },
          undo: { totalMs: undoTotalMs, perPartMs: summary(undoMs) },
          loadAfter: NodeOS.loadavg().map((value) => Math.round(value * 100) / 100),
        },
        null,
        2,
      ),
    );
  } else {
    const tag = values["pins-only"]
      ? null
      : await time(() =>
          bulkUpdateScientSources({
            root: location,
            change: { sourceIds: edited, addTags: ["measured"] },
            actor: "user",
          }),
        );
    const undo =
      tag === null
        ? null
        : await time(() =>
            bulkUpdateScientSources({
              root: location,
              change: { undoBatchId: tag.value.undo!.batchId },
              actor: "user",
            }),
          );
    const pin =
      BACKEND === "library"
        ? await time(() =>
            changeScientProjectPins({
              projectRoot: project,
              library,
              changes: edited.map((sourceId) => ({ action: "pin" as const, sourceId })),
              actor: "user",
            }),
          )
        : null;
    const unpin =
      pin === null
        ? null
        : await time(() =>
            changeScientProjectPins({
              projectRoot: project,
              library,
              changes: pin.value.flatMap((entry) =>
                entry.outcome === "pinned"
                  ? [{ action: "unpin" as const, citationKey: entry.pin.citationKey }]
                  : [],
              ),
              actor: "user",
            }),
          );
    const count = (entries: ReadonlyArray<{ readonly outcome: string }>) =>
      Object.fromEntries(
        [...new Set(entries.map((entry) => entry.outcome))].map((outcome) => [
          outcome,
          entries.filter((entry) => entry.outcome === outcome).length,
        ]),
      );
    console.log(
      JSON.stringify(
        {
          machine: `${NodeOS.cpus()[0]?.model ?? "unknown"}, ${NodeOS.cpus().length} cores, ${Math.round(NodeOS.totalmem() / 2 ** 30)} GiB, ${NodeOS.type()} ${NodeOS.release()}, Node ${NodeProcess.version}`,
          backend: BACKEND,
          records: RECORDS,
          edited: edited.length,
          buildMs: built.ms,
          loadBefore,
          ...(tag ? { bulkTag: { ms: tag.ms, outcomes: count(tag.value.sources) } } : {}),
          ...(undo ? { undo: { ms: undo.ms, outcomes: count(undo.value.sources) } } : {}),
          ...(pin ? { pin: { ms: pin.ms, outcomes: count(pin.value) } } : {}),
          ...(unpin ? { unpin: { ms: unpin.ms, outcomes: count(unpin.value) } } : {}),
          loadAfter: NodeOS.loadavg().map((value) => Math.round(value * 100) / 100),
        },
        null,
        2,
      ),
    );
  }
} finally {
  if (!values.keep) await NodeFSP.rm(base, { recursive: true, force: true });
}
