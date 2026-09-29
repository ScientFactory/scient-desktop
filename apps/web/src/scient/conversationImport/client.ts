import {
  cancelEnvironmentConversationImport,
  confirmEnvironmentConversationImport,
  createEnvironmentConversationImportUpload,
  previewEnvironmentConversationImport,
} from "@t3tools/client-runtime/state/scient-conversation-import";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  ConversationImportId,
  EnvironmentId,
  ScientConversationImportConfirmRequest,
} from "@t3tools/contracts";
import { SCIC_MEDIA_TYPE, SCIENT_CONVERSATION_IMPORT_UPLOAD_PATH } from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";
import { ConversationImportNotice } from "./importDialog.logic";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) {
    throw new ConversationImportNotice(
      "The destination isn't connected. Reconnect it and try again.",
    );
  }
  return connection;
}

const UNSAFE_UPLOAD = "The destination can't receive files right now. Try again.";

export async function createConversationImportUpload(
  environmentId: EnvironmentId,
  fileName: string,
  sizeBytes: number,
  markdownMode?: "messages" | "document",
) {
  const connection = prepared(environmentId);
  const upload = await runtime.runPromise(
    createEnvironmentConversationImportUpload({
      prepared: connection,
      upload: { fileName, sizeBytes, ...(markdownMode ? { markdownMode } : {}) },
    }),
  );
  const url = resolveAssetUrl(connection.httpBaseUrl, upload.relativeUrl);
  if (url === null) throw new ConversationImportNotice(UNSAFE_UPLOAD);
  const target = new URL(url);
  const environment = new URL(connection.httpBaseUrl);
  if (
    target.origin !== environment.origin ||
    !target.pathname.startsWith(`${SCIENT_CONVERSATION_IMPORT_UPLOAD_PATH}/`) ||
    target.username !== "" ||
    target.password !== "" ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    throw new ConversationImportNotice(UNSAFE_UPLOAD);
  }
  return { ...upload, url };
}

/**
 * Streams a browser file to its signed upload URL. Reports progress, and
 * stops the transfer when `signal` aborts (the promise then rejects with an
 * `AbortError`); the caller releases the staged import.
 */
export function uploadConversationFile(
  url: string,
  file: File,
  options: {
    readonly signal: AbortSignal;
    readonly onProgress: (sentBytes: number, totalBytes: number) => void;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () => new DOMException("The upload was cancelled.", "AbortError");
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const settle = () => options.signal.removeEventListener("abort", abort);
    request.open("POST", url);
    request.setRequestHeader(
      "content-type",
      file.name.toLowerCase().endsWith(".md") ? "text/markdown; charset=utf-8" : SCIC_MEDIA_TYPE,
    );
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) options.onProgress(event.loaded, event.total);
    });
    request.addEventListener("load", () => {
      settle();
      if (request.status >= 200 && request.status < 300) resolve();
      else
        reject(new ConversationImportNotice("The destination didn't accept the file. Try again."));
    });
    request.addEventListener("error", () => {
      settle();
      reject(
        new ConversationImportNotice(
          "The file couldn't be sent. Check the connection and try again.",
        ),
      );
    });
    request.addEventListener("abort", () => {
      settle();
      reject(abortError());
    });
    options.signal.addEventListener("abort", abort, { once: true });
    request.send(file);
  });
}

export async function previewConversationImport(
  environmentId: EnvironmentId,
  importId: ConversationImportId,
) {
  return runtime.runPromise(
    previewEnvironmentConversationImport({ prepared: prepared(environmentId), importId }),
  );
}

export async function confirmConversationImport(
  environmentId: EnvironmentId,
  request: ScientConversationImportConfirmRequest,
) {
  return runtime.runPromise(
    confirmEnvironmentConversationImport({ prepared: prepared(environmentId), request }),
  );
}

export async function cancelConversationImport(
  environmentId: EnvironmentId,
  importId: ConversationImportId,
) {
  return runtime.runPromise(
    cancelEnvironmentConversationImport({ prepared: prepared(environmentId), importId }),
  );
}
