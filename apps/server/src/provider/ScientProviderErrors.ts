import * as Schema from "effect/Schema";

import type { CheckpointServiceError } from "../checkpointing/Errors.ts";
import type { ProviderInstanceNotFoundError, ProviderWorkspaceMissingError } from "./Errors.ts";

// Two v1 provider error families that upstream retired along with the v1
// provider service layer, restored here for the fork modules that construct
// them.
//
// (1) The user-input attachment checks and ProviderSessionDirectory report
// validation and persistence failures through ProviderValidationError and
// ProviderSessionDirectoryPersistenceError.
//
// (2) The v1 provider service and the ACP adapter-error mapper raise
// ProviderAdapterRequestError and ProviderAdapterProcessError, the two members
// of the `ProviderAdapterError` union.
/**
 * ProviderValidationError - Invalid provider API input.
 */
export class ProviderValidationError extends Schema.TaggedError<ProviderValidationError>()(
  "ProviderValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderSessionDirectoryPersistenceError - Session directory persistence failure.
 */
export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedError<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider session directory persistence error in ${this.operation}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterRequestError - Provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends Schema.TaggedError<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterProcessError - Provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends Schema.TaggedError<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

export type ProviderAdapterError = ProviderAdapterRequestError | ProviderAdapterProcessError;

/**
 * SCIENT-FORK: the v1 provider service facade returns this union from every
 * session/turn operation, including `rollbackConversation` failures that
 * surface checkpointing errors.
 */
export type ProviderServiceError =
  | ProviderValidationError
  | ProviderWorkspaceMissingError
  | ProviderInstanceNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderAdapterError
  | CheckpointServiceError;
