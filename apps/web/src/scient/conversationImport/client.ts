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

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The destination environment is not connected.");
  return connection;
}

export async function createConversationImportUpload(
  environmentId: EnvironmentId,
  fileName: string,
  sizeBytes: number,
) {
  const connection = prepared(environmentId);
  const upload = await runtime.runPromise(
    createEnvironmentConversationImportUpload({
      prepared: connection,
      upload: { fileName, sizeBytes },
    }),
  );
  const url = resolveAssetUrl(connection.httpBaseUrl, upload.relativeUrl);
  if (url === null) throw new Error("The import upload URL is invalid.");
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
    throw new Error("The environment returned an unsafe import upload URL.");
  }
  return { ...upload, url };
}

export async function uploadConversationFile(url: string, file: File): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": SCIC_MEDIA_TYPE },
    body: file,
  });
  if (!response.ok) throw new Error(`The import upload was refused (${response.status}).`);
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
