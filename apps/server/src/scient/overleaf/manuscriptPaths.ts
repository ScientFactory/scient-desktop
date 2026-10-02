/**
 * Which paths a manuscript tree may contain, and which combinations of paths
 * form a tree at all. Applied to every tree before it is written, merged,
 * published, or applied to the folder, whichever side it came from.
 */

export type ManuscriptPathProblem =
  | "empty"
  | "too-long"
  | "absolute"
  | "traversal"
  | "reserved"
  | "invalid-on-a-supported-platform";

/** Names that never belong to a connection, wherever they appear in a path. */
const RESERVED_SEGMENTS = new Set([".git", ".scient"]);
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u;
const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

/** Why a path cannot be part of a manuscript, or `null` when it can. */
export function manuscriptPathProblem(path: string): ManuscriptPathProblem | null {
  if (path.length === 0) return "empty";
  if (path.length > 4_096) return "too-long";
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path)) return "absolute";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return "traversal";
    if (RESERVED_SEGMENTS.has(segment.toLowerCase())) return "reserved";
    if (
      /^ |[ .]$/u.test(segment) ||
      /[<>:"|?*]/u.test(segment) ||
      hasControlCharacter(segment) ||
      WINDOWS_DEVICE.test((segment.split(".")[0] ?? "").toUpperCase())
    ) {
      return "invalid-on-a-supported-platform";
    }
  }
  return null;
}

export type ManuscriptTreeProblem =
  | { readonly kind: "path"; readonly path: string; readonly problem: ManuscriptPathProblem }
  | { readonly kind: "duplicate"; readonly path: string }
  | { readonly kind: "file-and-folder"; readonly file: string; readonly inside: string }
  | { readonly kind: "case-collision"; readonly first: string; readonly second: string };

/**
 * A set of file paths is a tree only if no path is both a file and a folder
 * and no two paths differ only by letter case. Git's index plumbing drops an
 * entry silently in the first case, so this is checked before Git sees it.
 */
export function manuscriptTreeProblem(paths: ReadonlyArray<string>): ManuscriptTreeProblem | null {
  const files = new Set<string>();
  const folders = new Map<string, string>();
  const folded = new Map<string, string>();
  for (const path of paths) {
    const problem = manuscriptPathProblem(path);
    if (problem !== null) return { kind: "path", path, problem };
    if (files.has(path)) return { kind: "duplicate", path };
    files.add(path);
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      folders.set(segments.slice(0, depth).join("/"), path);
    }
  }
  for (const path of paths) {
    const inside = folders.get(path);
    if (inside !== undefined) return { kind: "file-and-folder", file: path, inside };
  }
  for (const name of [...files, ...folders.keys()]) {
    const key = name.toLocaleLowerCase("en-US");
    const earlier = folded.get(key);
    if (earlier !== undefined && earlier !== name) {
      return { kind: "case-collision", first: earlier, second: name };
    }
    folded.set(key, name);
  }
  return null;
}
