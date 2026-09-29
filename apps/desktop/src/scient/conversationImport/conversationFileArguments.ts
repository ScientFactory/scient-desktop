// @effect-diagnostics nodeBuiltinImport:off -- OS launch arguments need explicit win32/posix semantics, also in cross-platform tests.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** OS open requests are paths, or local file URLs on URI-based desktops. Never fetch a URL. */
export function conversationFilePathsFromArgv(
  argv: ReadonlyArray<string>,
  cwd: string,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const result = new Set<string>();
  for (const argument of argv.slice(1)) {
    if (argument.startsWith("-")) continue;
    let path = argument;
    if (/^file:/iu.test(argument)) {
      try {
        const url = new URL(argument);
        // Network shares are not local previews and may send ambient credentials.
        if ((url.hostname && url.hostname !== "localhost") || url.search || url.hash) continue;
        path = NodeURL.fileURLToPath(url, { windows: platform === "win32" });
      } catch {
        continue;
      }
    } else if (/^[a-z][a-z\d+.-]*:/iu.test(argument) && !/^[a-z]:[\\/]/iu.test(argument)) {
      continue;
    }
    if (!path.toLowerCase().endsWith(".scic") || path.includes("\0")) continue;
    if (path.startsWith("\\\\") || path.startsWith("//")) continue;
    result.add(paths.resolve(cwd, path));
  }
  return [...result];
}
