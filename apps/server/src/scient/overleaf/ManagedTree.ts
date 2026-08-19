// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ScientOverleafWarning } from "@t3tools/contracts";
import { ScientOverleafOperationError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { TreeFile, TreeManifest } from "./model.ts";
import { OverleafGitExecutor } from "./OverleafGitExecutor.ts";
import { OverleafStateStore } from "./OverleafStateStore.ts";

const EDITABLE_TEXT_BYTES = 2 * 1024 * 1024;
const EDITABLE_MATERIAL_BYTES = 7 * 1024 * 1024;
const LARGE_FILE_BYTES = 50 * 1024 * 1024;
const PROJECT_BYTES = 100 * 1024 * 1024;
const PROJECT_FILES = 2_000;
const EDITABLE_EXTENSIONS = new Set([".tex", ".bib", ".cls", ".sty", ".bst", ".txt", ".md"]);
const MATERIAL_EXTENSIONS = new Set([...EDITABLE_EXTENSIONS, ".svg", ".eps", ".pdf"]);

function unsafe(message: string): ScientOverleafOperationError {
  return new ScientOverleafOperationError({ code: "unsafe_tree", message, retryable: false });
}
const isOverleafOperationError = Schema.is(ScientOverleafOperationError);
const hasControlCharacter = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) <= 0x1f);

export function normalizeManagedPath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//u, "");
  const parts = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > 4_096 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    parts.some((part) => part.length === 0 || part === "." || part === ".." || part === ".git")
  ) {
    throw unsafe("The project contains a path the app cannot synchronize safely.");
  }
  for (const part of parts) {
    if (/^ |[ .]$/u.test(part) || /[<>:"|?*]/u.test(part) || hasControlCharacter(part)) {
      throw unsafe("The project contains a path that is invalid on a supported platform.");
    }
    const stem = part.split(".")[0]!.toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) {
      throw unsafe("The project contains a Windows-reserved path.");
    }
  }
  return normalized;
}

async function hashFile(
  filePath: string,
  containmentRoot?: string,
  windows = false,
): Promise<{ hash: string; size: number }> {
  const before = await NodeFSP.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink())
    throw unsafe("A managed project path is no longer a regular file.");
  if (containmentRoot !== undefined) {
    const [canonicalRoot, canonicalFile] = await Promise.all([
      NodeFSP.realpath(containmentRoot),
      NodeFSP.realpath(filePath),
    ]);
    const relative = NodePath.relative(canonicalRoot, canonicalFile);
    if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative))
      throw unsafe("A managed project path escapes the selected folder.");
  }
  const flags = NodeFS.constants.O_RDONLY | (windows ? 0 : NodeFS.constants.O_NOFOLLOW);
  const handle = await NodeFSP.open(filePath, flags);
  try {
    const opened = await handle.stat();
    const afterOpen = await NodeFSP.lstat(filePath);
    if (
      !opened.isFile() ||
      afterOpen.isSymbolicLink() ||
      opened.dev !== afterOpen.dev ||
      opened.ino !== afterOpen.ino
    )
      throw unsafe("A managed project file changed identity while it was opened.");
    const hash = NodeCrypto.createHash("sha256");
    let size = 0;
    const buffer = Buffer.allocUnsafe(256 * 1024);
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      size += result.bytesRead;
    }
    const afterRead = await handle.stat();
    const afterPath = await NodeFSP.lstat(filePath);
    if (
      afterRead.dev !== afterPath.dev ||
      afterRead.ino !== afterPath.ino ||
      afterRead.size !== size ||
      afterRead.size !== before.size ||
      afterRead.mtimeMs !== opened.mtimeMs
    )
      throw unsafe("A managed project file changed while it was being read.");
    return { hash: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
}

