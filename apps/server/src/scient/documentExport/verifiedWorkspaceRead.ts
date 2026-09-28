// @effect-diagnostics nodeBuiltinImport:off -- Workspace reads use an open fd with a hard byte cap.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/**
 * Reads of project files that must come from the file a path check saw.
 *
 * A path check (real path inside the project, a regular file) and a later
 * read by the same path can see different files: a concurrent writer can
 * swap the file, or a folder above it, for a link out of the project in
 * between. These reads open the checked path so that no link is followed
 * (macOS) or confirm through the open descriptor that it is inside the
 * project (Linux), then confirm that the open file is the one the check
 * recorded, and never hold more than the cap.
 */

/** What a path check established about one file, for the handle-bound read to confirm. */
export interface CheckedFile {
  readonly canonicalPath: string;
  readonly size: number;
  readonly dev: number;
  readonly ino: number | null;
  readonly mtimeMs: number | null;
}

export const checkedFileIdentity = (
  canonicalPath: string,
  info: FileSystem.File.Info,
): CheckedFile => ({
  canonicalPath,
  size: Number(info.size),
  dev: info.dev,
  ino: Option.isSome(info.ino) ? info.ino.value : null,
  mtimeMs: Option.isSome(info.mtime) ? info.mtime.value.getTime() : null,
});

export type VerifiedRead =
  | { readonly _tag: "bytes"; readonly bytes: Uint8Array }
  | { readonly _tag: "too-large" }
  | { readonly _tag: "unsupported-platform" }
  | { readonly _tag: "unreadable" };

const isInsideNative = (root: string, candidate: string) => {
  if (!NodePath.isAbsolute(candidate)) return false;
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
};

// Darwin's O_NOFOLLOW_ANY applies to every path component, unlike O_NOFOLLOW.
// Node does not expose it as a named constant, but passes numeric open flags through.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

/**
 * Reads a checked workspace file from the same inode the check saw, holding
 * at most `maxBytes` plus one. The open refuses any symlink on the way
 * (macOS) or is confirmed inside the project through its descriptor (Linux);
 * other platforms cannot confirm that and read nothing.
 */
export const readVerifiedWorkspaceFile = (
  located: CheckedFile,
  canonicalRoot: string,
  platform: NodeJS.Platform,
  maxBytes: number,
) =>
  Effect.tryPromise({
    try: async (): Promise<VerifiedRead> => {
      // Node exposes no path-independent containment check for an opened file
      // on other platforms. Read nothing rather than trust raceable rechecks.
      if (platform !== "darwin" && platform !== "linux") {
        return { _tag: "unsupported-platform" };
      }
      const handle = await NodeFS.promises.open(
        located.canonicalPath,
        NodeFS.constants.O_RDONLY |
          (platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : (NodeFS.constants.O_NOFOLLOW ?? 0)),
      );
      try {
        if (platform === "linux") {
          // /proc resolves this particular open fd, not a pathname the attacker can toggle.
          const openedPath = await NodeFS.promises.readlink(`/proc/self/fd/${handle.fd}`);
          if (openedPath.endsWith(" (deleted)") || !isInsideNative(canonicalRoot, openedPath))
            return { _tag: "unreadable" };
        }
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.dev !== located.dev ||
          (located.ino !== null && before.ino !== located.ino) ||
          before.size !== located.size ||
          (located.mtimeMs !== null && Math.trunc(before.mtimeMs) !== located.mtimeMs)
        )
          return { _tag: "unreadable" };
        const buffer = Buffer.allocUnsafe(Math.min(before.size, maxBytes) + 1);
        let length = 0;
        while (length < buffer.byteLength) {
          const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > maxBytes) return { _tag: "too-large" };
        const after = await handle.stat();
        const current = await NodeFS.promises.lstat(located.canonicalPath);
        if (
          !current.isFile() ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs ||
          current.ctimeMs !== before.ctimeMs ||
          length !== before.size
        )
          return { _tag: "unreadable" };
        return { _tag: "bytes", bytes: new Uint8Array(buffer.subarray(0, length)) };
      } finally {
        await handle.close();
      }
    },
    catch: () => ({ _tag: "unreadable" }) as VerifiedRead,
  }).pipe(Effect.orElseSucceed(() => ({ _tag: "unreadable" }) as const));

/**
 * Reads at most `maxBytes` plus one from a path, without binding the open file
 * to the project. Only for a caller that then requires the bytes to equal a
 * revision the user already has (the editor's saved file): a file swapped in
 * by path between the check and the read then either has those same bytes,
 * so the export shows nothing the user did not already have, or other bytes
 * and is refused. What remains is the open itself, so it cannot hang or reach
 * a device: it is non-blocking where the platform supports that, must be a
 * regular file, and must still look like the file the path check saw.
 */
export const readCappedFile = (checked: CheckedFile, maxBytes: number) =>
  Effect.tryPromise({
    try: async (): Promise<VerifiedRead> => {
      const handle = await NodeFS.promises.open(
        checked.canonicalPath,
        NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
      );
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.dev !== checked.dev ||
          (checked.ino !== null && info.ino !== checked.ino) ||
          info.size !== checked.size ||
          (checked.mtimeMs !== null && Math.trunc(info.mtimeMs) !== checked.mtimeMs)
        )
          return { _tag: "unreadable" };
        const buffer = Buffer.allocUnsafe(Math.min(info.size, maxBytes) + 1);
        let length = 0;
        while (length < buffer.byteLength) {
          const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > maxBytes) return { _tag: "too-large" };
        return { _tag: "bytes", bytes: new Uint8Array(buffer.subarray(0, length)) };
      } finally {
        await handle.close();
      }
    },
    catch: () => ({ _tag: "unreadable" }) as VerifiedRead,
  }).pipe(Effect.orElseSucceed(() => ({ _tag: "unreadable" }) as const));
