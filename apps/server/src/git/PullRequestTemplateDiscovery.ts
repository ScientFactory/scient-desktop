import { Effect } from "effect";

import { GitCore } from "./Services/GitCore.ts";

const TEMPLATE_MAX_BYTES = 8_000;
const TEMPLATE_DIRECTORY_MAX_CANDIDATES = 32;
const TREE_LIST_MAX_BYTES = 100_000;
const OBJECT_SIZE_MAX_BYTES = 128;
const EXACT_OBJECT_ENV = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
} as const;

const TEMPLATE_LOCATIONS = [".github", "", "docs"] as const;
const TEMPLATE_EXTENSIONS = ["md", "txt"] as const;

type PullRequestTemplateUnavailableReason =
  | "base-unavailable"
  | "tree-unavailable"
  | "template-unavailable"
  | "template-too-large"
  | "too-many-template-candidates"
  | "invalid-template-content";

export type PullRequestTemplateDiscoveryResult =
  | { readonly status: "not-found" }
  | { readonly status: "ambiguous"; readonly paths: ReadonlyArray<string> }
  | { readonly status: "unavailable"; readonly reason: PullRequestTemplateUnavailableReason }
  | {
      readonly status: "found";
      readonly path: string;
      readonly blobObjectId: string;
      readonly content: string;
    };

interface TemplateTreeEntry {
  readonly path: string;
  readonly blobObjectId: string;
}

type BlobReadResult =
  | { readonly status: "empty" }
  | { readonly status: "found"; readonly content: string }
  | {
      readonly status: "unavailable";
      readonly reason: Extract<
        PullRequestTemplateUnavailableReason,
        "template-unavailable" | "template-too-large" | "invalid-template-content"
      >;
    };

function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/iu.test(value);
}

function parseTemplateTree(stdout: string): ReadonlyArray<TemplateTreeEntry> {
  const entries: TemplateTreeEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const separatorIndex = record.indexOf("\t");
    if (separatorIndex < 0) continue;

    const [mode, type, blobObjectId] = record.slice(0, separatorIndex).split(" ");
    if (
      type !== "blob" ||
      (mode !== "100644" && mode !== "100755") ||
      !blobObjectId ||
      !isObjectId(blobObjectId)
    ) {
      continue;
    }

    entries.push({ path: record.slice(separatorIndex + 1), blobObjectId });
  }
  return entries;
}

function parseRootTemplateDirectories(stdout: string): ReadonlyArray<string> {
  const directories: string[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const separatorIndex = record.indexOf("\t");
    if (separatorIndex < 0) continue;
    const [mode, type, objectId] = record.slice(0, separatorIndex).split(" ");
    const path = record.slice(separatorIndex + 1);
    if (
      mode === "040000" &&
      type === "tree" &&
      objectId &&
      isObjectId(objectId) &&
      path.toLowerCase() === "pull_request_template"
    ) {
      directories.push(path);
    }
  }
  return directories;
}

function isInvalidTemplateContent(content: string): boolean {
  return content.includes("\0") || content.includes("\uFFFD");
}

function isSupportedTemplateExtension(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return TEMPLATE_EXTENSIONS.some((candidate) => candidate === extension);
}

