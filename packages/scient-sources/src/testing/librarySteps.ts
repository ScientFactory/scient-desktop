// @effect-diagnostics nodeBuiltinImport:off -- Test support: runs Library steps against real folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";

import { editableMetadataFromRecord } from "../editable.ts";
import { readScientLibraryMergeReceipts } from "../libraryExclusions.ts";
import {
  mergeScientLibrarySources,
  settleScientLibraryMerges,
  undoScientLibraryMerge,
} from "../libraryMerge.ts";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  type ScientLibraryLocation,
} from "../libraryRoot.ts";
import type { ScientSourceCandidate } from "../model.ts";
import {
  pinScientLibrarySource,
  readScientProjectPins,
  refreshScientProjectPinSnapshots,
  resolveScientProjectPins,
  setScientProjectPinNote,
  unpinScientLibrarySource,
} from "../projectPins.ts";
import {
  deleteScientSourcesPermanently,
  importScientSource,
  listScientSourceRecords,
  removeScientSource,
  restoreScientSource,
  updateScientSourceMetadata,
  updateScientSourceNote,
} from "../store.ts";
import {
  initialTitle,
  workOf,
  type Model,
  type ModelPdf,
  type Step,
  type StepFacts,
} from "./libraryModel.ts";
import { sourceCandidate } from "./sourceFixtures.ts";

/** A Library and three projects in one folder, all at fixed paths so a snapshot can be put back. */
export interface Scenario {
  readonly root: string;
  readonly libraryRoot: string;
  readonly projects: ReadonlyArray<string>;
  /** Where the steps put the PDFs they import. */
  readonly inbox: string;
}

export const PROJECT_COUNT = 3;

export function scenarioAt(root: string): Scenario {
  return {
    root,
    libraryRoot: NodePath.join(root, "state", "scient", "library"),
    projects: Array.from({ length: PROJECT_COUNT }, (_, index) =>
      NodePath.join(root, "projects", `project-${index + 1}`),
    ),
    inbox: NodePath.join(root, "inbox"),
  };
}

export const libraryOf = (scenario: Scenario): ScientLibraryLocation =>
  scientLibraryLocation(scenario.libraryRoot);

/** An empty Library and its projects. `root` must be a canonical path. */
export async function createScenario(root: string): Promise<Scenario> {
  const scenario = scenarioAt(root);
  await NodeFSP.mkdir(scenario.inbox, { recursive: true });
  await ensureScientLibrary(scenario.libraryRoot);
  for (const [index, project] of scenario.projects.entries()) {
    await NodeFSP.mkdir(project, { recursive: true });
    await initializeScientProject({ root: project, title: `Project ${index + 1}` });
  }
  return scenario;
}

const pdfBytes = (label: string) => Buffer.from(`%PDF-1.7\nfixture paper ${label}\n%%EOF\n`);

function pdfOf(label: string): ModelPdf {
  const bytes = pdfBytes(label);
  return {
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  };
}

