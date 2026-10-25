import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * Every window answers separately, with file membership resolved by server physical identity so
 * alternate path spellings cannot miss unsaved editors.
 */
export const EditorFlushWindow = Schema.Struct({
  clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type EditorFlushWindow = typeof EditorFlushWindow.Type;

const ConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const MAX_FILES = 4_096;
const FilePath = Schema.String.check(Schema.isMaxLength(4_096));

export const EditorFlushRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** Absolute path of the checkout, as the server knows it. */
  checkoutRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  /** Relative to `checkoutRoot` with "/" separators; "" is the whole checkout. */
  folder: FilePath,
});
export type EditorFlushRequest = typeof EditorFlushRequest.Type;

export const EditorFlushStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: ConnectionId }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: ConnectionId,
    request: EditorFlushRequest,
  }),
]);
export type EditorFlushStreamEvent = typeof EditorFlushStreamEvent.Type;

/**
 * Why an editor's text is still not on disk: input a visual editor could not
 * turn into source, an input method still composing, a save that failed, or a
 * file that changed outside the editor while it held unsaved text.
 */
export const EditorFlushFailureReason = Schema.Literals([
  "unconverted-input",
  "composing",
  "save-failed",
  "conflict",
]);
export type EditorFlushFailureReason = typeof EditorFlushFailureReason.Type;

export const EditorFlushFileFailure = Schema.Struct({
  /** Relative to the request's `checkoutRoot`, with "/" separators. */
  path: FilePath,
  reason: EditorFlushFailureReason,
  message: Schema.String.check(Schema.isMaxLength(2_000)),
});
export type EditorFlushFileFailure = typeof EditorFlushFileFailure.Type;

/** The files of a window's editors, as the window names them. */
export const EditorFlushResolveInput = Schema.Struct({
  clientId: EditorFlushWindow.fields.clientId,
  /** The connection the request arrived on; a replaced connection's calls are refused. */
  connectionId: ConnectionId,
  requestId: EditorFlushRequest.fields.requestId,
  files: Schema.Array(
    Schema.Struct({
      cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
      relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
    }),
  ).check(Schema.isMaxLength(MAX_FILES)),
});
export type EditorFlushResolveInput = typeof EditorFlushResolveInput.Type;

/**
 * Where each file is, in the order asked: inside the folder (with its path
 * relative to the checkout), outside it, or unknown when the server could not
 * tell. A window treats an unknown file holding unsaved text as a failure.
 */
export const EditorFlushFileLocation = Schema.Union([
  Schema.Struct({ status: Schema.Literal("inside"), path: FilePath }),
  Schema.Struct({ status: Schema.Literal("outside") }),
  Schema.Struct({ status: Schema.Literal("unknown") }),
]);
export type EditorFlushFileLocation = typeof EditorFlushFileLocation.Type;

export const EditorFlushResolveResult = Schema.Struct({
  files: Schema.Array(EditorFlushFileLocation).check(Schema.isMaxLength(MAX_FILES)),
});
export type EditorFlushResolveResult = typeof EditorFlushResolveResult.Type;

/** One window's answer: the editors it saved, and every one it could not. */
export const EditorFlushResponse = Schema.Struct({
  clientId: EditorFlushWindow.fields.clientId,
  /** The connection the request arrived on; a replaced connection's calls are refused. */
  connectionId: ConnectionId,
  requestId: EditorFlushRequest.fields.requestId,
  saved: Schema.Array(FilePath).check(Schema.isMaxLength(MAX_FILES)),
  failures: Schema.Array(EditorFlushFileFailure).check(Schema.isMaxLength(MAX_FILES)),
});
export type EditorFlushResponse = typeof EditorFlushResponse.Type;

/** A window closing, on the connection it says goodbye for. */
export const EditorFlushLeave = Schema.Struct({
  clientId: EditorFlushWindow.fields.clientId,
  connectionId: ConnectionId,
});
export type EditorFlushLeave = typeof EditorFlushLeave.Type;
