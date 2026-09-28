// @effect-diagnostics nodeBuiltinImport:off -- Bounded reads use an open file handle so growth cannot allocate unbounded memory.
import * as NodeFS from "node:fs";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  checkedFileIdentity,
  readVerifiedWorkspaceFile,
} from "../documentExport/verifiedWorkspaceRead.ts";

export const WORD_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const WORD_IMAGE_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_REFERENCES = 256;

export type CapturedWorkspaceImage =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly png: Uint8Array | null }
  | {
      readonly ok: false;
      readonly refusal:
        | "missing"
        | "outside-allowlist"
        | "symlink-outside-allowlist"
        | "not-a-file"
        | "too-large"
        | "budget-exceeded"
        | "changed-during-capture";
    };

export class WordImageSnapshotError extends Schema.TaggedError<WordImageSnapshotError>()(
  "WordImageSnapshotError",
  {
    reason: Schema.Literals(["too-many-images", "unverifiable-platform"]),
    message: Schema.String,
  },
) {}

const inside = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/**
 * Reads an image by path on a platform where the open file cannot be bound to
 * the project, then confirms the path still names the file it read.
 */
const readImageByPath = (real: string, lexical: string) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await NodeFS.promises.open(
        real,
        NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const before = await handle.stat();
        if (!before.isFile()) return { ok: false, refusal: "not-a-file" } as const;
        if (before.size > WORD_IMAGE_MAX_BYTES) return { ok: false, refusal: "too-large" } as const;
        const bytes = Buffer.allocUnsafe(before.size + 1);
        let length = 0;
        while (length < bytes.byteLength) {
          const result = await handle.read(bytes, length, bytes.byteLength - length, null);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        const after = await handle.stat();
        const currentReal = await NodeFS.promises.realpath(lexical);
        const current = await NodeFS.promises.stat(lexical);
        if (
          length > WORD_IMAGE_MAX_BYTES ||
          before.size !== length ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          currentReal !== real ||
          current.dev !== before.dev ||
          current.ino !== before.ino
        ) {
          return { ok: false, refusal: "changed-during-capture" } as const;
        }
        return { ok: true, bytes: new Uint8Array(bytes.subarray(0, length)) } as const;
      } finally {
        await handle.close();
      }
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => ({ ok: false, refusal: "changed-during-capture" }) as const));

/**
 * The converter receives this map and never opens a workspace image itself.
 * Each image is read through a handle bound to the file its path check saw
 * (`verifiedWorkspaceRead.ts`). Where that is not possible (Windows), a
 * caller that sets `requireVerifiedReads` is refused; otherwise the image is
 * read by path and rechecked.
 */
export const captureWordImages = Effect.fn("scient.pandoc.captureWordImages")(function* (
  references: ReadonlyArray<string>,
  files: {
    readonly baseDirectory: string;
    readonly allowRoots: ReadonlyArray<string>;
    readonly requireVerifiedReads?: boolean | undefined;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const roots = yield* Effect.forEach(files.allowRoots, (root) =>
    fs.realPath(root).pipe(
      Effect.map((real) => ({ lexical: path.resolve(root), real })),
      Effect.orElseSucceed(() => null),
    ),
  );
  let totalBytes = 0;
  const captured = new Map<string, CapturedWorkspaceImage>();

  const read = (candidate: string) =>
    Effect.gen(function* () {
      const lexical = path.resolve(candidate);
      if (!roots.some((root) => root !== null && inside(path, root.lexical, lexical))) {
        return { ok: false, refusal: "outside-allowlist" } as const;
      }
      const real = yield* fs.realPath(lexical).pipe(Effect.orElseSucceed(() => null));
      if (real === null) return { ok: false, refusal: "missing" } as const;
      const realRoot = roots.find((root) => root !== null && inside(path, root.real, real));
      if (realRoot === undefined || realRoot === null) {
        return { ok: false, refusal: "symlink-outside-allowlist" } as const;
      }
      const info = yield* fs.stat(real).pipe(Effect.orElseSucceed(() => null));
      if (info === null) return { ok: false, refusal: "missing" } as const;
      if (info.type !== "File") return { ok: false, refusal: "not-a-file" } as const;
      if (Number(info.size) > WORD_IMAGE_MAX_BYTES) {
        return { ok: false, refusal: "too-large" } as const;
      }
      const verified = yield* readVerifiedWorkspaceFile(
        checkedFileIdentity(real, info),
        realRoot.real,
        platform,
        WORD_IMAGE_MAX_BYTES,
      );
      switch (verified._tag) {
        case "bytes":
          return { ok: true, bytes: verified.bytes } as const;
        case "too-large":
          return { ok: false, refusal: "too-large" } as const;
        case "unreadable":
          return { ok: false, refusal: "changed-during-capture" } as const;
        case "unsupported-platform":
          if (files.requireVerifiedReads === true) {
            return yield* new WordImageSnapshotError({
              reason: "unverifiable-platform",
              message: "This platform cannot confirm which image files were read.",
            });
          }
          return yield* readImageByPath(real, lexical);
      }
    });

  for (const url of references) {
    if (captured.has(url)) continue;
    if (/^(?:data:|[a-z][a-z\d+.-]*:)/iu.test(url) && !/^[a-z]:[\\/]/iu.test(url)) continue;
    let relative: string;
    try {
      relative = decodeURIComponent(url).replaceAll("\\", "/");
    } catch {
      continue;
    }
    if (
      !relative ||
      relative.includes("\0") ||
      relative.startsWith("/") ||
      /^[a-z]:\//iu.test(relative) ||
      path.isAbsolute(relative)
    )
      continue;
    if (captured.size >= MAX_IMAGE_REFERENCES) {
      return yield* new WordImageSnapshotError({
        reason: "too-many-images",
        message: "This document names too many images for one Word export.",
      });
    }
    const candidate = path.join(files.baseDirectory, relative);
    const image = yield* read(candidate);
    if (!image.ok) {
      captured.set(url, image);
      continue;
    }
    if (totalBytes + image.bytes.byteLength > WORD_IMAGE_TOTAL_BYTES) {
      captured.set(url, { ok: false, refusal: "budget-exceeded" });
      continue;
    }
    totalBytes += image.bytes.byteLength;
    let png: Uint8Array | null = null;
    if (/\.svg$/iu.test(candidate)) {
      const sibling = yield* read(candidate.replace(/\.svg$/iu, ".png"));
      if (sibling.ok && totalBytes + sibling.bytes.byteLength <= WORD_IMAGE_TOTAL_BYTES) {
        png = sibling.bytes;
        totalBytes += png.byteLength;
      }
    }
    captured.set(url, { ok: true, bytes: image.bytes, png });
  }
  return captured;
});
