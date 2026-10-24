/**
 * A stand-in for the editor-save request: answers every save with one result
 * and records which folders were asked for, in order.
 */
import * as Effect from "effect/Effect";

import { OverleafEditorSave, type OverleafEditorSaveResult } from "./OverleafEditorSave.ts";

export const recordingEditorSave = (result: OverleafEditorSaveResult) => {
  const calls: Array<{ readonly checkoutRoot: string; readonly folder: string }> = [];
  const service = OverleafEditorSave.of({
    saveFolder: (input) =>
      Effect.sync(() => {
        calls.push({ checkoutRoot: input.checkoutRoot, folder: input.folder });
        return result;
      }),
  });
  return { service, calls };
};
