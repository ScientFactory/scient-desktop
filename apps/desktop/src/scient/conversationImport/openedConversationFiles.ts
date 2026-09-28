// @effect-diagnostics nodeBuiltinImport:off -- opened files are inspected and streamed from disk in the main process.
/**
 * `.scic` files the operating system opens with Scient: a double-click or
 * Open With (macOS `open-file`), a launch argument (Windows and Linux), or an
 * argument handed to the running instance (`second-instance`).
 *
 * The main process keeps each file's path to itself and gives the renderer an
 * opaque token, its name, and its size. The renderer admits the upload on its
 * server, then asks the main process to stream the file to the signed upload
 * URL, which must be the import upload route, and can cancel that upload. The
 * same preview then opens as for a file picked in the app.
 *
 * macOS delivers the `open-file` of a launch (a double-click while Scient is
 * closed) before startup has built its services, so `captureConversationFileOpens`
 * listens from module load and holds paths until `installConversationFileOpening`
 * takes them; files that arrive before a window exists then wait until the
 * renderer takes them.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import {
  DesktopConversationFileUploadCancelRequest,
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
import * as Electron from "electron";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import { makeIpcMethod } from "../../ipc/DesktopIpc.ts";
import {
  CANCEL_OPENED_CONVERSATION_FILE_UPLOAD_CHANNEL,
  CONVERSATION_FILES_OPENED_CHANNEL,
  TAKE_OPENED_CONVERSATION_FILES_CHANNEL,
  UPLOAD_OPENED_CONVERSATION_FILE_CHANNEL,
} from "../../ipc/channels.ts";

/** Files waiting for the renderer at once; the oldest is dropped beyond this. */
const MAX_PENDING_CONVERSATION_FILES = 8;
const TAKEN_FILE_LIFETIME_MS = 30 * 60_000;

interface OpenedFile extends DesktopOpenedConversationFile {
  readonly path: string;
}

interface TakenFile extends OpenedFile {
  readonly expiresAt: number;
  readonly approvedOrigins: Set<string>;
  /** Aborts the upload in progress; null when none is. */
  upload: AbortController | null;
  /** The renderer cancelled this file's import: nothing more is sent. */
  cancelled: boolean;
}

/** Opened but not yet taken by the renderer. */
const waiting = new Map<string, OpenedFile>();
/** Taken by the renderer; retained briefly so upload and preview can be retried. */
const taken = new Map<string, TakenFile>();

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
export async function registerOpenedConversationFile(path: string): Promise<boolean> {
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
export function takeOpenedConversationFileList(): ReadonlyArray<DesktopOpenedConversationFile> {
  const files = [...waiting.values()];
  waiting.clear();
  for (const [token, file] of taken) {
    if (file.expiresAt <= performance.now()) taken.delete(token);
  }
  for (const file of files) {
    while (taken.size >= MAX_PENDING_CONVERSATION_FILES) {
      const oldest = taken.keys().next().value;
      if (oldest === undefined) break;
      taken.delete(oldest);
    }
    taken.set(file.token, {
      ...file,
      expiresAt: performance.now() + TAKEN_FILE_LIFETIME_MS,
      approvedOrigins: new Set(),
      upload: null,
      cancelled: false,
    });
  }
  return files.map(({ token, fileName, sizeBytes }) => ({ token, fileName, sizeBytes }));
}

export function uploadTarget(
  rawUrl: string,
  allowedOrigins: ReadonlySet<string>,
): {
  readonly url: URL;
  readonly requiresApproval: boolean;
  readonly plaintextNetwork: boolean;
} | null {
  try {
    const url = new URL(rawUrl);
    const prefix = `${SCIENT_CONVERSATION_IMPORT_UPLOAD_PATH}/`;
    const token = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    if (
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token) ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    )
      return null;
    const managed = allowedOrigins.has(url.origin);
    return url.protocol === "http:" || url.protocol === "https:"
      ? {
          url,
          requiresApproval: !managed,
          plaintextNetwork:
            !managed &&
            url.protocol === "http:" &&
            url.hostname !== "127.0.0.1" &&
            url.hostname !== "[::1]",
        }
      : null;
  } catch {
    return null;
  }
}

