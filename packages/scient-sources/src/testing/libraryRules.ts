// @effect-diagnostics nodeBuiltinImport:off -- Test support: reads real Library and project folders to check the rules.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientLibraryAliases, resolveScientLibraryAlias } from "../libraryAliases.ts";
import type { ScientSourceRecord, ScientSourceTrashEntry } from "../model.ts";
import {
  listScientProjectPinnedWorks,
  readScientProjectPinNoteHistory,
  readScientProjectPins,
} from "../projectPins.ts";
import {
  inspectScientLibrarySources,
  readScientSourceTombstones,
  readScientSourceTrashEntries,
  sourceAttachmentAbsolutePath,
} from "../store.ts";
import {
  removedCitationTitle,
  targetOf,
  type Model,
  type ModelPin,
  type ModelWork,
} from "./libraryModel.ts";
import { libraryOf, type Scenario } from "./librarySteps.ts";

/**
 * Checks the rules a Library and its projects keep (docs/internals/scient-sources.md, "Rules the
 * stores keep"). `models` is what the disk may hold: one model when everything has settled, or the
 * states before and after an interrupted step, where each source and key must match one of them.
 */
export interface RuleReport {
  readonly violations: ReadonlyArray<string>;
  /** Temporary files a killed write left behind; harmless, counted to see that they do not grow. */
  readonly leftoverTemporaryFiles: number;
}

const LOCK_FILES = new Set(["library.lock", "pins.lock", "move.lock"]);

async function walk(
  directory: string,
  visit: (path: string, kind: "file" | "link") => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isSymbolicLink()) await visit(path, "link");
    else if (entry.isDirectory()) await walk(path, visit);
    else await visit(path, "file");
  }
}

type Observed =
  | { readonly state: "live"; readonly record: ScientSourceRecord }
  | {
      readonly state: "trash";
      readonly record: ScientSourceRecord;
      readonly mergedInto: string | null;
    }
  | { readonly state: "deleted" }
  | { readonly state: "absent" };

const describeObserved = (observed: Observed) =>
  observed.state === "live" || observed.state === "trash"
    ? `${observed.state} "${observed.record.title}" note ${JSON.stringify(observed.record.note ?? null)} with ${observed.record.attachments.length} PDF(s)${
        observed.state === "trash" && observed.mergedInto
          ? ` merged into ${observed.mergedInto}`
          : ""
      }`
    : observed.state;

function workMatches(model: Model, work: ModelWork | undefined, observed: Observed): boolean {
  if (!work) return observed.state === "absent";
  if (work.state !== observed.state) return false;
  if (observed.state === "deleted") return true;
  const { record } = observed;
  if (record.title !== work.title) return false;
  const note = record.note ?? null;
  if (work.noteParts) {
    if (note === null || !work.noteParts.every((part) => note.includes(part))) return false;
  } else if (note !== work.note) {
    return false;
  }
  const pdfs = record.attachments.map((pdf) => `${pdf.sha256}:${pdf.byteLength}`).toSorted();
  const expected = work.pdfs.map((pdf) => `${pdf.sha256}:${pdf.byteLength}`).toSorted();
  if (pdfs.join() !== expected.join()) return false;
  if (observed.state === "trash") {
    const mergedInto = work.mergedInto === null ? null : targetLabelId(model, work.mergedInto);
    if (observed.mergedInto !== mergedInto) return false;
  }
  return true;
}

const targetLabelId = (model: Model, label: string) =>
  model.works.find((work) => work.label === label)?.sourceId ?? null;

