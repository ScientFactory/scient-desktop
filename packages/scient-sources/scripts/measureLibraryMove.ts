// @effect-diagnostics nodeBuiltinImport:off -- A measurement script that builds real project and library folders.
// @effect-diagnostics globalDate:off globalTimers:off -- It times the move with the wall clock.
/**
 * Times the one-time move of a large v1 project into the library: the whole move, and the longest
 * time another library writer waited for the library lock during it. Not part of any test suite;
 * the scale gate reruns it.
 *
 *   node scripts/measureLibraryMove.ts [--records 5000] [--pdfs 1250] [--keep]
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import { initializeScientProject } from "@scientfactory/project-init";

import { organizeScientSources } from "../src/collections.ts";
import { withScientLibraryLock } from "../src/libraryLock.ts";
import { runScientLibraryMove, type ScientLibraryMoveProgress } from "../src/libraryMove.ts";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "../src/libraryRoot.ts";
import type { ScientSourceCandidate } from "../src/model.ts";
import {
  attachScientSourcePdf,
  importScientSource,
  readScientSourceRecord,
  SCIENT_SOURCES_DIRECTORY,
} from "../src/store.ts";
import { changeScientSystematicReview } from "../src/systematicReviewStore.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    records: { type: "string", default: "5000" },
    pdfs: { type: "string", default: "1250" },
    keep: { type: "boolean", default: false },
  },
});
const RECORDS = Number.parseInt(values.records, 10);
const PDFS = Number.parseInt(values.pdfs, 10);

const sha256 = (bytes: Buffer | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const writeJson = async (filePath: string, value: unknown) => {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

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

/** One real import and attach as a template, then the rest written as the store writes them. */
async function buildProject(base: string): Promise<{ root: string; sourceIds: string[] }> {
  const root = NodePath.join(base, "project");
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  const first = (
    await importScientSource({
      root,
      operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
      candidate: candidate(0),
      actor: "user",
      intake: "file",
    })
  ).record!;
  const pdfPath = NodePath.join(base, "template.pdf");
  await NodeFSP.writeFile(pdfPath, "%PDF-1.7\ntemplate\n");
  await attachScientSourcePdf({
    root,
    sourceId: first.sourceId,
    expectedRevision: first.revision,
    pdfPath,
  });
  const template = (await readScientSourceRecord(root, first.sourceId))!;
  const attachmentTemplate = template.attachments[0]!;
  const store = NodePath.join(root, ...SCIENT_SOURCES_DIRECTORY.split("/"));
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
    let attachments: unknown[] = [];
    if (index < PDFS) {
      const bytes = Buffer.from(
        `%PDF-1.7\n% synthetic ${index}\n${"stream text ".repeat(300)}\n%%EOF\n`,
      );
      const hash = sha256(bytes);
      const relativePath = `files/sha256/${hash.slice(0, 2)}/${hash}.pdf`;
      await NodeFSP.mkdir(NodePath.join(store, "files", "sha256", hash.slice(0, 2)), {
        recursive: true,
      });
      await NodeFSP.writeFile(NodePath.join(store, ...relativePath.split("/")), bytes);
      await writeJson(NodePath.join(store, "text", "sha256", hash.slice(0, 2), `${hash}.json`), {
        formatVersion: 1,
        sha256: hash,
        pages: Array.from({ length: 4 }, (_, page) => ({
          page: page + 1,
          text: `Page ${page + 1} of synthetic study ${index}. `.repeat(40),
        })),
      });
      attachments = [
        {
          ...attachmentTemplate,
          sha256: hash,
          byteLength: bytes.length,
          relativePath,
          fileName: `study-${index}.pdf`,
        },
      ];
    }
    const record = {
      ...template,
      ...rest,
      sourceId,
      revision: index % 10 === 0 ? 2 : 1,
      attachments,
    };
    await writeJson(NodePath.join(store, "records", `${sourceId}.json`), record);
    if (record.revision === 2) {
      await writeJson(NodePath.join(store, "history", sourceId, "1.json"), {
        ...record,
        revision: 1,
        title: `${record.title} (first)`,
      });
    }
    sourceIds.push(sourceId);
  }
  const { reviewId } = await changeScientSystematicReview({
    root,
    change: { action: "create-review", title: "Synthetic review" },
    actor: "user",
  });
  await changeScientSystematicReview({
    root,
    change: {
      action: "log-search",
      reviewId: reviewId!,
      database: "PubMed",
      query: "synthetic",
      searchedOn: "2026-11-01",
      sourceIds: sourceIds.slice(0, 2_000),
    },
    actor: "user",
  });
  await changeScientSystematicReview({
    root,
    change: {
      action: "screen",
      reviewId: reviewId!,
      stage: "title-abstract",
      decisions: sourceIds
        .slice(0, 500)
        .map((sourceId, index) => ({ sourceId, decision: index % 3 ? "include" : "exclude" })),
    },
    actor: "user",
  });
  for (let index = 0; index < 5; index += 1) {
    await organizeScientSources({
      root,
      change: {
        action: "create-collection",
        name: `Collection ${index}`,
        sourceIds: sourceIds.slice(index * 1_000, index * 1_000 + 1_000),
      },
      actor: "user",
    });
  }
  return { root, sourceIds };
}

const base = await NodeFSP.realpath(
  await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-move-measure-")),
);
try {
  const built = Date.now();
  const { root } = await buildProject(base);
  console.log(`Built ${RECORDS} records, ${PDFS} PDFs in ${Date.now() - built} ms (${base}).`);
  const libraryRoot = scientLibraryRootFor(NodePath.join(base, "state"));
  await ensureScientLibrary(libraryRoot);

  // Another library writer: takes the lock over and over and records its longest wait.
  const run = { moving: true };
  let longestWait = 0;
  let acquisitions = 0;
  const writer = (async () => {
    while (run.moving) {
      const asked = performance.now();
      await withScientLibraryLock(libraryRoot, async () => undefined, { timeoutMs: 3_600_000 });
      longestWait = Math.max(longestWait, performance.now() - asked);
      acquisitions += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();

  const phases = new Map<string, number>();
  let phase: string | null = null;
  let phaseStart = 0;
  const started = performance.now();
  const result = await runScientLibraryMove({
    library: scientLibraryLocation(libraryRoot),
    projectRoot: root,
    actor: "user",
    onProgress: (progress: ScientLibraryMoveProgress) => {
      if (progress.phase === phase) return;
      const at = performance.now();
      if (phase) phases.set(phase, (phases.get(phase) ?? 0) + at - phaseStart);
      phase = progress.phase;
      phaseStart = at;
    },
  });
  const total = performance.now() - started;
  if (phase) phases.set(phase, (phases.get(phase) ?? 0) + performance.now() - phaseStart);
  run.moving = false;
  await writer;
  console.log(
    JSON.stringify(
      {
        machine: `${NodeOS.cpus()[0]?.model ?? "unknown"}, ${NodeOS.cpus().length} cores, ${Math.round(NodeOS.totalmem() / 2 ** 30)} GiB, ${NodeOS.type()} ${NodeOS.release()}, Node ${NodeProcess.version}`,
        records: RECORDS,
        pdfs: PDFS,
        outcome: result.outcome,
        state: result.journal?.state,
        totalMs: Math.round(total),
        longestLockWaitMs: Math.round(longestWait),
        writerAcquisitions: acquisitions,
        phasesMs: Object.fromEntries([...phases].map(([name, ms]) => [name, Math.round(ms)])),
      },
      null,
      2,
    ),
  );
} finally {
  if (!values.keep) await NodeFSP.rm(base, { recursive: true, force: true });
}
