/**
 * Saving a linked folder's open editors before an Overleaf operation reads it
 * (pr-c-design.md sections 1, 4.3 and 6). Sync, a kept-copy restore and Undo
 * call it first; anything but `saved` stops them before they change a file,
 * and the result names the file that could not be saved.
 *
 * This is the one seam between the Overleaf tools and the server request that
 * asks every open window to save (the editor-save request, its own PR). Until
 * that request is connected here, `layerNotConnected` answers `unavailable`, so
 * nothing syncs over editor text that may be unsaved.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
    }
  /** No editor-save request is connected to this server. */
  | { readonly _tag: "unavailable" };

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

/** Until the editor-save request is connected: every save is `unavailable`. */
export const layerNotConnected = Layer.succeed(OverleafEditorSave, {
  saveFolder: () => Effect.succeed({ _tag: "unavailable" } as const),
});