export function advisoryWarnings(manifest: TreeManifest): ReadonlyArray<ScientOverleafWarning> {
  const warnings: ScientOverleafWarning[] = [];
  if (manifest.files.length > PROJECT_FILES)
    warnings.push({
      kind: "file_count",
      message: `This candidate contains ${manifest.files.length.toLocaleString()} files.`,
      paths: [],
      blocking: true,
      suppressible: false,
    });
  const largeFiles = manifest.files
    .filter((file) => file.size > LARGE_FILE_BYTES)
    .map((file) => file.path);
  if (largeFiles.length > 0)
    warnings.push({
      kind: "large_file",
      message: "Some files exceed 50 MB.",
      paths: largeFiles,
      blocking: true,
      suppressible: false,
    });
  const largeText = manifest.files
    .filter(
      (file) =>
        EDITABLE_EXTENSIONS.has(NodePath.extname(file.path).toLowerCase()) &&
        file.size > EDITABLE_TEXT_BYTES,
    )
    .map((file) => file.path);
  if (largeText.length > 0)
    warnings.push({
      kind: "large_editable_text",
      message: "Some editable text files exceed 2 MB.",
      paths: largeText,
      blocking: true,
      suppressible: false,
    });
  const largeMaterial = manifest.files
    .filter(
      (file) =>
        MATERIAL_EXTENSIONS.has(NodePath.extname(file.path).toLowerCase()) &&
        file.size > EDITABLE_MATERIAL_BYTES,
    )
    .map((file) => file.path);
  if (largeMaterial.length > 0)
    warnings.push({
      kind: "large_editable_material",
      message: "Some editable project material exceeds 7 MB.",
      paths: largeMaterial,
      blocking: true,
      suppressible: false,
    });
  if (manifest.totalBytes > PROJECT_BYTES)
    warnings.push({
      kind: "project_size",
      message: "This project exceeds the recommended 100 MB Git-integration size.",
      paths: [],
      blocking: true,
      suppressible: false,
    });
  return warnings;
}

export class ManagedTree extends Context.Service<
  ManagedTree,
  {
    readonly scan: (input: {
      readonly operationId: string;
      readonly root: string;
      readonly trackedPaths?: ReadonlyArray<string>;
      readonly excludedPaths?: ReadonlyArray<string>;
    }) => Effect.Effect<TreeManifest, ScientOverleafOperationError>;
    readonly hashFile: (
      path: string,
    ) => Effect.Effect<{ hash: string; size: number }, ScientOverleafOperationError>;
  }
>()("t3/scient/overleaf/ManagedTree") {}

