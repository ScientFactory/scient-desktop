import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WacliInstallError extends Schema.TaggedError<WacliInstallError>()(
  "WacliInstallError",
  {
    reason: Schema.Literals(["unsupported-platform", "install-failed"]),
    /** A sentence a person can read; never a path or raw process output. */
    message: Schema.String,
  },
) {}

/**
 * The Scient-managed `wacli`: the pinned release for this platform, downloaded on first use,
 * verified by size and SHA-256, and never taken from PATH. See docs/internals/scient-whatsapp.md.
 */
export class WacliInstall extends Context.Service<
  WacliInstall,
  {
    /** Scient pins a build for this platform and architecture. */
    readonly supported: boolean;
    /** The verified executable, installing the pinned release first when it is missing or damaged. */
    readonly executable: Effect.Effect<string, WacliInstallError>;
  }
>()("t3/scient/whatsapp/WacliInstall") {}
