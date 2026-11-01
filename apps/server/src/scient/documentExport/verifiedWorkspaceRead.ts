// @effect-diagnostics nodeBuiltinImport:off -- Workspace reads use an open fd with a hard byte cap.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/**
 * Checks and later pathname reads can see different files after ancestor/link swaps. Bind reads to
 * the checked descriptor/inode, enforce no-follow/descriptor containment per platform, and bound
 * bytes.
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
  dev: Number(info.dev),
  ino: Option.isSome(info.ino) ? Number(info.ino.value) : null,
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
 * Read only the checked regular inode, bounded to maxBytes plus one without waiting on
 * devices/FIFOs. Require no-follow ancestry on macOS or descriptor containment on Linux; unverified
 * platforms read nothing.
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
      // Non-blocking, so a FIFO or device swapped in cannot hold the open; the
      // descriptor's stat below refuses anything that is not a regular file.
      const handle = await NodeFS.promises.open(
        located.canonicalPath,
        NodeFS.constants.O_RDONLY |
          (NodeFS.constants.O_NONBLOCK ?? 0) |
          (platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : (NodeFS.constants.O_NOFOLLOW ?? 0)),
      );
      try {
        if (platform === "linux") {
          // /proc resolves this particular open fd, not a pathname the attacker can toggle.
          const openedPath = await NodeFS.promises.readlink(`/proc/self/fd/${handle.fd}`);
          if (openedPath.endsWith(" (deleted)") || !isInsideNative(canonicalRoot, openedPath))
            return { _tag: "unreadable" };
        }
        // Match Effect's bigint stat: numeric mtimeMs can round into the next millisecond.
        const before = await handle.stat({ bigint: true });
        if (
          !before.isFile() ||
          Number(before.dev) !== located.dev ||
          (located.ino !== null && Number(before.ino) !== located.ino) ||
          Number(before.size) !== located.size ||
          (located.mtimeMs !== null && Number(before.mtimeMs) !== located.mtimeMs)
        )
          return { _tag: "unreadable" };
        const buffer = Buffer.allocUnsafe(Math.min(Number(before.size), maxBytes) + 1);
        let length = 0;
        while (length < buffer.byteLength) {
          const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > maxBytes) return { _tag: "too-large" };
        const after = await handle.stat({ bigint: true });
        const current = await NodeFS.promises.lstat(located.canonicalPath, { bigint: true });
        if (
          !current.isFile() ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs ||
          current.size !== before.size ||
          current.mtimeNs !== before.mtimeNs ||
          current.ctimeNs !== before.ctimeNs ||
          BigInt(length) !== before.size
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
 * Unbound path reads are allowed only against a revision the user already has, accepting identical
 * bytes or refusing mismatches. Still require a nonblocking regular file matching the path check so
 * opening cannot reach a device or hang.
 */
export const readCappedFile = (checked: CheckedFile, maxBytes: number) =>
  Effect.tryPromise({
    try: async (): Promise<VerifiedRead> => {
      const handle = await NodeFS.promises.open(
        checked.canonicalPath,
        NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
      );
      try {
        const info = await handle.stat({ bigint: true });
        if (
          !info.isFile() ||
          Number(info.dev) !== checked.dev ||
          (checked.ino !== null && Number(info.ino) !== checked.ino) ||
          Number(info.size) !== checked.size ||
          (checked.mtimeMs !== null && Number(info.mtimeMs) !== checked.mtimeMs)
        )
          return { _tag: "unreadable" };
        const buffer = Buffer.allocUnsafe(Math.min(Number(info.size), maxBytes) + 1);
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
