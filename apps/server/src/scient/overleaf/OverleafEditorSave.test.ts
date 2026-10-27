/**
 * The editor-save seam over a fake editor-save request: each request result maps
 * to what the Overleaf tools act on, and the request names the linked folder with
 * the window and overall time limits.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EditorFlush from "../editorFlush/EditorFlush.ts";
import { OverleafEditorUnsavedError } from "./OverleafSync.ts";
import { layerFromEditorFlush, OverleafEditorSave } from "./OverleafEditorSave.ts";

const saveWith = (result: EditorFlush.EditorFlushResult) => {
  const asked: Array<EditorFlush.EditorFlushFolderInput> = [];
  const flush = Layer.mock(EditorFlush.EditorFlush)({
    flushFolder: (input) =>
      Effect.sync(() => {
        asked.push(input);
        return result;
      }),
  });
  return OverleafEditorSave.use((saver) =>
    saver.saveFolder({ checkoutRoot: "/projects/main", folder: "paper" }),
  ).pipe(
    Effect.provide(layerFromEditorFlush.pipe(Layer.provide(flush))),
    Effect.map((saved) => ({ saved, asked })),
  );
};

describe("OverleafEditorSave from the editor-save request", () => {
  it("keeps the editor's actionable explanation for both HTTP and agent errors", () => {
    const error = new OverleafEditorUnsavedError({
      failures: [
        {
          path: "paper/deleted.tex",
          reason: "save-failed",
          message: "This file was deleted while its editor held unsaved edits.",
        },
      ],
      unanswered: [],
    });
    expect(error.message).toContain(
      "paper/deleted.tex (This file was deleted while its editor held unsaved edits.)",
    );
  });

  it.effect("no window open, or every window saved, is saved", () =>
    Effect.gen(function* () {
      const none = yield* saveWith({ _tag: "NoWindowOpen" });
      expect(none.saved).toEqual({ _tag: "saved" });
      expect(none.asked).toEqual([
        {
          checkoutRoot: "/projects/main",
          folder: "paper",
          timeout: "10 seconds",
          overallTimeout: "30 seconds",
        },
      ]);
      expect(
        (yield* saveWith({
          _tag: "Answered",
          allSaved: true,
          windows: [{ _tag: "Saved", window: { clientId: "w1" }, saved: ["paper/main.tex"] }],
        })).saved,
      ).toEqual({ _tag: "saved" });
    }),
  );

  it.effect("a failed or unanswered window, or an unreadable folder, is failed and named", () =>
    Effect.gen(function* () {
      const answered = yield* saveWith({
        _tag: "Answered",
        allSaved: false,
        windows: [
          { _tag: "Saved", window: { clientId: "w1" }, saved: [] },
          {
            _tag: "Failed",
            window: { clientId: "w2" },
            saved: [],
            failures: [
              { path: "paper/main.tex", reason: "unconverted-input", message: "Visual input" },
            ],
          },
          { _tag: "Unanswered", window: { clientId: "w3" }, reason: "timeout" },
        ],
      });
      expect(answered.saved).toEqual({
        _tag: "failed",
        failures: [
          { path: "paper/main.tex", reason: "unconverted-input", message: "Visual input" },
        ],
        unanswered: [{ window: "w3", reason: "timeout" }],
      });
      const unavailable = yield* saveWith({ _tag: "FolderUnavailable", message: "gone" });
      expect(unavailable.saved).toEqual({
        _tag: "failed",
        failures: [{ path: "paper", reason: "folder-unavailable" }],
        unanswered: [],
      });
    }),
  );
});
