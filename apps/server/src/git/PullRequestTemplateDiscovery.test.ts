import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../config.ts";
import { GitCoreLive } from "./Layers/GitCore.ts";
import { type ExecuteGitInput, GitCore, type GitCoreShape } from "./Services/GitCore.ts";
import { discoverPullRequestTemplate } from "./PullRequestTemplateDiscovery.ts";

const SINGLE_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PuLl_ReQuEsT_TeMpLaTe.TxT",
  "pull_request_template.txt",
  "PULL_REQUEST_TEMPLATE.MD",
  "docs/pull_request_template.txt",
  "docs/PuLl_ReQuEsT_TeMpLaTe.Md",
] as const;

const TEMPLATE_DIRECTORIES = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
] as const;

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-pr-template-discovery-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const gitCore = yield* GitCore;
    return yield* gitCore.execute({
      operation: "PullRequestTemplateDiscovery.test.git",
      cwd,
      args,
    });
  });

const writeFile = (cwd: string, relativePath: string, content: string | Uint8Array) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    if (typeof content === "string") {
      yield* fileSystem.writeFileString(absolutePath, content);
    } else {
      yield* fileSystem.writeFile(absolutePath, content);
    }
    return absolutePath;
  });

const commitAll = (cwd: string, message = "Update templates") =>
  Effect.gen(function* () {
    yield* runGit(cwd, ["add", "-A"]);
    yield* runGit(cwd, ["commit", "--allow-empty", "-m", message]);
  });

const withRepository = <A, E, R>(
  body: (cwd: string) => Effect.Effect<A, E, R | GitCore | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-pr-template-discovery-",
      });
      yield* runGit(cwd, ["init", "--initial-branch=main"]);
      yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test User"]);
      yield* writeFile(cwd, "README.md", "initial\n");
      yield* commitAll(cwd, "Initial commit");
      return yield* body(cwd);
    }),
  ).pipe(Effect.provide(TestLayer));

const discover = (cwd: string, baseRef = "HEAD") => discoverPullRequestTemplate({ cwd, baseRef });

it.effect.each(SINGLE_TEMPLATE_PATHS)("discovers the canonical path %s", (templatePath) =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, templatePath, `## Template from ${templatePath}\n`);
      yield* commitAll(cwd);

      const result = yield* discover(cwd);
      expect(result).toMatchObject({
        status: "found",
        path: templatePath,
        content: `## Template from ${templatePath}\n`,
      });
      if (result.status === "found") {
        expect(result.blobObjectId).toMatch(/^[0-9a-f]{40,64}$/u);
      }
    }),
  ),
);

it.effect.each(TEMPLATE_DIRECTORIES)("discovers one Markdown file in %s", (directory) =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      const templatePath = `${directory}/feature.MD`;
      yield* writeFile(cwd, templatePath, "## Feature template\n");
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toMatchObject({
        status: "found",
        path: templatePath,
        content: "## Feature template\n",
      });
    }),
  ),
);

it.effect("discovers a mixed-case text template inside the canonical directory", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      const templatePath = ".github/PuLl_ReQuEsT_TeMpLaTe/feature.TxT";
      yield* writeFile(cwd, templatePath, "Feature text template\n");
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toMatchObject({
        status: "found",
        path: templatePath,
        content: "Feature text template\n",
      });
    }),
  ),
);

it.effect("preserves valid UTF-8 template content exactly", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      const content = "  ## Indented heading\n\nKeep the final spacing.  \n\n";
      yield* writeFile(cwd, ".github/pull_request_template.md", content);
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toMatchObject({ status: "found", content });
    }),
  ),
);

it.effect("does not choose between multiple default-template extensions", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/PULL_REQUEST_TEMPLATE.md", "Markdown\n");
      yield* writeFile(cwd, ".github/pull_request_template.txt", "Text\n");
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toEqual({
        status: "ambiguous",
        paths: [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.txt"],
      });
    }),
  ),
);

it.effect("ignores similarly named files with unsupported extensions", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/pull_request_template.sh", "publish-secret\n");
      yield* writeFile(cwd, ".github/pull_request_template.backup.md", "archived\n");
      yield* writeFile(cwd, "docs/pull_request_template.notes.txt", "notes\n");
      yield* writeFile(cwd, ".github/PULL_REQUEST_TEMPLATE/md", "extensionless Markdown\n");
      yield* writeFile(cwd, "docs/PULL_REQUEST_TEMPLATE/txt", "extensionless text\n");
      yield* writeFile(cwd, ".github/PULL_REQUEST_TEMPLATE/unsafe.json", "{}\n");
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toEqual({ status: "not-found" });
    }),
  ),
);

it.effect("does not inspect extra-suffix decoys beside a canonical default template", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/PuLl_ReQuEsT_TeMpLaTe.Md", "canonical\n");
      yield* writeFile(
        cwd,
        ".github/pull_request_template.private.md",
        "sensitive-looking decoy\n".repeat(1_000),
      );
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toMatchObject({
        status: "found",
        path: ".github/PuLl_ReQuEsT_TeMpLaTe.Md",
        content: "canonical\n",
      });
    }),
  ),
);

it.effect("reads the exact committed base tree instead of the working tree", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/pull_request_template.md", "base template\n");
      yield* commitAll(cwd, "Add base template");
      yield* runGit(cwd, ["branch", "base-with-template"]);
      yield* runGit(cwd, ["checkout", "-b", "feature", "HEAD~1"]);
      yield* writeFile(cwd, ".github/pull_request_template.md", "uncommitted replacement\n");

      expect(yield* discover(cwd, "base-with-template")).toMatchObject({
        status: "found",
        content: "base template\n",
      });
      expect(yield* discover(cwd, "feature")).toEqual({ status: "not-found" });
    }),
  ),
);

