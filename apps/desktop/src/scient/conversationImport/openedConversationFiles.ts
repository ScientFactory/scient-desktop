// @effect-diagnostics nodeBuiltinImport:off -- opened files are inspected and streamed from disk in the main process.
/**
 * `.scic` files the operating system opens with Scient: a double-click or
 * Open With (macOS `open-file`), a launch argument (Windows and Linux), or an
 * argument handed to the running instance (`second-instance`).
 *
 * The main process keeps each file's path to itself and gives the renderer an
 * opaque token, its name, and its size. The renderer admits the upload on its
 * server, then asks the main process to stream the file to the signed upload
 * URL, which must be the import upload route. The same preview then opens as
 * for a file picked in the app.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import {
  DesktopConversationFileUploadRequest,
  DesktopConversationFileUploadResult,
  DesktopOpenedConversationFile,
  SCIC_FILE_EXTENSION,
  SCIC_MEDIA_TYPE,
  SCIENT_CONVERSATION_IMPORT_UPLOAD_PATH,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import { makeIpcMethod } from "../../ipc/DesktopIpc.ts";
import {
  CONVERSATION_FILES_OPENED_CHANNEL,
  TAKE_OPENED_CONVERSATION_FILES_CHANNEL,
  UPLOAD_OPENED_CONVERSATION_FILE_CHANNEL,
} from "../../ipc/channels.ts";

/** Files waiting for the renderer at once; the oldest is dropped beyond this. */
const MAX_PENDING_CONVERSATION_FILES = 8;

interface OpenedFile extends DesktopOpenedConversationFile {
  readonly path: string;
}

/** Opened but not yet taken by the renderer. */
const waiting = new Map<string, OpenedFile>();
/** Taken by the renderer and not yet uploaded. */
const taken = new Map<string, OpenedFile>();

/** The `.scic` paths among process arguments, resolved against the working directory. */
function conversationFilePathsFromArgv(
  argv: ReadonlyArray<string>,
  cwd: string,
): ReadonlyArray<string> {
  return argv
    .slice(1)
    .filter(
      (argument) =>
        !argument.startsWith("-") && argument.toLowerCase().endsWith(SCIC_FILE_EXTENSION),
    )
    .map((argument) => NodePath.resolve(cwd, argument));
}

/** Queues a regular `.scic` file for the renderer; false when it is not one. */
async function registerOpenedConversationFile(path: string): Promise<boolean> {
  if (!path.toLowerCase().endsWith(SCIC_FILE_EXTENSION)) return false;
  const stat = await NodeFS.promises.stat(path).catch(() => null);
  if (stat === null || !stat.isFile()) return false;
  for (const [token, file] of waiting) {
    if (file.path === path) waiting.delete(token);
  }
  while (waiting.size >= MAX_PENDING_CONVERSATION_FILES) {
    const oldest = waiting.keys().next().value;
    if (oldest === undefined) break;
    waiting.delete(oldest);
  }
  const token = NodeCrypto.randomUUID();
  waiting.set(token, {
    token,
    path,
    fileName: NodePath.basename(path).slice(0, 255),
    sizeBytes: stat.size,
  });
  return true;
}

/** Hands every waiting file to the renderer, by token. */
function takeOpenedConversationFileList(): ReadonlyArray<DesktopOpenedConversationFile> {
  const files = [...waiting.values()];
  waiting.clear();
  for (const file of files) {
    while (taken.size >= MAX_PENDING_CONVERSATION_FILES) {
      const oldest = taken.keys().next().value;
      if (oldest === undefined) break;
      taken.delete(oldest);
    }
    taken.set(file.token, file);
  }
  return files.map(({ token, fileName, sizeBytes }) => ({ token, fileName, sizeBytes }));
}

