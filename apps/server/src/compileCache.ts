import * as NodeModule from "node:module";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class CompileCacheFlushError extends Schema.TaggedError<CompileCacheFlushError>()(
  "CompileCacheFlushError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not flush the module compile cache.";
  }
}

// Windows force-kills on quit; persist the cache after startup.
export const flushCompileCache = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  yield* Effect.try({
    try: () => {
      // SCIENT-FORK:START — a Windows backend never exits normally, so a prepared one also
      // flushes the modules its prepared bytecode does not cover; accepted entries stay as they are.
      const prepared =
        platform !== "win32" && Reflect.get(globalThis, Symbol.for("t3code.preparedServerCache"));
      // SCIENT-FORK:END
      if (!prepared) {
        NodeModule.flushCompileCache();
      }
    },
    catch: (cause) => new CompileCacheFlushError({ cause }),
  });
}).pipe(Effect.ignore);