it.effect("ignores local Git replacement refs when reading committed template objects", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/pull_request_template.md", "safe committed template\n");
      yield* writeFile(cwd, "replacement.md", "replacement content\n");
      yield* commitAll(cwd);
      const originalBlob = (yield* runGit(cwd, [
        "rev-parse",
        "HEAD:.github/pull_request_template.md",
      ])).stdout.trim();
      const replacementBlob = (yield* runGit(cwd, [
        "rev-parse",
        "HEAD:replacement.md",
      ])).stdout.trim();
      yield* runGit(cwd, ["replace", originalBlob, replacementBlob]);

      expect(yield* discover(cwd)).toMatchObject({
        status: "found",
        blobObjectId: originalBlob,
        content: "safe committed template\n",
      });
    }),
  ),
);

it.effect("keeps every committed-object read local and replacement-free", () => {
  const commitObjectId = "a".repeat(40);
  const blobObjectId = "b".repeat(40);
  const calls: ExecuteGitInput[] = [];
  const outputs = [
    { code: 0, stdout: `${commitObjectId}\n`, stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    {
      code: 0,
      stdout: `100644 blob ${blobObjectId}\t.github/pull_request_template.md\0`,
      stderr: "",
    },
    { code: 0, stdout: "8\n", stderr: "" },
    { code: 0, stdout: "template", stderr: "" },
  ] as const;
  const GitCoreCommandContractLayer = Layer.succeed(GitCore, {
    execute: (input: ExecuteGitInput) => {
      calls.push(input);
      return Effect.succeed(outputs[calls.length - 1]!);
    },
  } as unknown as GitCoreShape);

  return Effect.gen(function* () {
    expect(yield* discoverPullRequestTemplate({ cwd: "/repo", baseRef: "main" })).toMatchObject({
      status: "found",
      blobObjectId,
      content: "template",
    });
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.env).toMatchObject({
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      });
    }
  }).pipe(Effect.provide(GitCoreCommandContractLayer));
});

it.effect("uses deterministic canonical path priority and skips empty files", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/pull_request_template.md", " \n");
      yield* writeFile(cwd, "pull_request_template.md", "## Preferred\n");
      yield* writeFile(cwd, "docs/pull_request_template.md", "## Later\n");
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toMatchObject({
        status: "found",
        path: "pull_request_template.md",
        content: "## Preferred\n",
      });
    }),
  ),
);

it.effect("does not guess between multiple directory templates", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/PULL_REQUEST_TEMPLATE/bug.md", "## Bug\n");
      yield* writeFile(cwd, ".github/PULL_REQUEST_TEMPLATE/feature.md", "## Feature\n");
      yield* writeFile(cwd, "PULL_REQUEST_TEMPLATE/fallback.md", "## Fallback\n");
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toEqual({
        status: "ambiguous",
        paths: [".github/PULL_REQUEST_TEMPLATE/bug.md", ".github/PULL_REQUEST_TEMPLATE/feature.md"],
      });
    }),
  ),
);

it.effect("fails closed before reading an unbounded number of directory candidates", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      for (let index = 0; index < 33; index += 1) {
        yield* writeFile(
          cwd,
          `.github/PULL_REQUEST_TEMPLATE/template-${String(index).padStart(2, "0")}.md`,
          " \n",
        );
      }
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toEqual({
        status: "unavailable",
        reason: "too-many-template-candidates",
      });
    }),
  ),
);

it.effect("ignores nested files in template directories", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/PULL_REQUEST_TEMPLATE/nested/feature.md", "nested\n");
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toEqual({ status: "not-found" });
    }),
  ),
);

it.effect("ignores committed symlinks and never follows them through the worktree", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outsideDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-pr-template-outside-",
      });
      const outsideFile = yield* writeFile(outsideDirectory, "secret.md", "SECRET_SENTINEL\n");
      const symlinkPath = path.join(cwd, ".github", "pull_request_template.md");
      yield* fileSystem.makeDirectory(path.dirname(symlinkPath), { recursive: true });
      yield* fileSystem.symlink(outsideFile, symlinkPath);
      yield* writeFile(cwd, "pull_request_template.md", "## Safe template\n");
      yield* commitAll(cwd);

      const result = yield* discover(cwd);
      expect(result).toMatchObject({ status: "found", content: "## Safe template\n" });
      expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
    }),
  ),
);

it.effect("rejects oversized templates instead of truncating them", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/pull_request_template.md", "a".repeat(8_001));
      yield* writeFile(cwd, "pull_request_template.md", "## Unsafe fallback\n");
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toEqual({
        status: "unavailable",
        reason: "template-too-large",
      });
    }),
  ),
);

it.effect("rejects binary and invalid UTF-8 template content", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(
        cwd,
        ".github/pull_request_template.md",
        new Uint8Array([0x23, 0x20, 0x66, 0x6f, 0x80, 0x00]),
      );
      yield* commitAll(cwd);

      expect(yield* discover(cwd)).toEqual({
        status: "unavailable",
        reason: "invalid-template-content",
      });
    }),
  ),
);

it.effect("fails closed for an invalid or option-like base ref", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/pull_request_template.md", "## Template\n");
      yield* commitAll(cwd);

      expect(yield* discover(cwd, "missing-branch")).toEqual({
        status: "unavailable",
        reason: "base-unavailable",
      });
      expect(yield* discover(cwd, "--help")).toEqual({
        status: "unavailable",
        reason: "base-unavailable",
      });
    }),
  ),
);

it.effect("reports no template in an ordinary repository", () =>
  withRepository((cwd) =>
    Effect.gen(function* () {
      expect(yield* discover(cwd)).toEqual({ status: "not-found" });
    }),
  ),
);
