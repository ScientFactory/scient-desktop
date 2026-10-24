/**
 * Saving a linked folder's open editors before an Overleaf operation reads it
 * (pr-c-design.md sections 1, 4.3 and 6). `OverleafSync` calls it first in every
 * operation that may write the folder (sync, preview, recovery, kept-copy
 * restore, undo), for the agent tools and the screens alike; anything but
 * `saved` stops the operation before it changes a file, and the result names
 * the file that could not be saved.
 *
 * This is the one seam between the Overleaf service and the editor-save request
 * (`EditorFlush`), which asks every open window of this server to save.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EditorFlush from "../editorFlush/EditorFlush.ts";

/** Why one editor's text is still not on disk. */
export interface OverleafEditorSaveFailure {
  /** Relative to the checkout, with "/" separators. */
  readonly path: string;
  /** A fixed category from the window: `unconverted-input`, `composing`, `save-failed` or `conflict`. */
  readonly reason: string;
}

/** A window that did not answer: it may hold unsaved text. */
export interface OverleafEditorSaveUnanswered {
  /** The window's own name or ID, as the editor-save request knows it. */
  readonly window: string;
  readonly reason: "timeout" | "disconnected";
}

export type OverleafEditorSaveResult =
  /** Every window saved every editor under the folder, or no window is open. */
  | { readonly _tag: "saved" }
  /**
   * An editor could not save, or a window did not answer in time or went away
   * while asked. Nothing may read the folder over either.
   */
  | {
      readonly _tag: "failed";
      readonly failures: ReadonlyArray<OverleafEditorSaveFailure>;
      readonly unanswered: ReadonlyArray<OverleafEditorSaveUnanswered>;
    };

export class OverleafEditorSave extends Context.Service<
  OverleafEditorSave,
  {
    readonly saveFolder: (input: {
      /** Absolute path of the linked checkout. */
      readonly checkoutRoot: string;
      /** Relative to `checkoutRoot` with "/" separators; "" is the whole checkout. */
      readonly folder: string;
    }) => Effect.Effect<OverleafEditorSaveResult>;
  }
>()("t3/scient/overleaf/OverleafEditorSave") {}

/** How long each window has to save, and the whole request, before it counts as failed. */
const WINDOW_TIMEOUT = "10 seconds";
const OVERALL_TIMEOUT = "30 seconds";

/**
 * Every open window of this server saves the folder's editors. No window open
 * means nothing is unsaved; anything else that is not all saved names the files
 * and windows that stopped it.
 */
export const layerFromEditorFlush = Layer.effect(
  OverleafEditorSave,
  Effect.gen(function* () {
    const flush = yield* EditorFlush.EditorFlush;
    return {
      saveFolder: (input) =>
        flush
          .flushFolder({ ...input, timeout: WINDOW_TIMEOUT, overallTimeout: OVERALL_TIMEOUT })
          .pipe(
            Effect.map((result): OverleafEditorSaveResult => {
              switch (result._tag) {
                case "NoWindowOpen":
                  return { _tag: "saved" };
                case "FolderUnavailable":
                  return {
                    _tag: "failed",
                    failures: [{ path: input.folder, reason: "folder-unavailable" }],
                    unanswered: [],
                  };
                case "Answered":
                  return result.allSaved
                    ? { _tag: "saved" }
                    : {
                        _tag: "failed",
                        failures: result.windows.flatMap((window) =>
                          window._tag === "Failed"
                            ? window.failures.map(({ path, reason }) => ({ path, reason }))
                            : [],
                        ),
                        unanswered: result.windows.flatMap((window) =>
                          window._tag === "Unanswered"
                            ? [{ window: window.window.clientId, reason: window.reason }]
                            : [],
                        ),
                      };
              }
            }),
          ),
    };
  }),
);