export const discoverPullRequestTemplate = Effect.fn("discoverPullRequestTemplate")(
  function* (input: { readonly cwd: string; readonly baseRef: string }) {
    const gitCore = yield* GitCore;

    const resolvedBase = yield* gitCore
      .execute({
        operation: "PullRequestTemplateDiscovery.resolveBase",
        cwd: input.cwd,
        args: ["rev-parse", "--verify", "--end-of-options", `${input.baseRef}^{commit}`],
        env: EXACT_OBJECT_ENV,
        maxOutputBytes: OBJECT_SIZE_MAX_BYTES,
      })
      .pipe(Effect.option);
    if (resolvedBase._tag === "None") {
      return { status: "unavailable", reason: "base-unavailable" } as const;
    }

    const baseObjectId = resolvedBase.value.stdout.trim();
    if (!isObjectId(baseObjectId)) {
      return { status: "unavailable", reason: "base-unavailable" } as const;
    }

    const rootTree = yield* gitCore
      .execute({
        operation: "PullRequestTemplateDiscovery.listRootTree",
        cwd: input.cwd,
        args: ["ls-tree", "-z", "--full-tree", baseObjectId],
        env: EXACT_OBJECT_ENV,
        maxOutputBytes: TREE_LIST_MAX_BYTES,
      })
      .pipe(Effect.option);
    if (rootTree._tag === "None") {
      return { status: "unavailable", reason: "tree-unavailable" } as const;
    }

    const nestedTree = yield* gitCore
      .execute({
        operation: "PullRequestTemplateDiscovery.listNestedTrees",
        cwd: input.cwd,
        args: ["ls-tree", "-r", "-z", "--full-tree", baseObjectId, "--", ".github", "docs"],
        env: EXACT_OBJECT_ENV,
        maxOutputBytes: TREE_LIST_MAX_BYTES,
      })
      .pipe(Effect.option);
    if (nestedTree._tag === "None") {
      return { status: "unavailable", reason: "tree-unavailable" } as const;
    }

    const rootTemplateDirectories = parseRootTemplateDirectories(rootTree.value.stdout);
    if (rootTemplateDirectories.length > TEMPLATE_DIRECTORY_MAX_CANDIDATES) {
      return { status: "unavailable", reason: "too-many-template-candidates" } as const;
    }
    const rootDirectoryTree =
      rootTemplateDirectories.length === 0
        ? null
        : yield* gitCore
            .execute({
              operation: "PullRequestTemplateDiscovery.listRootTemplateDirectories",
              cwd: input.cwd,
              args: [
                "ls-tree",
                "-r",
                "-z",
                "--full-tree",
                baseObjectId,
                "--",
                ...rootTemplateDirectories,
              ],
              env: EXACT_OBJECT_ENV,
              maxOutputBytes: TREE_LIST_MAX_BYTES,
            })
            .pipe(Effect.option);
    if (rootDirectoryTree?._tag === "None") {
      return { status: "unavailable", reason: "tree-unavailable" } as const;
    }

    const entries = [
      ...parseTemplateTree(rootTree.value.stdout),
      ...parseTemplateTree(nestedTree.value.stdout),
      ...(rootDirectoryTree?._tag === "Some"
        ? parseTemplateTree(rootDirectoryTree.value.stdout)
        : []),
    ];

    const readBlob = (entry: TemplateTreeEntry): Effect.Effect<BlobReadResult> =>
      Effect.gen(function* () {
        const sizeResult = yield* gitCore
          .execute({
            operation: "PullRequestTemplateDiscovery.readBlobSize",
            cwd: input.cwd,
            args: ["cat-file", "-s", entry.blobObjectId],
            env: EXACT_OBJECT_ENV,
            maxOutputBytes: OBJECT_SIZE_MAX_BYTES,
          })
          .pipe(Effect.option);
        if (sizeResult._tag === "None") {
          return { status: "unavailable", reason: "template-unavailable" } as const;
        }

        const size = Number.parseInt(sizeResult.value.stdout.trim(), 10);
        if (!Number.isSafeInteger(size) || size < 0) {
          return { status: "unavailable", reason: "template-unavailable" } as const;
        }
        if (size > TEMPLATE_MAX_BYTES) {
          return { status: "unavailable", reason: "template-too-large" } as const;
        }

        const blob = yield* gitCore
          .execute({
            operation: "PullRequestTemplateDiscovery.readBlob",
            cwd: input.cwd,
            args: ["cat-file", "blob", entry.blobObjectId],
            env: EXACT_OBJECT_ENV,
            maxOutputBytes: TEMPLATE_MAX_BYTES,
          })
          .pipe(Effect.option);
        if (blob._tag === "None") {
          return { status: "unavailable", reason: "template-unavailable" } as const;
        }
        if (isInvalidTemplateContent(blob.value.stdout)) {
          return { status: "unavailable", reason: "invalid-template-content" } as const;
        }

        const content = blob.value.stdout;
        return content.trim().length === 0
          ? ({ status: "empty" } as const)
          : ({ status: "found", content } as const);
      });

    for (const location of TEMPLATE_LOCATIONS) {
      const prefix = location.length > 0 ? `${location}/` : "";
      const canonicalPrefix = prefix.toLowerCase();
      const candidates = entries.filter((entry) => {
        const canonicalPath = entry.path.toLowerCase();
        if (!canonicalPath.startsWith(canonicalPrefix)) return false;
        const relativePath = entry.path.slice(prefix.length);
        return (
          !relativePath.includes("/") &&
          relativePath.toLowerCase().startsWith("pull_request_template.") &&
          isSupportedTemplateExtension(relativePath)
        );
      });
      if (candidates.length > TEMPLATE_DIRECTORY_MAX_CANDIDATES) {
        return { status: "unavailable", reason: "too-many-template-candidates" } as const;
      }
      const usable: Array<TemplateTreeEntry & { readonly content: string }> = [];
      for (const entry of candidates) {
        const blob = yield* readBlob(entry);
        if (blob.status === "unavailable") return blob;
        if (blob.status === "found") usable.push({ ...entry, content: blob.content });
      }
      if (usable.length > 1) {
        return {
          status: "ambiguous",
          paths: usable.map((entry) => entry.path).toSorted(),
        } as const;
      }
      const selected = usable[0];
      if (selected) {
        return { status: "found", ...selected } as const;
      }
    }

    for (const location of TEMPLATE_LOCATIONS) {
      const prefix =
        location.length > 0 ? `${location}/pull_request_template/` : "pull_request_template/";
      const canonicalPrefix = prefix.toLowerCase();
      const candidates = entries.filter((entry) => {
        if (!entry.path.toLowerCase().startsWith(canonicalPrefix)) return false;
        const relativePath = entry.path.slice(prefix.length);
        return !relativePath.includes("/") && isSupportedTemplateExtension(relativePath);
      });
      if (candidates.length > TEMPLATE_DIRECTORY_MAX_CANDIDATES) {
        return { status: "unavailable", reason: "too-many-template-candidates" } as const;
      }
      const usable: Array<TemplateTreeEntry & { readonly content: string }> = [];
      for (const entry of candidates) {
        const blob = yield* readBlob(entry);
        if (blob.status === "unavailable") {
          return blob;
        }
        if (blob.status === "found") {
          usable.push({ ...entry, content: blob.content });
        }
      }

      if (usable.length > 1) {
        return {
          status: "ambiguous",
          paths: usable.map((entry) => entry.path).toSorted(),
        } as const;
      }
      const selected = usable[0];
      if (selected) {
        return {
          status: "found",
          path: selected.path,
          blobObjectId: selected.blobObjectId,
          content: selected.content,
        } as const;
      }
    }

    return { status: "not-found" } as const;
  },
);
