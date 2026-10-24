import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * The server asks every open window of its environment to save the editors
 * of one folder, and waits for each window's answer. Windows connect once
 * (a stream of requests) and answer each request separately.
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

/** One window's answer: the editors it saved, and every one it could not. */
export const EditorFlushResponse = Schema.Struct({
  clientId: EditorFlushWindow.fields.clientId,
  connectionId: ConnectionId,
  requestId: EditorFlushRequest.fields.requestId,
  saved: Schema.Array(FilePath).check(Schema.isMaxLength(MAX_FILES)),
  failures: Schema.Array(EditorFlushFileFailure).check(Schema.isMaxLength(MAX_FILES)),
});
export type EditorFlushResponse = typeof EditorFlushResponse.Type;
