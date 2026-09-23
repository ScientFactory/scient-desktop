import * as Schema from "effect/Schema";

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

export type OmpRpcError = OmpRpcProtocolError | OmpRpcCommandError | OmpRpcProcessExitedError;
