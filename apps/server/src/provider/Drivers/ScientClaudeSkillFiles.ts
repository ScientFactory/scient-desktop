/**
 * Bounded, read-only discovery of native Claude skill files through the Effect file system, so
 * discovery stays interruptible and follows the file system the caller provides.
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_DEPTH = 8;
const MAX_DIRECTORIES = 2000;

/** A skill file's text, or undefined when it is missing, not a file or over 256 KB. */
export const readClaudeSkillText = Effect.fn("readClaudeSkillText")(function* (
  fileSystem: FileSystem.FileSystem,
  file: string,
) {
  const info = yield* fileSystem.stat(file).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return undefined;
  if (Number(info.value.size) > MAX_SKILL_BYTES) return undefined;
  return yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * Skill folders under `root`, nested like Claude's own loader, as paths relative to `root`.
 * Symlinks are followed only while they stay inside `root`.
 */
export const claudeSkillEntries = Effect.fn("claudeSkillEntries")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  // The root is listed first, exactly as Claude's loader does; a missing root lists nothing.
  let realRoot: string | undefined;
  const inside = (real: string) => {
    const relative = path.relative(realRoot!, real);
    return !(
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  };
  const result: string[] = [];
  const pending = [{ directory: root, relative: "", depth: 0 }];
  const visited = new Set<string>();
  let steps = 0;
  while (pending.length > 0 && visited.size < MAX_DIRECTORIES && steps++ < MAX_DIRECTORIES * 4) {
    const current = pending.shift()!;
    if (current.depth > 0) {
      if (realRoot === undefined) {
        const resolved = yield* fileSystem.realPath(root).pipe(Effect.option);
        if (Option.isNone(resolved)) return result;
        realRoot = resolved.value;
      }
      const real = yield* fileSystem.realPath(current.directory).pipe(Effect.option);
      if (Option.isNone(real) || visited.has(real.value) || !inside(real.value)) continue;
      visited.add(real.value);
      if (
        (yield* readClaudeSkillText(fileSystem, path.join(current.directory, "SKILL.md"))) !==
        undefined
      ) {
        result.push(current.relative);
        continue;
      }
    }
    if (current.depth >= MAX_DEPTH) continue;
    const names = yield* fileSystem
      .readDirectory(current.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of [...names].sort()) {
      if (name.startsWith(".")) continue;
      const child = path.join(current.directory, name);
      const info = yield* fileSystem.stat(child).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") continue;
      pending.push({
        directory: child,
        relative: current.relative ? path.join(current.relative, name) : name,
        depth: current.depth + 1,
      });
    }
  }
  return result;
});