export function remoteUploadApprovalOptions(
  origin: string,
  fileName: string,
  plaintextNetwork: boolean,
): Electron.MessageBoxOptions {
  const displayName = fileName.replace(/[\p{Cc}\p{Cf}]/gu, "�");
  return {
    type: plaintextNetwork ? "warning" : "question",
    title: plaintextNetwork ? "HTTP upload has no TLS protection" : "Send conversation file?",
    message: plaintextNetwork
      ? `Send “${displayName}” to ${origin} over HTTP without TLS?`
      : `Send “${displayName}” to ${origin}?`,
    detail: plaintextNetwork
      ? "This HTTP upload has no TLS protection. Others may read the file on an unprotected network. Continue only if you trust this destination and the network or VPN carrying it."
      : "Scient will upload this OS-opened file to that server for preview. Confirm you recognize the destination.",
    buttons: ["Cancel", "Send file"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/** Streams a taken file to its signed upload URL, retaining it for a fresh-URL retry. */
export async function uploadOpenedConversationFileTo(
  request: DesktopConversationFileUploadRequest,
  allowedOrigins: ReadonlySet<string>,
  approveRemote: (origin: string, fileName: string, plaintextNetwork: boolean) => Promise<boolean>,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopConversationFileUploadResult> {
  const file = taken.get(request.token);
  if (!file) return { _tag: "failed", reason: "file-unavailable" };
  if (file.expiresAt <= performance.now()) {
    taken.delete(request.token);
    return { _tag: "failed", reason: "file-unavailable" };
  }
  if (file.cancelled) return { _tag: "failed", reason: "cancelled" };
  if (file.upload !== null) return { _tag: "failed", reason: "file-unavailable" };
  const target = uploadTarget(request.url, allowedOrigins);
  if (target === null) return { _tag: "failed", reason: "invalid-url" };
  const upload = new AbortController();
  file.upload = upload;
  const cancelled = { _tag: "failed", reason: "cancelled" } as const;
  try {
    const stat = await NodeFS.promises.stat(file.path).catch(() => null);
    if (stat === null || !stat.isFile()) return { _tag: "failed", reason: "file-unavailable" };
    if (stat.size !== file.sizeBytes) return { _tag: "failed", reason: "file-changed" };
    if (target.requiresApproval && !file.approvedOrigins.has(target.url.origin)) {
      const approved = await approveRemote(
        target.url.origin,
        file.fileName,
        target.plaintextNetwork,
      ).catch(() => false);
      if (upload.signal.aborted) return cancelled;
      if (!approved) return { _tag: "failed", reason: "declined" };
      file.approvedOrigins.add(target.url.origin);
    }
    if (upload.signal.aborted) return cancelled;
    if (file.expiresAt <= performance.now()) {
      return { _tag: "failed", reason: "file-unavailable" };
    }
    // A cancel stops the request and the file read together.
    const source = NodeFS.createReadStream(file.path, { signal: upload.signal });
    source.on("error", () => {});
    try {
      const response = await fetchImpl(target.url, {
        method: "POST",
        headers: { "content-type": SCIC_MEDIA_TYPE },
        body: NodeStream.Readable.toWeb(source) as ReadableStream,
        duplex: "half",
        redirect: "error",
        signal: upload.signal,
      } as RequestInit);
      if (upload.signal.aborted) return cancelled;
      return response.ok ? { _tag: "uploaded" } : { _tag: "failed", reason: "rejected" };
    } finally {
      source.destroy();
    }
  } catch {
    return upload.signal.aborted ? cancelled : { _tag: "failed", reason: "network-failed" };
  } finally {
    file.upload = null;
  }
}

/**
 * Cancels an opened file's import: an upload in progress is aborted (request
 * and file read), and every later upload of the token ends `cancelled`
 * without sending anything. An unknown token is ignored.
 */
export function cancelOpenedConversationFileUploadFor(token: string): void {
  const file = taken.get(token);
  if (!file) return;
  file.cancelled = true;
  file.upload?.abort();
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
 * Opened paths on their way to a handler: held, oldest first and at most
 * `limit`, until one is attached, then handed over as they arrive.
 */
export function makeOpenedPathRelay(limit = MAX_PENDING_CONVERSATION_FILES) {
  const held: string[] = [];
  let handler: ((path: string) => void) | null = null;
  return {
    receive: (path: string) => {
      if (handler !== null) return handler(path);
      held.push(path);
      if (held.length > limit) held.shift();
    },
    /** Delivers the held paths, then every later one, until detached. */
    attach: (next: (path: string) => void) => {
      handler = next;
      for (const path of held.splice(0)) next(path);
      return () => {
        if (handler === next) handler = null;
      };
    },
  };
}
export type OpenedPathRelay = ReturnType<typeof makeOpenedPathRelay>;

const openedPaths = makeOpenedPathRelay();

/** Routes the app's `open-file` for `.scic` files to `relay`; other files keep the default. */
export function listenForOpenedConversationFiles(
  app: {
    readonly on: (
      event: "open-file",
      listener: (event: Electron.Event, path: string) => void,
    ) => unknown;
  },
  relay: OpenedPathRelay,
): void {
  app.on("open-file", (event, path) => {
    if (!path.toLowerCase().endsWith(SCIC_FILE_EXTENSION)) return;
    event.preventDefault();
    relay.receive(path);
  });
}

let capturing = false;

/**
 * Starts listening for `open-file` at once, synchronously, so a launch's early
 * event is never missed. Called at module load of the desktop app; idempotent.
 * Outside Electron's main process (unit tests) there is no app and it does
 * nothing.
 */
export function captureConversationFileOpens(): void {
  const app = Electron.app as Electron.App | undefined;
  if (capturing || app === undefined) return;
  capturing = true;
  listenForOpenedConversationFiles(app, openedPaths);
}

/**
 * Handles opened files for the life of the app: those macOS opened since
 * module load, later ones, launch arguments, and a second instance's.
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
  captureConversationFileOpens();
  yield* Effect.acquireRelease(
    Effect.sync(() => openedPaths.attach(open)),
    (detach) => Effect.sync(detach),
  );
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

export const cancelOpenedConversationFileUpload = makeIpcMethod({
  channel: CANCEL_OPENED_CONVERSATION_FILE_UPLOAD_CHANNEL,
  payload: DesktopConversationFileUploadCancelRequest,
  result: Schema.Void,
  handler: (request) => Effect.sync(() => cancelOpenedConversationFileUploadFor(request.token)),
});

export const uploadOpenedConversationFile = makeIpcMethod({
  channel: UPLOAD_OPENED_CONVERSATION_FILE_CHANNEL,
  payload: DesktopConversationFileUploadRequest,
  result: DesktopConversationFileUploadResult,
  handler: (request) =>
    Effect.gen(function* () {
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const dialog = yield* ElectronDialog.ElectronDialog;
      const runPromise = Effect.runPromiseWith(
        yield* Effect.context<ElectronDialog.ElectronDialog>(),
      );
      const instances = yield* pool.list;
      const origins = new Set<string>();
      for (const instance of instances) {
        const config = yield* instance.currentConfig;
        if (Option.isSome(config)) origins.add(config.value.httpBaseUrl.origin);
      }
      const approveRemote = (origin: string, fileName: string, plaintextNetwork: boolean) =>
        runPromise(
          dialog
            .showMessageBox(remoteUploadApprovalOptions(origin, fileName, plaintextNetwork))
            .pipe(Effect.map((result) => result.response === 1)),
        );
      return yield* Effect.promise(() =>
        uploadOpenedConversationFileTo(request, origins, approveRemote),
      );
    }),
});
