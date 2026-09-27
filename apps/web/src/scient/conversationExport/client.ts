import {
  exportEnvironmentConversation,
  prepareEnvironmentConversationExport,
} from "@t3tools/client-runtime/state/scient-conversation-export";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { EnvironmentId, ScientConversationExportRequest, ThreadId } from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The conversation's environment is not connected.");
  return connection;
}

// Async so a disconnected environment rejects the promise instead of throwing
// synchronously past the caller's rejection handler.
export async function prepareConversationExport(environmentId: EnvironmentId, threadId: ThreadId) {
  return runtime.runPromise(
    prepareEnvironmentConversationExport({ prepared: prepared(environmentId), threadId }),
  );
}

export async function exportConversation(
  environmentId: EnvironmentId,
  request: ScientConversationExportRequest,
) {
  return runtime.runPromise(
    exportEnvironmentConversation({ prepared: prepared(environmentId), request }),
  );
}

/** The absolute URL of a produced export file on its environment. */
export function exportFileUrl(environmentId: EnvironmentId, relativeUrl: string): string | null {
  return resolveAssetUrl(prepared(environmentId).httpBaseUrl, relativeUrl);
}
