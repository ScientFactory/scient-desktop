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

const SINGLE_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

const TEMPLATE_DIRECTORIES = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
] as const;

const TREE_PATHS = [...SINGLE_TEMPLATE_PATHS, ...TEMPLATE_DIRECTORIES] as const;

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

function isInvalidTemplateContent(content: string): boolean {
  return content.includes("\0") || content.includes("\uFFFD");
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

    const tree = yield* gitCore
      .execute({
        operation: "PullRequestTemplateDiscovery.listTree",
        cwd: input.cwd,
        args: ["ls-tree", "-r", "-z", "--full-tree", baseObjectId, "--", ...TREE_PATHS],
        env: EXACT_OBJECT_ENV,
        maxOutputBytes: TREE_LIST_MAX_BYTES,
      })
      .pipe(Effect.option);
    if (tree._tag === "None") {
      return { status: "unavailable", reason: "tree-unavailable" } as const;
    }

    const entries = parseTemplateTree(tree.value.stdout);
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry] as const));

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

        const content = blob.value.stdout.trim();
        return content.length === 0
          ? ({ status: "empty" } as const)
          : ({ status: "found", content } as const);
      });

    for (const templatePath of SINGLE_TEMPLATE_PATHS) {
      const entry = entriesByPath.get(templatePath);
      if (!entry) continue;
      const blob = yield* readBlob(entry);
      if (blob.status === "unavailable") {
        return blob;
      }
      if (blob.status === "found") {
        return {
          status: "found",
          path: entry.path,
          blobObjectId: entry.blobObjectId,
          content: blob.content,
        } as const;
      }
    }

    for (const directory of TEMPLATE_DIRECTORIES) {
      const prefix = `${directory}/`;
      const candidates = entries.filter((entry) => {
        if (!entry.path.startsWith(prefix)) return false;
        const relativePath = entry.path.slice(prefix.length);
        return !relativePath.includes("/") && relativePath.toLowerCase().endsWith(".md");
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
