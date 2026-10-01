import {
  enqueueEnvironmentScientThreadQueueItem,
  controlEnvironmentScientThreadQueue,
  listEnvironmentScientThreadQueue,
  removeEnvironmentScientThreadQueueItem,
  reorderEnvironmentScientThreadQueue,
  updateEnvironmentScientThreadQueueItem,
} from "@t3tools/client-runtime/state/scient-thread-queue";
import type {
  ChatAttachment,
  EnvironmentId,
  ScientThreadQueueControlRequest,
  ScientThreadQueueEnqueueRequest,
  ScientThreadQueueUpdateRequest,
  ScientThreadQueueItemId,
  ThreadId,
} from "@t3tools/contracts";

import { resolveAssetUrl } from "../../assets/assetUrls";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The selected environment is not connected.");
  return connection;
}

export function listThreadQueue(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  knownRevision?: number,
) {
  return runtime.runPromise(
    listEnvironmentScientThreadQueue({
      prepared: prepared(environmentId),
      threadId,
      ...(knownRevision !== undefined ? { knownRevision } : {}),
    }),
  );
}

export function enqueueThreadQueueItem(
  environmentId: EnvironmentId,
  input: ScientThreadQueueEnqueueRequest,
) {
  return runtime.runPromise(
    enqueueEnvironmentScientThreadQueueItem({ prepared: prepared(environmentId), ...input }),
  );
}

export function removeThreadQueueItem(
  environmentId: EnvironmentId,
  input: { readonly threadId: ThreadId; readonly queueItemId: ScientThreadQueueItemId },
) {
  return runtime.runPromise(
    removeEnvironmentScientThreadQueueItem({ prepared: prepared(environmentId), ...input }),
  );
}

export function updateThreadQueueItem(
  environmentId: EnvironmentId,
  input: ScientThreadQueueUpdateRequest,
) {
  return runtime.runPromise(
    updateEnvironmentScientThreadQueueItem({ prepared: prepared(environmentId), ...input }),
  );
}

export function reorderThreadQueue(
  environmentId: EnvironmentId,
  input: {
    readonly threadId: ThreadId;
    readonly queueItemIds: ReadonlyArray<ScientThreadQueueItemId>;
  },
) {
  return runtime.runPromise(
    reorderEnvironmentScientThreadQueue({ prepared: prepared(environmentId), ...input }),
  );
}

export function controlThreadQueue(
  environmentId: EnvironmentId,
  payload: ScientThreadQueueControlRequest,
) {
  return runtime.runPromise(
    controlEnvironmentScientThreadQueue({ prepared: prepared(environmentId), payload }),
  );
}

export async function readQueuedAttachmentFile(
  environmentId: EnvironmentId,
  attachment: ChatAttachment,
) {
  if (attachment.type !== "image" && attachment.type !== "file")
    throw new Error("This queued attachment cannot be restored.");
  const connection = prepared(environmentId);
  const issued = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: {
        resource: {
          _tag: "attachment",
          attachmentId: attachment.id,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
        },
      },
    }),
    { reportFailure: false, reportDefect: false, refresh: true },
  );
  if (issued._tag === "Failure") throw squashAtomCommandFailure(issued);
  const url = resolveAssetUrl(connection.httpBaseUrl, issued.value.relativeUrl);
  if (url === null) throw new Error("The environment returned an invalid attachment URL.");
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not restore attachment: ${attachment.name}`);
  return new File([await response.blob()], attachment.name, { type: attachment.mimeType });
}
