import * as Schema from "effect/Schema";
import { ScientPassageCommand, type ScientSavedPassage } from "@scientfactory/scient-sources";

const Draft = Schema.Struct({
  note: Schema.String.check(Schema.isMaxLength(8000)),
  command: Schema.optionalKey(ScientPassageCommand),
  attempt: Schema.optionalKey(Schema.Boolean),
});
export type AnnotationNoteDraft = typeof Draft.Type;
const decodeDraft = Schema.decodeUnknownSync(Draft);

export function readAnnotationNoteDraft(key: string): AnnotationNoteDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return decodeDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeAnnotationNoteDraft(key: string, draft: AnnotationNoteDraft | null): boolean {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

type NoteCommand = Exclude<ScientPassageCommand, { action: "remove" }>;

/** One editor, one serialized writer. An uncertain request keeps its exact command. */
export function createAnnotationNoteSession(options: {
  key: string;
  note: string;
  command?: NoteCommand;
  baseline?: string;
  attempt?: boolean;
  save: (command: NoteCommand) => Promise<ScientSavedPassage>;
  onSaved: (passage: ScientSavedPassage, note: string) => void;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
}) {
  let note = options.note;
  let baseline = options.baseline ?? "";
  let command = options.command;
  let pending: NoteCommand | undefined = options.attempt ? options.command : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<boolean> | undefined;
  let cancelled = false;
  let leaving = false;
  function persist() {
    if (
      !writeAnnotationNoteDraft(options.key, {
        note,
        attempt: !!pending,
        ...((pending ?? command) ? { command: (pending ?? command)! } : {}),
      })
    )
      options.onError(
        "The local draft could not be backed up. Keep this editor open until saving succeeds.",
      );
  }
  function schedule() {
    clearTimeout(timer);
    if (!cancelled)
      timer = setTimeout(() => {
        void flush();
      }, 900);
  }
  function flush(): Promise<boolean> {
    clearTimeout(timer);
    if (cancelled) return Promise.resolve(true);
    if (running) return running;
    if (!pending && note === baseline) return Promise.resolve(true);
    if (!command) {
      persist();
      return Promise.resolve(false);
    }
    // Emptying a note does not silently remove it or invent a highlight.
    if (!pending && !note.trim()) {
      persist();
      return Promise.resolve(false);
    }
    options.onBusy(true);
    running = (async () => {
      try {
        do {
          pending ??= { ...command!, note };
          persist();
          const passage = await options.save(pending);
          baseline = passage.note;
          pending = undefined;
          command = {
            action: "update",
            passageId: passage.passageId,
            expectedRevision: passage.revision,
            note,
          };
          if (note === baseline) writeAnnotationNoteDraft(options.key, null);
          else persist();
          options.onSaved(passage, note);
          if (cancelled) return note === baseline;
        } while (note !== baseline && note.trim());
        return note === baseline;
      } catch (error) {
        persist();
        options.onError(
          error instanceof Error
            ? error.message
            : "Could not save. Your draft is kept; try Save note again.",
        );
        return false;
      } finally {
        running = undefined;
        options.onBusy(false);
      }
    })();
    return running;
  }
  return {
    change(value: string) {
      note = value;
      persist();
      schedule();
    },
    prepare(value: NoteCommand) {
      if (cancelled) return;
      command = value;
      persist();
      if (leaving) void flush();
      else schedule();
    },
    flush,
    leave() {
      leaving = true;
      return flush();
    },
    discard() {
      cancelled = true;
      clearTimeout(timer);
      writeAnnotationNoteDraft(options.key, null);
    },
  };
}
