/**
 * Test support: what a Library and its projects should hold after a list of steps, kept apart
 * from the stores so the rule checker compares the disk with an independent expectation.
 */

export interface ModelPdf {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ModelWork {
  readonly label: string;
  readonly sourceId: string;
  readonly state: "live" | "trash" | "deleted";
  readonly title: string;
  /** The personal note: exact text, or parts a merge joined (each must be present). */
  readonly note: string | null;
  readonly noteParts: ReadonlyArray<string> | null;
  readonly pdfs: ReadonlyArray<ModelPdf>;
  /** The label of the work this one was merged into, while that merge stands. */
  readonly mergedInto: string | null;
  /** Its latest merge into another work, as the Library's alias keeps it, also once undone. */
  readonly alias: { readonly survivor: string; readonly undone: boolean } | null;
  /** What Undo of each merge into this work puts back, newest last. */
  readonly merges: ReadonlyArray<{
    readonly loser: string;
    readonly note: string | null;
    readonly noteParts: ReadonlyArray<string> | null;
    readonly pdfs: ReadonlyArray<ModelPdf>;
    /** The personal note was edited after the merge, so Undo keeps the edit. */
    readonly noteEditedSince: boolean;
  }>;
}

export interface ModelPin {
  readonly project: number;
  readonly work: string;
  readonly note: string | null;
  /** The title the project's saved copy holds: from pinning, or the last refresh. */
  readonly snapshotTitle: string;
  /** Notes this pin held before, which its history must still list (the latest 20). */
  readonly earlierNotes: ReadonlyArray<string>;
}

export interface Model {
  readonly works: ReadonlyArray<ModelWork>;
  readonly pins: ReadonlyArray<ModelPin>;
}

export const EMPTY_MODEL: Model = { works: [], pins: [] };

export type Step =
  | { readonly op: "add"; readonly label: string; readonly pdf: boolean }
  | { readonly op: "editTitle"; readonly work: string; readonly title: string }
  | { readonly op: "setNote"; readonly work: string; readonly note: string | null }
  | { readonly op: "trash"; readonly work: string }
  | { readonly op: "restore"; readonly work: string }
  | { readonly op: "deleteForGood"; readonly work: string }
  | {
      readonly op: "pin";
      readonly project: number;
      readonly work: string;
      readonly note: string | null;
    }
  | { readonly op: "unpin"; readonly project: number; readonly work: string }
  | {
      readonly op: "setProjectNote";
      readonly project: number;
      readonly work: string;
      readonly note: string | null;
    }
  /** What the server does after a change: resolve the project's sources, then refresh its copies. */
  | { readonly op: "resolveProject"; readonly project: number }
  | { readonly op: "merge"; readonly survivor: string; readonly loser: string }
  | { readonly op: "undoMerge"; readonly loser: string };

/** What a step reports back for the model: the IDs and bytes only the stores know. */
export interface StepFacts {
  readonly sourceId?: string;
  readonly pdf?: ModelPdf;
}

export const initialTitle = (label: string) => `Study ${label} of the fixture library`;

export function workOf(model: Model, label: string): ModelWork {
  const work = model.works.find((candidate) => candidate.label === label);
  if (!work) throw new Error(`The model has no work ${label}.`);
  return work;
}

/**
 * The work a pin of `label` reaches now: merges are followed to the last survivor. Deleting a
 * merged-away copy for good ends its Undo, not its alias, so the chain still passes through it.
 */
export function targetOf(model: Model, label: string): ModelWork {
  let work = workOf(model, label);
  const seen = new Set([work.label]);
  while (work.state !== "live" && work.mergedInto !== null && !seen.has(work.mergedInto)) {
    work = workOf(model, work.mergedInto);
    seen.add(work.label);
  }
  return work;
}

/** Both works of every merge that was undone, as the Library's aliases remember them. */
function unmergedLabels(model: Model): ReadonlySet<string> {
  return new Set(
    model.works.flatMap((work) => (work.alias?.undone ? [work.label, work.alias.survivor] : [])),
  );
}

const pinOf = (model: Model, project: number, work: string) =>
  model.pins.find((pin) => pin.project === project && pin.work === work);

/** Whether the step is something a person could do in this state; the random driver asks. */
export function stepAllowed(model: Model, step: Step): boolean {
  const live = (label: string) =>
    model.works.some((work) => work.label === label && work.state === "live");
  switch (step.op) {
    case "add":
      return !model.works.some((work) => work.label === step.label);
    case "editTitle":
    case "setNote":
    case "trash":
      return live(step.work);
    case "restore":
      return model.works.some(
        (work) => work.label === step.work && work.state === "trash" && work.mergedInto === null,
      );
    case "deleteForGood":
      return model.works.some((work) => work.label === step.work && work.state === "trash");
    case "pin":
      // A source this project already reaches, under any key, is not pinned twice.
      return (
        live(step.work) &&
        !model.pins.some(
          (pin) => pin.project === step.project && targetOf(model, pin.work).label === step.work,
        )
      );
    case "unpin":
    case "setProjectNote":
      return pinOf(model, step.project, step.work) !== undefined;
    case "resolveProject":
      return true;
    case "merge":
      return step.survivor !== step.loser && live(step.survivor) && live(step.loser);
    case "undoMerge": {
      const loser = model.works.find((work) => work.label === step.loser);
      if (!loser || loser.state !== "trash" || loser.mergedInto === null) return false;
      const survivor = workOf(model, loser.mergedInto);
      // Undo is modelled newest first, where what it puts back is exact.
      return survivor.state === "live" && survivor.merges.at(-1)?.loser === loser.label;
    }
  }
}

const replaceWork = (model: Model, next: ModelWork): Model => ({
  ...model,
  works: model.works.map((work) => (work.label === next.label ? next : work)),
});

const noteTexts = (work: ModelWork): ReadonlyArray<string> =>
  work.noteParts ?? (work.note === null ? [] : [work.note]);

/** The model after a step that succeeded. */
export function applyStep(model: Model, step: Step, facts: StepFacts = {}): Model {
  switch (step.op) {
    case "add": {
      if (!facts.sourceId) throw new Error("An added work needs its source ID.");
      return {
        ...model,
        works: [
          ...model.works,
          {
            label: step.label,
            sourceId: facts.sourceId,
            state: "live",
            title: initialTitle(step.label),
            note: null,
            noteParts: null,
            pdfs: facts.pdf ? [facts.pdf] : [],
            mergedInto: null,
            alias: null,
            merges: [],
          },
        ],
      };
    }
    case "editTitle":
      return replaceWork(model, { ...workOf(model, step.work), title: step.title });
    case "setNote": {
      const work = workOf(model, step.work);
      return replaceWork(model, {
        ...work,
        note: step.note,
        noteParts: null,
        merges: work.merges.map((merge) => ({ ...merge, noteEditedSince: true })),
      });
    }
    case "trash":
      return replaceWork(model, { ...workOf(model, step.work), state: "trash" });
    case "restore":
      return replaceWork(model, { ...workOf(model, step.work), state: "live" });
    case "deleteForGood":
      return replaceWork(model, { ...workOf(model, step.work), state: "deleted" });
    case "pin":
      return {
        ...model,
        pins: [
          ...model.pins,
          {
            project: step.project,
            work: step.work,
            note: step.note,
            snapshotTitle: workOf(model, step.work).title,
            earlierNotes: [],
          },
        ],
      };
    case "unpin":
      return {
        ...model,
        pins: model.pins.filter((pin) => !(pin.project === step.project && pin.work === step.work)),
      };
    case "setProjectNote":
      return {
        ...model,
        pins: model.pins.map((pin) =>
          pin.project === step.project && pin.work === step.work && pin.note !== step.note
            ? {
                ...pin,
                note: step.note,
                earlierNotes:
                  pin.note === null ? pin.earlierNotes : [...pin.earlierNotes, pin.note],
              }
            : pin,
        ),
      };
    case "resolveProject": {
      const unmerged = unmergedLabels(model);
      return {
        ...model,
        pins: model.pins.map((pin) => {
          if (pin.project !== step.project) return pin;
          // The copy follows the live source the key reaches. A removed source's copy stays as
          // it is, unless the source was unmerged: then it is the source's own last details.
          const target = targetOf(model, pin.work);
          return target.state === "live" || unmerged.has(target.label)
            ? { ...pin, snapshotTitle: target.title }
            : pin;
        }),
      };
    }
    case "merge": {
      const survivor = workOf(model, step.survivor);
      const loser = workOf(model, step.loser);
      // A merge joins two notes under headings, takes the loser's when the survivor has none,
      // and leaves the survivor's alone when the loser has none.
      const kept = noteTexts(survivor);
      const offered = noteTexts(loser);
      const note =
        offered.length === 0
          ? { note: survivor.note, noteParts: survivor.noteParts }
          : kept.length === 0
            ? { note: loser.note, noteParts: loser.noteParts }
            : { note: null, noteParts: [...kept, ...offered] };
      const pdfs = [
        ...survivor.pdfs,
        ...loser.pdfs.filter((pdf) => !survivor.pdfs.some((kept) => kept.sha256 === pdf.sha256)),
      ];
      const afterSurvivor: ModelWork = {
        ...survivor,
        ...note,
        pdfs,
        merges: [
          ...survivor.merges,
          {
            loser: loser.label,
            note: survivor.note,
            noteParts: survivor.noteParts,
            pdfs: survivor.pdfs,
            noteEditedSince: false,
          },
        ],
      };
      return replaceWork(replaceWork(model, afterSurvivor), {
        ...loser,
        state: "trash",
        mergedInto: survivor.label,
        alias: { survivor: survivor.label, undone: false },
      });
    }
    case "undoMerge": {
      const loser = workOf(model, step.loser);
      const survivor = workOf(model, loser.mergedInto ?? "");
      const merge = survivor.merges.at(-1);
      if (!merge) throw new Error("The model has no merge to undo.");
      return replaceWork(
        replaceWork(model, {
          ...survivor,
          ...(merge.noteEditedSince ? {} : { note: merge.note, noteParts: merge.noteParts }),
          pdfs: merge.pdfs,
          merges: survivor.merges.slice(0, -1),
        }),
        {
          ...loser,
          state: "live",
          mergedInto: null,
          alias: { survivor: survivor.label, undone: true },
        },
      );
    }
  }
}