export async function checkLibraryRules(
  scenario: Scenario,
  models: ReadonlyArray<Model>,
  /** `noUnreferencedPdfs`: only where nothing was interrupted; a killed write may leave one. */
  options: { readonly noUnreferencedPdfs?: boolean } = {},
): Promise<RuleReport> {
  const violations: string[] = [];
  const library = libraryOf(scenario);
  const interrupted = models.length > 1;
  let leftoverTemporaryFiles = 0;

  // Rule 1: plain, readable files.
  const roots = [
    scenario.libraryRoot,
    ...scenario.projects.map((project) => NodePath.join(project, ".scient")),
  ];
  for (const root of roots) {
    await walk(root, async (path, kind) => {
      const name = NodePath.basename(path);
      const shown = NodePath.relative(scenario.root, path);
      if (kind === "link") {
        violations.push(`Rule 1: ${shown} is a link.`);
        return;
      }
      if (name.includes(".tmp-")) {
        leftoverTemporaryFiles += 1;
        return;
      }
      if (!name.endsWith(".json") || LOCK_FILES.has(name)) return;
      try {
        JSON.parse(await NodeFSP.readFile(path, "utf8"));
      } catch {
        violations.push(`Rule 1: ${shown} is not readable JSON.`);
      }
    });
  }
  const inspection = await inspectScientLibrarySources(library);
  for (const issue of inspection.unreadableRecords ?? []) {
    violations.push(`Rule 1: ${issue.path}: ${issue.message}`);
  }

  const live = new Map(inspection.records.map((record) => [record.sourceId, record]));
  const trash = new Map<string, ScientSourceTrashEntry>(
    (await readScientSourceTrashEntries(library)).map((entry) => [entry.sourceId, entry]),
  );
  const deleted = new Set(
    (await readScientSourceTombstones(library)).map((entry) => entry.sourceId),
  );
  const observe = (sourceId: string): Observed => {
    const record = live.get(sourceId);
    if (record) return { state: "live", record };
    const entry = trash.get(sourceId);
    if (entry) {
      return {
        state: "trash",
        record: entry.record,
        mergedInto: entry.mergedInto?.sourceId ?? null,
      };
    }
    return deleted.has(sourceId) ? { state: "deleted" } : { state: "absent" };
  };

  // Rules 4, 5 and 6 (personal notes): every source is in a state one of the models allows.
  const labels = new Map<string, string>();
  for (const model of models) for (const work of model.works) labels.set(work.label, work.sourceId);
  for (const [label, sourceId] of labels) {
    const observed = observe(sourceId);
    const allowed = models.some((model) =>
      workMatches(
        model,
        model.works.find((work) => work.label === label),
        observed,
      ),
    );
    if (!allowed) {
      const expected = models
        .map((model) => {
          const work = model.works.find((candidate) => candidate.label === label);
          return work
            ? `${work.state} "${work.title}" note ${JSON.stringify(work.noteParts ?? work.note)} with ${work.pdfs.length} PDF(s)${work.mergedInto ? ` merged into ${work.mergedInto}` : ""}`
            : "absent";
        })
        .join(" | ");
      violations.push(
        `Source ${label}: found ${describeObserved(observed)}; expected ${expected}.`,
      );
    }
  }
  const known = new Set(labels.values());
  for (const sourceId of [...live.keys(), ...trash.keys()]) {
    if (!known.has(sourceId))
      violations.push(`Source ${sourceId} is in the Library but in no model.`);
  }

  // Rule 3: the bytes behind every PDF a live or trashed source names.
  const records = [...live.values(), ...[...trash.values()].map((entry) => entry.record)];
  for (const record of records) {
    for (const attachment of record.attachments) {
      try {
        const bytes = await NodeFSP.readFile(sourceAttachmentAbsolutePath(library, attachment));
        const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        if (sha256 !== attachment.sha256 || bytes.length !== attachment.byteLength) {
          violations.push(`Rule 3: the PDF ${attachment.fileName} of ${record.sourceId} changed.`);
        }
      } catch {
        violations.push(`Rule 3: the PDF ${attachment.fileName} of ${record.sourceId} is missing.`);
      }
    }
  }

  // Rule 2: aliases end at a source that is not itself merged away.
  const aliases = await readScientLibraryAliases(library);
  for (const [sourceId, alias] of aliases) {
    if (alias.undoneAt !== undefined) continue;
    const end = resolveScientLibraryAlias(aliases, sourceId);
    const endAlias = aliases.get(end);
    if (endAlias && endAlias.undoneAt === undefined) {
      violations.push(`Rule 2: the alias of ${sourceId} does not end.`);
    }
  }
  // Settled: each source's ID stands for the source the model says it was merged into, or itself.
  const [settled] = models;
  if (settled && !interrupted) {
    for (const work of settled.works) {
      const expected = targetOf(settled, work.label).sourceId;
      const end = resolveScientLibraryAlias(aliases, work.sourceId);
      if (end !== expected) {
        violations.push(`Rule 2: the ID of ${work.label} stands for ${end}, not for ${expected}.`);
      }
    }
  }

  // Rule 3, the other way: a PDF no live or trashed source names, now or in a kept revision, is
  // gone (delete for good). Deleting one source keeps a PDF another source's history names, so
  // reverting that source can still bring it back.
  if (settled && options.noUnreferencedPdfs) {
    const named = new Set(
      settled.works
        .filter((work) => work.state !== "deleted")
        .flatMap((work) => work.pdfs.map((pdf) => pdf.sha256)),
    );
    for (const sourceId of [...live.keys(), ...trash.keys()]) {
      await walk(NodePath.join(scenario.libraryRoot, "history", sourceId), async (path) => {
        if (!path.endsWith(".json")) return;
        const revision = JSON.parse(await NodeFSP.readFile(path, "utf8")) as ScientSourceRecord;
        for (const attachment of revision.attachments) named.add(attachment.sha256);
      });
    }
    await walk(NodePath.join(scenario.libraryRoot, "files"), async (path) => {
      const name = NodePath.basename(path);
      if (name.endsWith(".pdf") && !named.has(name.slice(0, -".pdf".length))) {
        violations.push(`Rule 3: the PDF ${name} is kept although no source names it.`);
      }
    });
  }

  // Rule 2 and rule 6 (project notes): every project key cites what a model says it cites.
  for (const [index, project] of scenario.projects.entries()) {
    const pins = await readScientProjectPins(project);
    const keys = new Set<string>();
    for (const pin of pins) {
      const key = pin.citationKey.toLowerCase();
      if (keys.has(key))
        violations.push(`Rule 2: project ${index + 1} has the key ${pin.citationKey} twice.`);
      keys.add(key);
    }
    const works = await listScientProjectPinnedWorks({ projectRoot: project, library });
    const pinLabels = new Set(
      models.flatMap((model) =>
        model.pins.filter((pin) => pin.project === index).map((pin) => pin.work),
      ),
    );
    const pinnedIds = new Set([...pinLabels].map((label) => labels.get(label)));
    for (const pin of pins) {
      if (!pinnedIds.has(pin.sourceId)) {
        violations.push(`Project ${index + 1} has the key ${pin.citationKey}, which no model has.`);
      }
    }
    for (const label of pinLabels) {
      const sourceId = labels.get(label);
      const found = pins.filter((pin) => pin.sourceId === sourceId);
      const cited = found[0]
        ? works.find((work) => work.citationKey === found[0]!.citationKey)
        : undefined;
      const matches = (pinModel: Model, workModel: Model): boolean => {
        const pin = pinModel.pins.find(
          (candidate) => candidate.project === index && candidate.work === label,
        );
        if (!pin) return found.length === 0;
        if (found.length !== 1 || !cited) return false;
        if ((found[0]!.note ?? null) !== pin.note) return false;
        if (!workModel.works.some((work) => work.label === label)) return false;
        const removedAs = removedCitationTitle(workModel, pin);
        // Between the states of an interrupted step, the saved copy may serve the key.
        if (
          interrupted &&
          cited.from === "snapshot" &&
          [pin.snapshotTitle, removedAs].includes(cited.record.title ?? "")
        ) {
          return true;
        }
        const target = targetOf(workModel, label);
        return target.state === "live"
          ? cited.from === "library" && cited.record.title === target.title
          : cited.from === "snapshot" && cited.record.title === removedAs;
      };
      if (!models.some((pinModel) => models.some((workModel) => matches(pinModel, workModel)))) {
        const state = cited
          ? `${found.length} key(s), cited from the ${cited.from} as "${cited.record.title}", note ${JSON.stringify(found[0]?.note ?? null)}`
          : `${found.length} key(s)`;
        const expected = models.map((model) => describePin(model, index, label)).join(" | ");
        violations.push(
          `Project ${index + 1}, source ${label}: found ${state}; expected ${expected}.`,
        );
      }
      // Earlier notes every model agrees on must still be in the kept versions.
      const pinModels = models.map((model) =>
        model.pins.find((candidate) => candidate.project === index && candidate.work === label),
      );
      if (found[0] && pinModels.every((pin): pin is ModelPin => pin !== undefined)) {
        const history = await readScientProjectPinNoteHistory({
          projectRoot: project,
          citationKey: found[0].citationKey,
        });
        const kept = new Set((history ?? []).map((version) => version.note));
        const required = pinModels[0]!.earlierNotes
          .filter((note) => pinModels.every((pin) => pin.earlierNotes.includes(note)))
          .slice(-20);
        for (const note of required) {
          if (!kept.has(note)) {
            violations.push(
              `Rule 6: project ${index + 1}, source ${label}: the earlier note ${JSON.stringify(note)} is not in its kept versions.`,
            );
          }
        }
      }
    }
  }

  return { violations, leftoverTemporaryFiles };
}

function describePin(model: Model, project: number, label: string): string {
  const pin = model.pins.find(
    (candidate) => candidate.project === project && candidate.work === label,
  );
  if (!pin) return "no key";
  if (!model.works.some((work) => work.label === label)) return "a key for a source not added yet";
  const target = targetOf(model, label);
  return target.state === "live"
    ? `one key, cited from the library as "${target.title}", note ${JSON.stringify(pin.note)}`
    : `one key, cited from the snapshot as "${removedCitationTitle(model, pin)}", note ${JSON.stringify(pin.note)}`;
}
