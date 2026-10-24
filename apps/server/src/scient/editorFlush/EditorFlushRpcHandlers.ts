/**
 * The window side of the editor flush: each window connects for requests,
 * asks where its editors' files are, answers each request, and says goodbye
 * when it closes. Every call is bound to the session that authenticated this
 * connection.
 *
 * @module EditorFlushRpcHandlers
 */
import { WS_METHODS, WsWorkspaceRpcGroup } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";
import { EditorFlush } from "./EditorFlush.ts";

export const makeEditorFlushRpcHandlers = ({
  observeRpcEffect,
  observeRpcStream,
  sessionId,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream"> & {
  /** The authenticated session of this WebSocket connection. */
  readonly sessionId: string;
}) =>
  ({
    [WS_METHODS.editorsFlushConnect]: (input) =>
      observeRpcStream(
        WS_METHODS.editorsFlushConnect,
        Stream.unwrap(EditorFlush.use((flush) => flush.connect(sessionId, input))),
        { "rpc.aggregate": "editors" },
      ),
    [WS_METHODS.editorsFlushResolve]: (input) =>
      observeRpcEffect(
        WS_METHODS.editorsFlushResolve,
        EditorFlush.use((flush) => flush.resolve(sessionId, input)),
        { "rpc.aggregate": "editors" },
      ),
    [WS_METHODS.editorsFlushRespond]: (input) =>
      observeRpcEffect(
        WS_METHODS.editorsFlushRespond,
        EditorFlush.use((flush) => flush.respond(sessionId, input)),
        { "rpc.aggregate": "editors" },
      ),
    [WS_METHODS.editorsFlushLeave]: (input) =>
      observeRpcEffect(
        WS_METHODS.editorsFlushLeave,
        EditorFlush.use((flush) => flush.leave(sessionId, input)),
        { "rpc.aggregate": "editors" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    | typeof WS_METHODS.editorsFlushConnect
    | typeof WS_METHODS.editorsFlushResolve
    | typeof WS_METHODS.editorsFlushRespond
    | typeof WS_METHODS.editorsFlushLeave
  >;
