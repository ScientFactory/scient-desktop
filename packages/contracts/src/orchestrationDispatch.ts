import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ForkDisposition = Schema.Literals([
  "unknown",
  "rejected",
  "pending",
  "provisioning",
  "failed",
  "abandoned",
  "ready",
]);
export type ForkDisposition = typeof ForkDisposition.Type;

/**
 * A command dispatch failure. `bootstrapThreadDisposition` tells a client whether the
 * thread a bootstrap turn would have created was removed or never created.
 */
export class OrchestrationDispatchCommandError extends Schema.TaggedError<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
    bootstrapThreadDisposition: Schema.optional(Schema.Literals(["deleted", "not-created"])),
    forkDisposition: Schema.optional(ForkDisposition),
  },
) {}