export function uploadTarget(rawUrl: string, allowedOrigins: ReadonlySet<string>): URL | null {
  try {
    const url = new URL(rawUrl);
    // The renderer may display untrusted imported content. Only the exact
    // origins of managed local backends may receive an OS-opened file; remote
    // environments can import a user-picked browser File instead.
    return (url.protocol === "http:" || url.protocol === "https:") &&
      allowedOrigins.has(url.origin) &&
      url.pathname.startsWith(`${SCIENT_CONVERSATION_IMPORT_UPLOAD_PATH}/`) &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
      ? url
      : null;
  } catch {
    return null;
  }
}

/** Streams a taken file to its signed upload URL. The token is spent either way. */
async function uploadOpenedConversationFileTo(
  request: DesktopConversationFileUploadRequest,
  allowedOrigins: ReadonlySet<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopConversationFileUploadResult> {
  const file = taken.get(request.token);
  if (!file) return { _tag: "failed", reason: "file-unavailable" };
  const target = uploadTarget(request.url, allowedOrigins);
  if (target === null) return { _tag: "failed", reason: "invalid-url" };
  taken.delete(request.token);
  const stat = await NodeFS.promises.stat(file.path).catch(() => null);
  if (stat === null || !stat.isFile()) return { _tag: "failed", reason: "file-unavailable" };
  if (stat.size !== file.sizeBytes) return { _tag: "failed", reason: "file-changed" };
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      headers: { "content-type": SCIC_MEDIA_TYPE },
      body: NodeStream.Readable.toWeb(NodeFS.createReadStream(file.path)) as ReadableStream,
      duplex: "half",
    } as RequestInit);
    return response.ok ? { _tag: "uploaded" } : { _tag: "failed", reason: "rejected" };
  } catch {
    return { _tag: "failed", reason: "network-failed" };
  }
}

/** Tells the renderer that files are waiting, and brings Scient forward. */
const announce = Effect.gen(function* () {
  const windows = yield* ElectronWindow.ElectronWindow;
  const main = yield* windows.currentMainOrFirst;
  if (Option.isNone(main)) return;
  yield* windows.reveal(main.value);
  if (!main.value.isDestroyed()) main.value.webContents.send(CONVERSATION_FILES_OPENED_CHANNEL);
});

/**
 * Listens for opened files for the life of the app. Registered before the app
 * is ready, because macOS delivers a launch's `open-file` early; files that
 * arrive before a window exists wait until the renderer takes them.
 */
export const installConversationFileOpening = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
  const runPromise = Effect.runPromiseWith(context);
  const open = (path: string) => {
    void registerOpenedConversationFile(path).then((added) =>
      added ? runPromise(announce) : undefined,
    );
  };
  yield* electronApp.on("open-file", (event: Electron.Event, path: string) => {
    if (!path.toLowerCase().endsWith(SCIC_FILE_EXTENSION)) return;
    event.preventDefault();
    open(path);
  });
  yield* electronApp.on(
    "second-instance",
    (_event: Electron.Event, argv: ReadonlyArray<string>, workingDirectory: string) => {
      for (const path of conversationFilePathsFromArgv(argv, workingDirectory)) open(path);
    },
  );
  for (const path of conversationFilePathsFromArgv(process.argv, process.cwd())) open(path);
}).pipe(Effect.withSpan("scient.conversationImport.installFileOpening"));

export const takeOpenedConversationFiles = makeIpcMethod({
  channel: TAKE_OPENED_CONVERSATION_FILES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopOpenedConversationFile),
  handler: () => Effect.sync(takeOpenedConversationFileList),
});

export const uploadOpenedConversationFile = makeIpcMethod({
  channel: UPLOAD_OPENED_CONVERSATION_FILE_CHANNEL,
  payload: DesktopConversationFileUploadRequest,
  result: DesktopConversationFileUploadResult,
  handler: (request) =>
    Effect.gen(function* () {
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const instances = yield* pool.list;
      const origins = new Set<string>();
      for (const instance of instances) {
        const config = yield* instance.currentConfig;
        if (Option.isSome(config)) origins.add(config.value.httpBaseUrl.origin);
      }
      return yield* Effect.promise(() => uploadOpenedConversationFileTo(request, origins));
    }),
});
