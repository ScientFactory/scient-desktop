// @effect-diagnostics nodeBuiltinImport:off -- The choices file is read before any window opens and written from menu clicks, outside Effect.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { app, BrowserWindow, net, session } from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { makeIpcMethod } from "../../ipc/DesktopIpc.ts";
import { appWindowForSender } from "../multiWindow/appWindows.ts";
import {
  NOTE_SPELLING_SAMPLE_CHANNEL,
  SPELLING_DICTIONARY_READY_CHANNEL,
} from "../../ipc/channels.ts";
import { interleave, languagesItem, suggestionItems } from "./contextMenu.ts";
import { makeDocumentSpelling, type DocumentSpelling } from "./spellingLanguages.ts";
import { makeSuggester, type Suggester } from "./suggestions.ts";

let documentSpelling: DocumentSpelling | null = null;
/** Windows only: see suggestions.ts. */
let suggester: Suggester | null = null;
let saveChoices: () => void = () => {};
let logWarning: (message: string, cause: unknown) => void = () => {};

const decodeChoices = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)),
);

/** Spellcheck must never break startup or editing: a failure is logged and skipped. */
const orLogged = <A>(message: string, fallback: A, run: () => A) =>
  Effect.sync(run).pipe(
    Effect.catchCause((cause) => Effect.as(Effect.logWarning(message, cause), fallback)),
  );

/** Chromium does not recheck text when dictionaries change; each window does on the next edit. */
function recheckWindows(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(SPELLING_DICTIONARY_READY_CHANNEL);
  }
}

const enabledCodes = (spelling: DocumentSpelling) => spelling.languages().map(({ code }) => code);

/**
 * Enables the spelling dictionaries for the user's languages before any window opens. Windows
 * and Linux check only with the dictionaries the app enables; macOS detects the language itself
 * (see macSpelling.ts).
 */
export const configureSpelling = Effect.fn("scient.spelling.configure")(function* (environment: {
  readonly platform: NodeJS.Platform;
  readonly stateDir: string;
}) {
  if (environment.platform === "darwin") return;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  logWarning = (message, cause) => runFork(Effect.logWarning(message, cause));
  yield* orLogged("Could not enable the system spelling languages", undefined, () =>
    startSpelling(environment.platform, NodePath.join(environment.stateDir, "scient", "spelling")),
  );
});

function startSpelling(platform: NodeJS.Platform, directory: string): void {
  const choicesFile = NodePath.join(directory, "languages.json");
  // A dictionary used for the first time is downloaded and can arrive after the user's next
  // keystroke, so the window rechecks once more when it is ready.
  session.defaultSession.on("spellcheck-dictionary-initialized", recheckWindows);
  const saved = Option.getOrElse(
    decodeChoices(NodeFS.existsSync(choicesFile) ? NodeFS.readFileSync(choicesFile, "utf8") : ""),
    () => ({}),
  );
  const spelling = makeDocumentSpelling(
    session.defaultSession,
    app.getPreferredSystemLanguages(),
    saved,
  );

  let saving = Promise.resolve();
  saveChoices = () => {
    const text = JSON.stringify(spelling.choices());
    saving = saving
      .then(async () => {
        await NodeFSP.mkdir(directory, { recursive: true });
        await NodeFSP.writeFile(`${choicesFile}.tmp`, text);
        await NodeFSP.rename(`${choicesFile}.tmp`, choicesFile);
      })
      .catch((cause: unknown) => logWarning("Could not save the spelling languages", cause));
  };
  if (platform === "win32") {
    suggester = makeSuggester({
      directory: NodePath.join(directory, "dictionaries"),
      fetchText: async (url) => {
        const response = await net.fetch(url);
        if (!response.ok) throw new Error(`${url} answered ${response.status}`);
        return response.text();
      },
      onError: logWarning,
    });
    suggester.prepare(enabledCodes(spelling));
  }
  documentSpelling = spelling;
}

function languagesChanged(spelling: DocumentSpelling): void {
  suggester?.prepare(enabledCodes(spelling));
  recheckWindows();
}

function chooseLanguage(code: string, enabled: boolean): void {
  if (documentSpelling === null) return;
  try {
    if (documentSpelling.choose(code, enabled)) languagesChanged(documentSpelling);
    saveChoices();
  } catch (cause) {
    logWarning("Could not change the spelling languages", cause);
  }
}

/**
 * The context menu's spelling part: suggestions for a misspelled word, then on Windows and Linux
 * the spelling languages. Web pages in the browser panel keep Chromium's suggestions alone.
 */
export function spellingMenuItems(
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): Electron.MenuItemConstructorOptions[] {
  const replace = (suggestion: string) => {
    if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion);
  };
  const spelling = contents.session === session.defaultSession ? documentSpelling : null;
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (params.misspelledWord) {
    // Retries a dictionary whose download failed, such as while offline.
    if (spelling) suggester?.prepare(enabledCodes(spelling));
    const own = spelling
      ? (suggester?.suggest(params.misspelledWord, enabledCodes(spelling)) ?? [])
      : [];
    items.push(...suggestionItems(interleave([...own, params.dictionarySuggestions]), replace));
  }
  if (spelling && params.isEditable && params.spellcheckEnabled) {
    items.push(languagesItem(spelling.languages(), spelling.available, chooseLanguage), {
      type: "separator",
    });
  }
  return items;
}

export const noteSpellingSample = makeIpcMethod({
  channel: NOTE_SPELLING_SAMPLE_CHANNEL,
  payload: Schema.String.check(Schema.isMaxLength(4_000)),
  result: Schema.Literals(["added", "unchanged", "failed"]),
  handler: Effect.fn("scient.spelling.noteSample")(function* (sample, event) {
    // Only the app's own windows describe what the user is writing.
    const sender = yield* appWindowForSender(yield* ElectronWindow, event?.sender.id);
    if (Option.isNone(sender)) return "unchanged";
    // A failure is reported so that the window sends the same text again later.
    return yield* orLogged(
      "Could not enable a spelling language",
      "failed" as const,
      (): "added" | "unchanged" => {
        if (documentSpelling === null || !documentSpelling.noteSample(sample)) return "unchanged";
        suggester?.prepare(enabledCodes(documentSpelling));
        return "added";
      },
    );
  }),
});
