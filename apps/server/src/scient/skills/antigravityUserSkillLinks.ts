/**
 * Keeps the managed ACP runtime's links to the user's `~/.gemini` skill
 * directories safe to start with.
 *
 * On `session/new` the agent creates `config/skills` and
 * `antigravity-cli/skills` under its `GEMINI_HOME`. A link there whose target
 * does not exist makes that `mkdir` fail, and the agent then rejects every
 * session with JSON-RPC -32603. Most users have no `~/.gemini`, so a link is
 * made only to a directory that exists, and a dangling one is removed so the
 * agent can create its own. This runs on every launch: the user may install
 * Gemini skills later.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * Whether the upstream linker should skip `link` because `target` is not a
 * directory. When it is not, a dangling link (symlink or Windows junction) at
 * `link` is removed. A real directory, or a link that still resolves, is never
 * touched.
 */
export const skipMissingAntigravitySkillTarget = Effect.fn("skipMissingAntigravitySkillTarget")(
  function* (input: {
    readonly link: string;
    readonly target: string;
  }): Effect.fn.Return<boolean, never, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const targetIsDirectory = yield* fs.stat(input.target).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (targetIsDirectory) return false;
    const isLink = yield* fs.readLink(input.link).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!isLink) return true;
    // `stat` follows the link, so only a link whose target is gone reports NotFound.
    const dangling = yield* fs.stat(input.link).pipe(
      Effect.as(false),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
      Effect.orElseSucceed(() => false),
    );
    if (dangling) {
      yield* fs
        .remove(input.link)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("A dangling Antigravity skill link could not be removed.", { error }),
          ),
        );
    }
    return true;
  },
);
