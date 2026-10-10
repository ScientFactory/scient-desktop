import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  EnvironmentFileChangeEvent,
  EnvironmentFileLinkResolution,
  EnvironmentFileLinkResolveInput,
  EnvironmentFilePrepareError,
  EnvironmentFilePrepareInput,
  EnvironmentFilePrepareResult,
} from "../fileOpening.ts";

/** Spread into rpc.ts WS_METHODS where these methods have always been listed. */
export const SCIENT_FILE_OPENING_WS_METHODS = {
  filesystemPrepareFileOpen: "filesystem.prepareFileOpen",
  filesystemResolveFileLink: "filesystem.resolveFileLink",
  filesystemSubscribeFileChanges: "filesystem.subscribeFileChanges",
} as const;

export const WsFilesystemPrepareFileOpenRpc = Rpc.make(
  SCIENT_FILE_OPENING_WS_METHODS.filesystemPrepareFileOpen,
  {
    payload: EnvironmentFilePrepareInput,
    success: EnvironmentFilePrepareResult,
    error: Schema.Union([EnvironmentFilePrepareError, EnvironmentAuthorizationError]),
  },
);

export const WsFilesystemResolveFileLinkRpc = Rpc.make(
  SCIENT_FILE_OPENING_WS_METHODS.filesystemResolveFileLink,
  {
    payload: EnvironmentFileLinkResolveInput,
    success: EnvironmentFileLinkResolution,
    error: Schema.Union([EnvironmentFilePrepareError, EnvironmentAuthorizationError]),
  },
);

export const WsFilesystemSubscribeFileChangesRpc = Rpc.make(
  SCIENT_FILE_OPENING_WS_METHODS.filesystemSubscribeFileChanges,
  {
    payload: EnvironmentFilePrepareInput,
    success: EnvironmentFileChangeEvent,
    error: Schema.Union([EnvironmentFilePrepareError, EnvironmentAuthorizationError]),
    stream: true,
  },
);
