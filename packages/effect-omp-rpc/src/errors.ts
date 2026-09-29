import * as Schema from "effect/Schema";

/** A local protocol problem: an invalid frame this client could not encode or decode. */
export class OmpRpcProtocolError extends Schema.TaggedError<OmpRpcProtocolError>()(
  "OmpRpcProtocolError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * The agent broke the wire protocol (malformed frame, second ready frame,
 * mismatched response). The client is terminated; every waiter receives this
 * error so the caller can name the violation instead of a generic exit.
 */
export class OmpRpcProtocolViolationError extends Schema.TaggedError<OmpRpcProtocolViolationError>()(
  "OmpRpcProtocolViolationError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * One command failed. `code` is the agent's machine-readable reason, or
 * `"timeout"` when this client stopped waiting for the response. A command
 * failure never terminates the client.
 */
export class OmpRpcCommandError extends Schema.TaggedError<OmpRpcCommandError>()(
  "OmpRpcCommandError",
  {
    command: Schema.String,
    detail: Schema.String,
    requestId: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** An outbound frame is larger than the frame limit the agent advertised. Nothing was written. */
export class OmpRpcFrameTooLargeError extends Schema.TaggedError<OmpRpcFrameTooLargeError>()(
  "OmpRpcFrameTooLargeError",
  {
    frameType: Schema.String,
    frameBytes: Schema.Finite,
    limitBytes: Schema.Finite,
  },
) {
  override get message(): string {
    return `The ${this.frameType} frame is ${this.frameBytes} bytes, above the agent's ${this.limitBytes} byte frame limit.`;
  }
}

export class OmpRpcProcessExitedError extends Schema.TaggedError<OmpRpcProcessExitedError>()(
  "OmpRpcProcessExitedError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type OmpRpcError =
  | OmpRpcProtocolError
  | OmpRpcProtocolViolationError
  | OmpRpcCommandError
  | OmpRpcFrameTooLargeError
  | OmpRpcProcessExitedError;