export const make = Effect.fn("ManagedTree.make")(function* () {
  const git = yield* OverleafGitExecutor;
  const state = yield* OverleafStateStore;
  const platform = yield* HostProcessPlatform;
  const windows = platform === "win32";
  const hashFileEffect = (filePath: string) =>
    Effect.tryPromise({
      try: () => hashFile(filePath, undefined, windows),
      catch: () =>
        new ScientOverleafOperationError({
          code: "filesystem_failed",
          message: "Unable to read a project file.",
          retryable: true,
        }),
    });

  const scan: ManagedTree["Service"]["scan"] = Effect.fnUntraced(function* (input) {
    const absoluteRoot = NodePath.resolve(input.root);
    const rootInfo = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(absoluteRoot),
      catch: () => unsafe("The selected project folder is unavailable."),
    });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      return yield* unsafe("The selected project folder must be a real directory.");
    const ignoreRepository = NodePath.join(
      state.operationDirectory(input.operationId),
      "ignore-index.git",
    );
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(NodePath.dirname(ignoreRepository), { recursive: true }),
      catch: () => unsafe("Unable to prepare project scanning."),
    });
    yield* git
      .execute({
        operationId: input.operationId,
        cwd: absoluteRoot,
        args: ["init", "--bare", ignoreRepository],
      })
      .pipe(
        Effect.mapError(
          () =>
            new ScientOverleafOperationError({
              code: "filesystem_failed",
              message: "Unable to prepare Git ignore evaluation.",
              retryable: true,
            }),
        ),
      );
    const listed = yield* git
      .execute({
        operationId: input.operationId,
        cwd: absoluteRoot,
        args: [
          `--git-dir=${ignoreRepository}`,
          `--work-tree=${absoluteRoot}`,
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ],
        maxOutputBytes: 32 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError(
          () =>
            new ScientOverleafOperationError({
              code: "filesystem_failed",
              message: "Unable to evaluate the project .gitignore.",
              retryable: true,
            }),
        ),
      );
    const included = new Set(listed.stdout.split("\0").filter(Boolean).map(normalizeManagedPath));
    for (const tracked of input.trackedPaths ?? []) included.add(normalizeManagedPath(tracked));
    for (const excluded of input.excludedPaths ?? [])
      included.delete(normalizeManagedPath(excluded));

    for (const attributesPath of [...included].filter(
      (relative) => NodePath.posix.basename(relative) === ".gitattributes",
    )) {
      const attributes = yield* Effect.tryPromise({
        try: async () => {
          const absolute = NodePath.join(absoluteRoot, ...attributesPath.split("/"));
          const info = await NodeFSP.lstat(absolute);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
            throw unsafe("A .gitattributes file cannot be inspected safely.");
          return await NodeFSP.readFile(absolute, "utf8");
        },
        catch: (cause) =>
          isOverleafOperationError(cause)
            ? cause
            : unsafe("A .gitattributes file cannot be inspected safely."),
      });
      if (/(?:^|\s)filter=lfs(?:\s|$)/mu.test(attributes))
        return yield* new ScientOverleafOperationError({
          code: "unsupported_tree",
          message: "Git LFS paths are not supported by Overleaf sync.",
          retryable: false,
        });
    }

    const caseFolded = new Map<string, string>();
    const files: TreeFile[] = [];
    for (const relative of [...included].toSorted()) {
      const folded = relative.toLocaleLowerCase("en-US");
      const previous = caseFolded.get(folded);
      if (previous !== undefined && previous !== relative)
        return yield* unsafe("The project contains paths that collide by letter case.");
      caseFolded.set(folded, relative);
      const absolute = NodePath.resolve(absoluteRoot, ...relative.split("/"));
      if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${NodePath.sep}`))
        return yield* unsafe("A project path escapes the selected folder.");
      const info = yield* Effect.tryPromise({
        try: async () => {
          try {
            let current = absoluteRoot;
            const parts = relative.split("/");
            for (let index = 0; index < parts.length; index += 1) {
              current = NodePath.join(current, parts[index]!);
              const entry = await NodeFSP.lstat(current);
              if (entry.isSymbolicLink())
                throw unsafe("Managed paths cannot traverse symlinks or junctions.");
              if (index < parts.length - 1 && !entry.isDirectory())
                throw unsafe("A managed project path has an unsafe file/directory collision.");
              if (index === parts.length - 1) return entry;
            }
            return null;
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw cause;
          }
        },
        catch: () => unsafe("A project file could not be inspected."),
      });
      if (info === null) continue;
      if (info.isSymbolicLink())
        return yield* unsafe("Symlinks and junctions are not supported by Overleaf sync.");
      if (!info.isFile()) continue;
      const hashed = yield* Effect.tryPromise({
        try: () => hashFile(absolute, absoluteRoot, windows),
        catch: (cause) =>
          isOverleafOperationError(cause)
            ? cause
            : new ScientOverleafOperationError({
                code: "filesystem_failed",
                message: "Unable to read a managed project file safely.",
                retryable: true,
              }),
      });
      files.push({ path: relative, hash: hashed.hash, size: hashed.size, executable: false });
    }
    return { files, totalBytes: files.reduce((total, file) => total + file.size, 0) };
  });

  return ManagedTree.of({ scan, hashFile: hashFileEffect });
});

export const layer = Layer.effect(ManagedTree, make());
