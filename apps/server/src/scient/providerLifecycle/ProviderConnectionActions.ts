import * as Data from "effect/Data";

export class ProviderConnectionActionError extends Data.TaggedError(
  "ProviderConnectionActionError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
