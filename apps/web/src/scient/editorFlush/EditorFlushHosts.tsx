import { useAtomMount } from "@effect/atom-react";
import { subscribe, type EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EditorFlushRequest,
  type EditorFlushResponse,
  type EditorFlushStreamEvent,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";
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
import { flushFolderEditors, type LocateFiles, type WindowEditors } from "./flushFolderEditors";

const editorFlushRequests = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:scient-editor-flush:requests",
  // An atom publishes only a chunk's last value, so keep one event each.
  subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.editorsFlushConnect>) =>
    subscribe(WS_METHODS.editorsFlushConnect, input).pipe(Stream.rechunk(1)),
  idleTtlMs: 0,
});

const locateEditorFiles = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scient-editor-flush:resolve",
  tag: WS_METHODS.editorsFlushResolve,
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

/** Answers each request once, on the connection it came from, independently of React renders. */
function createEditorFlushConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AsyncResult.AsyncResult<EditorFlushStreamEvent, E>>;
  readonly clientId: string;
  readonly environmentId: EnvironmentId;
  readonly locate: (requestId: string) => LocateFiles;
  readonly respond: (response: EditorFlushResponse) => Promise<unknown>;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    let disposed = false;
    const answered = new Set<string>();
    const consume = (result: AsyncResult.AsyncResult<EditorFlushStreamEvent, E>) => {
      if (disposed || !AsyncResult.isSuccess(result) || result.value.type !== "request") return;
      const { connectionId, request } = result.value;
      const key = `${connectionId}\0${request.requestId}`;
      if (answered.has(key)) return;
      answered.add(key);
      const oldest = answered.values().next().value;
      if (answered.size > 256 && oldest !== undefined) answered.delete(oldest);
      void answer(options.environmentId, request, options.locate(request.requestId))
        .then((reply) =>
          disposed
            ? undefined
            : options.respond({
                clientId: options.clientId,
                requestId: request.requestId,
                ...reply,
              }),
        )
        .catch(() => {
          // The connection is gone; the server counts this window as unanswered.
        });
    };
    get.addFinalizer(() => {
      disposed = true;
    });
    // Subscribe before reading the cached value; request ids prevent answering twice.
    const initial = get.once(options.requestsAtom);
    get.subscribe(options.requestsAtom, consume);
    consume(initial);
  }).pipe(
    Atom.setIdleTTL(0),
    Atom.withLabel(`scient-editor-flush:${options.environmentId}:${options.clientId}`),
  );
}

function EditorFlushEnvironmentHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const [clientId] = useState(() => `scient-editors-${randomUUID()}`);
  const respond = useAtomCommand(respondToEditorFlush, { reportFailure: false });
  const resolve = useAtomCommand(locateEditorFiles, { reportFailure: false });
  const respondLatest = useStableCallback((response: EditorFlushResponse) =>
    respond({ environmentId, input: response }),
  );
  const locateLatest = useStableCallback((requestId: string): LocateFiles => async (files) => {
    const result = await resolve({ environmentId, input: { clientId, requestId, files } });
    if (result._tag !== "Success") throw new Error("The server could not place the files.");
    return result.value.files;
  });
  const [consumer] = useState(() =>
    createEditorFlushConsumerAtom({
      requestsAtom: editorFlushRequests({ environmentId, input: { clientId } }),
      clientId,
      environmentId,
      locate: locateLatest,
      respond: respondLatest,
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
