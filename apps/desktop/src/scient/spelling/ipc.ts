import { app, BrowserWindow, session } from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { makeIpcMethod } from "../../ipc/DesktopIpc.ts";
import {
  NOTE_SPELLING_SAMPLE_CHANNEL,
  SPELLING_DICTIONARY_READY_CHANNEL,
} from "../../ipc/channels.ts";
import { makeDocumentSpelling, type DocumentSpelling } from "./spellingLanguages.ts";

let documentSpelling: DocumentSpelling | null = null;

/** Spellcheck must never break startup or editing: a failure is logged and skipped. */
const orLogged = <A>(message: string, fallback: A, run: () => A) =>
  Effect.sync(run).pipe(
    Effect.catchCause((cause) => Effect.as(Effect.logWarning(message, cause), fallback)),
  );

/**
 * Enables the spelling dictionaries for the user's languages before any window
 * opens. Windows and Linux check only with the dictionaries the app enables;
 * macOS detects the language itself (see macSpelling.ts).
 */
export const configureSpelling = Effect.fn("scient.spelling.configure")(function* (
  platform: NodeJS.Platform,
) {
  if (platform === "darwin") return;
  documentSpelling = yield* orLogged("Could not enable the system spelling languages", null, () => {
    // A dictionary used for the first time is downloaded, so it can arrive
    // after the field was rechecked; the window rechecks again once it is ready.
    session.defaultSession.on("spellcheck-dictionary-initialized", () => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(SPELLING_DICTIONARY_READY_CHANNEL);
      }
    });
    return makeDocumentSpelling(session.defaultSession, app.getPreferredSystemLanguages());
  });
});

export const noteSpellingSample = makeIpcMethod({
  channel: NOTE_SPELLING_SAMPLE_CHANNEL,
  payload: Schema.String.check(Schema.isMaxLength(4_000)),
  result: Schema.Boolean,
  handler: Effect.fn("scient.spelling.noteSample")(function* (sample, event) {
    const windows = yield* ElectronWindow;
    const main = yield* windows.main;
    // Only the app's own window describes what the user is writing.
    if (Option.isNone(main) || main.value.webContents.id !== event?.sender.id) return false;
    return yield* orLogged("Could not enable a document's spelling language", false, () =>
      documentSpelling === null ? false : documentSpelling.noteSample(sample),
    );
  }),
});
