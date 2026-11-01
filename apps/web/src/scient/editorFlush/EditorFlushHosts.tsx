import { useAtomMount, useAtomRefresh } from "@effect/atom-react";
import { subscribe, type EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EditorFlushRequest,
  type EditorFlushResponse,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { useState } from "react";

import { workspaceFileSessionFlush } from "~/components/files/useFileSaveCoordinator";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useStableCallback } from "~/hooks/useStableCallback";
import { randomUUID } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { latexDocumentInputs } from "../latex/latexDocumentInputs";
import { markdownPersistenceRegistry } from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { editorCompositions } from "./editorComposition";
import { createEditorFlushConsumerAtom } from "./editorFlushConsumer";
import { flushFolderEditors, type LocateFiles, type WindowEditors } from "./flushFolderEditors";

const editorFlushRequests = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:scient-editor-flush:requests",
  // An atom publishes only a chunk's last value, so keep one event each.
  subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.editorsFlushConnect>) =>
    // A goodbye or a replaced connection ends the stream; a window still open joins again.
    subscribe(WS_METHODS.editorsFlushConnect, input, {
      resubscribeOnCompleteAfter: "1 second",
    }).pipe(Stream.rechunk(1)),
  idleTtlMs: 0,
});

const locateEditorFiles = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scient-editor-flush:resolve",
  tag: WS_METHODS.editorsFlushResolve,
});

const leaveEditorFlush = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scient-editor-flush:leave",
  tag: WS_METHODS.editorsFlushLeave,
});

const respondToEditorFlush = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scient-editor-flush:response",
  tag: WS_METHODS.editorsFlushRespond,
});

const windowEditors: WindowEditors = {
  documents: markdownPersistenceRegistry,
  fileSessions: workspaceFileSessionFlush,
  latexInputs: latexDocumentInputs,
  compositions: editorCompositions,
};

/** This window's answer; an unexpected error fails the whole folder, never passes it. */
async function answer(
  environmentId: EnvironmentId,
  request: EditorFlushRequest,
  locate: LocateFiles,
): Promise<Pick<EditorFlushResponse, "saved" | "failures">> {
  try {
    return await flushFolderEditors(environmentId, windowEditors, locate);
  } catch {
    return {
      saved: [],
      failures: [
        {
          path: request.folder,
          reason: "save-failed",
          message: "This window could not save its editors.",
        },
      ],
    };
  }
}

function EditorFlushEnvironmentHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const [clientId] = useState(() => `scient-editors-${randomUUID()}`);
  const [requestsAtom] = useState(() =>
    editorFlushRequests({ environmentId, input: { clientId } }),
  );
  const respond = useAtomCommand(respondToEditorFlush, { reportFailure: false });
  const resolve = useAtomCommand(locateEditorFiles, { reportFailure: false });
  const leave = useAtomCommand(leaveEditorFlush, { reportFailure: false });
  const reconnect = useAtomRefresh(requestsAtom);
  const reconnectLatest = useStableCallback(() => reconnect());
  const leaveLatest = useStableCallback((connectionId: string) =>
    leave({ environmentId, input: { clientId, connectionId } }),
  );
  const respondLatest = useStableCallback((response: EditorFlushResponse) =>
    respond({ environmentId, input: response }),
  );
  const locateLatest = useStableCallback(
    (requestId: string, connectionId: string): LocateFiles =>
      async (files) => {
        const result = await resolve({
          environmentId,
          input: { clientId, connectionId, requestId, files },
        });
        if (result._tag !== "Success") throw new Error("The server could not place the files.");
        return result.value.files;
      },
  );
  const [consumer] = useState(() =>
    createEditorFlushConsumerAtom({
      requestsAtom,
      clientId,
      environmentId,
      flush: (request, connectionId) =>
        answer(environmentId, request, locateLatest(request.requestId, connectionId)),
      respond: respondLatest,
      leave: leaveLatest,
      reconnect: reconnectLatest,
    }),
  );
  useAtomMount(consumer);
  return null;
}

/**
 * Every window answers the server's requests to save the editors of a folder,
 * for each environment it is connected to. Nothing is shown.
 */
export function EditorFlushHosts() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) => (
        <EditorFlushEnvironmentHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}
