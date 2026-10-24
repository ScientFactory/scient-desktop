/**
 * The window side of the editor flush: each window connects for requests
 * and answers each one.
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
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream">) =>
  ({
    [WS_METHODS.editorsFlushConnect]: (input) =>
      observeRpcStream(
        WS_METHODS.editorsFlushConnect,
        Stream.unwrap(EditorFlush.use((flush) => flush.connect(input))),
        { "rpc.aggregate": "editors" },
      ),
    [WS_METHODS.editorsFlushRespond]: (input) =>
      observeRpcEffect(
        WS_METHODS.editorsFlushRespond,
        EditorFlush.use((flush) => flush.respond(input)),
        { "rpc.aggregate": "editors" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    typeof WS_METHODS.editorsFlushConnect | typeof WS_METHODS.editorsFlushRespond
  >;
