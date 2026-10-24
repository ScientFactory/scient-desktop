import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  EditorFlushResolveInput,
  EditorFlushResolveResult,
  EditorFlushResponse,
  EditorFlushStreamEvent,
  EditorFlushWindow,
} from "./editorFlush.ts";

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_EDITOR_FLUSH_WS_METHODS = {
  editorsFlushConnect: "editors.flushConnect",
  editorsFlushResolve: "editors.flushResolve",
  editorsFlushRespond: "editors.flushRespond",
} as const;

export const WsEditorsFlushConnectRpc = Rpc.make(
  SCIENT_EDITOR_FLUSH_WS_METHODS.editorsFlushConnect,
  {
    payload: EditorFlushWindow,
    success: EditorFlushStreamEvent,
    stream: true,
    error: EnvironmentAuthorizationError,
  },
);

export const WsEditorsFlushResolveRpc = Rpc.make(
  SCIENT_EDITOR_FLUSH_WS_METHODS.editorsFlushResolve,
  {
    payload: EditorFlushResolveInput,
    success: EditorFlushResolveResult,
    error: EnvironmentAuthorizationError,
  },
);

export const WsEditorsFlushRespondRpc = Rpc.make(
  SCIENT_EDITOR_FLUSH_WS_METHODS.editorsFlushRespond,
  {
    payload: EditorFlushResponse,
    success: Schema.Struct({ accepted: Schema.Boolean }),
    error: EnvironmentAuthorizationError,
  },
);