/** A stable operation ID per label, so a retried import is the same import. */
function operationIdOf(label: string): string {
  const hex = NodeCrypto.createHash("sha256").update(`operation\0${label}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const candidateOf = (label: string, pdf: boolean): ScientSourceCandidate =>
  sourceCandidate({
    sourceKey: label,
    title: initialTitle(label),
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: `Author${label}`, literalName: null },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: `10.1000/fixture.${label.toLowerCase()}` }],
    containerTitle: "Journal of Fixtures",
    language: "en",
    pdfAvailable: pdf,
    pdfFileName: pdf ? `${label}.pdf` : null,
    pdfAttachmentCount: pdf ? 1 : 0,
  });

function unexpected(step: Step, outcome: string): never {
  throw new Error(`Step ${JSON.stringify(step)} ended as "${outcome}".`);
}

async function liveRecord(library: ScientLibraryLocation, sourceId: string) {
  return (await listScientSourceRecords(library)).find((record) => record.sourceId === sourceId);
}

async function pinFor(project: string, sourceId: string) {
  return (await readScientProjectPins(project)).find((pin) => pin.sourceId === sourceId);
}

/**
 * Does one step the way a person would after looking at the current state: it reads first, and a
 * step that is already done (a retry after an interruption) is left alone. Throws when the stores
 * refuse something the model says is allowed.
 */
export async function runStep(scenario: Scenario, model: Model, step: Step): Promise<StepFacts> {
  const library = libraryOf(scenario);
  const idOf = (label: string) => workOf(model, label).sourceId;
  switch (step.op) {
    case "add": {
      let pdfPath: string | undefined;
      if (step.pdf) {
        pdfPath = NodePath.join(scenario.inbox, `${step.label}.pdf`);
        await NodeFSP.writeFile(pdfPath, pdfBytes(step.label));
      }
      const imported = await importScientSource({
        root: library,
        operationId: operationIdOf(step.label),
        candidate: candidateOf(step.label, step.pdf),
        ...(pdfPath ? { pdfPath } : {}),
      });
      const sourceId = imported.record?.sourceId ?? imported.duplicate.matchingSourceIds[0];
      if (!sourceId) unexpected(step, imported.outcome);
      return { sourceId, ...(step.pdf ? { pdf: pdfOf(step.label) } : {}) };
    }
    case "editTitle": {
      const record = await liveRecord(library, idOf(step.work));
      if (!record) unexpected(step, "not-found");
      if (record.title === step.title) return {};
      const result = await updateScientSourceMetadata({
        root: library,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        metadata: { ...editableMetadataFromRecord(record), title: step.title },
        actor: "user",
      });
      if (result.outcome !== "updated") unexpected(step, result.outcome);
      return {};
    }
    case "setNote": {
      const record = await liveRecord(library, idOf(step.work));
      if (!record) unexpected(step, "not-found");
      const result = await updateScientSourceNote({
        root: library,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        expectedNote: record.note ?? null,
        note: step.note,
        actor: "user",
      });
      if (result.outcome === "stale") unexpected(step, result.outcome);
      return {};
    }
    case "trash": {
      const record = await liveRecord(library, idOf(step.work));
      if (!record) return {};
      const result = await removeScientSource({
        root: library,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        actor: "user",
      });
      if (result.outcome !== "removed") unexpected(step, result.outcome);
      return {};
    }
    case "restore": {
      if (await liveRecord(library, idOf(step.work))) return {};
      const result = await restoreScientSource({
        root: library,
        sourceId: idOf(step.work),
        actor: "user",
      });
      if (result.outcome !== "restored" && result.outcome !== "exists") {
        unexpected(step, result.outcome);
      }
      return {};
    }
    case "deleteForGood": {
      await deleteScientSourcesPermanently({ root: library, sourceIds: [idOf(step.work)] });
      return {};
    }
    case "pin": {
      const project = scenario.projects[step.project]!;
      const result = await pinScientLibrarySource({
        projectRoot: project,
        library,
        sourceId: idOf(step.work),
        actor: "user",
        note: step.note,
      });
      if (result.outcome === "not-found") unexpected(step, result.outcome);
      return {};
    }
    case "unpin": {
      const project = scenario.projects[step.project]!;
      const pin = await pinFor(project, idOf(step.work));
      if (!pin) return {};
      await unpinScientLibrarySource({
        projectRoot: project,
        citationKey: pin.citationKey,
        actor: "user",
      });
      return {};
    }
    case "setProjectNote": {
      const project = scenario.projects[step.project]!;
      const pin = await pinFor(project, idOf(step.work));
      if (!pin) unexpected(step, "not-pinned");
      const result = await setScientProjectPinNote({
        projectRoot: project,
        citationKey: pin.citationKey,
        note: step.note,
        base: pin.note ?? null,
        actor: "user",
      });
      if (result.outcome === "stale" || result.outcome === "not-pinned") {
        unexpected(step, result.outcome);
      }
      return {};
    }
    case "resolveProject": {
      const project = scenario.projects[step.project]!;
      await resolveScientProjectPins({
        projectRoot: project,
        library,
        mode: "write",
        actor: "user",
      });
      await refreshScientProjectPinSnapshots({ projectRoot: project, library });
      return {};
    }
    case "merge": {
      const result = await mergeScientLibrarySources({
        library,
        sourceIds: [idOf(step.survivor), idOf(step.loser)],
        survivorId: idOf(step.survivor),
        actor: "user",
      });
      if (result.outcome === "not-found") unexpected(step, result.outcome);
      return {};
    }
    case "undoMerge": {
      // As from the Merged list: the newest merge of this source that still stands.
      const loserId = idOf(step.loser);
      const { receipts } = await readScientLibraryMergeReceipts(scenario.libraryRoot);
      const merge = receipts
        .filter((receipt) => receipt.loserId === loserId)
        .toSorted((left, right) => right.mergedAt.localeCompare(left.mergedAt))[0];
      if (!merge) unexpected(step, "not-found");
      if (merge.state === "undone") return {};
      const result = await undoScientLibraryMerge({
        library,
        mergeId: merge.mergeId,
        actor: "user",
      });
      if (result.outcome !== "undone" && result.outcome !== "already-undone") {
        unexpected(step, result.outcome);
      }
      return {};
    }
  }
}

/**
 * What a restarted server does before a person acts: finish merges and Undos a stopped process
 * left halfway, then resolve and refresh every project as it does after any change.
 */
export async function recoverScenario(scenario: Scenario): Promise<void> {
  const library = libraryOf(scenario);
  await settleScientLibraryMerges(library);
  for (const project of scenario.projects) {
    await resolveScientProjectPins({ projectRoot: project, library, mode: "write", actor: "user" });
    await refreshScientProjectPinSnapshots({ projectRoot: project, library });
  }
}
