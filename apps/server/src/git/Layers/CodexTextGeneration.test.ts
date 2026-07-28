import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  CodexTextGenerationLive,
  selectCodexApiAuthForTextGeneration,
  sanitizeCodexConfigForTextGeneration,
} from "./CodexTextGeneration.ts";
import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

const CodexTextGenerationTestLayer = CodexTextGenerationLive.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-codex-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

let codexEnvQueue = Promise.resolve();

function acquireCodexEnvLock() {
  return Effect.promise(async () => {
    let releaseLock = () => {};
    const previous = codexEnvQueue;
    codexEnvQueue = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previous;
    return releaseLock;
  });
}

function makeFakeCodexBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, "codex");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        'output_path=""',
        'seen_shell_disabled=""',
        'seen_remote_plugin_disabled=""',
        'seen_skill_install_disabled=""',
        'seen_agents_disabled=""',
        'seen_apps_disabled=""',
        'seen_web_disabled=""',
        'seen_update_check_disabled=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--image" ]; then',
        "    shift",
        '    if [ -n "$1" ]; then',
        '      seen_image="1"',
        "    fi",
        "    continue",
        "  fi",
        '  if [ "$1" = "--skip-git-repo-check" ]; then',
        '    seen_skip_git_repo_check="1"',
        "  fi",
        '  if [ "$1" = "--config" ]; then',
        "    shift",
        '    if [ "$1" = "approval_policy=\\"never\\"" ]; then',
        '      seen_approval_never="1"',
        "    fi",
        '    [ "$1" = "features.shell_tool=false" ] && seen_shell_disabled="1"',
        '    [ "$1" = "features.remote_plugin=false" ] && seen_remote_plugin_disabled="1"',
        '    [ "$1" = "features.skill_mcp_dependency_install=false" ] && seen_skill_install_disabled="1"',
        '    [ "$1" = "agents.enabled=false" ] && seen_agents_disabled="1"',
        '    [ "$1" = "apps._default.enabled=false" ] && seen_apps_disabled="1"',
        '    [ "$1" = "web_search=\\"disabled\\"" ] && seen_web_disabled="1"',
        '    [ "$1" = "check_for_update_on_startup=false" ] && seen_update_check_disabled="1"',
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "  fi",
        "  shift",
        "done",
        'case "$PWD" in */synara-codex-runtime-*/workspace) ;; *) printf "%s\\n" "non-isolated cwd" >&2; exit 11 ;; esac',
        'node -e \'const fs=require("node:fs"); if (process.platform !== "win32" && (fs.statSync(process.argv[1]).mode & 0o777) !== 0o700) process.exit(1)\' "$CODEX_HOME" || { printf "%s\\n" "insecure CODEX_HOME permissions" >&2; exit 13; }',
        'if [ -f "$CODEX_HOME/auth.json" ]; then',
        '  node -e \'const fs=require("node:fs"); if (process.platform !== "win32" && (fs.statSync(process.argv[1]).mode & 0o777) !== 0o600) process.exit(1)\' "$CODEX_HOME/auth.json" || { printf "%s\\n" "insecure auth.json permissions" >&2; exit 14; }',
        "fi",
        'if [ "$seen_shell_disabled$seen_remote_plugin_disabled$seen_skill_install_disabled$seen_agents_disabled$seen_apps_disabled$seen_web_disabled$seen_update_check_disabled" != "1111111" ]; then',
        '  printf "%s\\n" "missing tool-isolation config" >&2',
        "  exit 12",
        "fi",
        'stdin_content="$(cat)"',
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_IMAGE" = "1" ] && [ "$seen_image" != "1" ]; then',
        '  printf "%s\\n" "missing --image input" >&2',
        "  exit 2",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK" = "1" ] && [ "$seen_skip_git_repo_check" != "1" ]; then',
        '  printf "%s\\n" "missing --skip-git-repo-check" >&2',
        "  exit 9",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER" = "1" ] && [ "$seen_approval_never" != "1" ]; then',
        '  printf "%s\\n" "missing approval_policy=never" >&2',
        "  exit 10",
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN" ]; then',
        '  printf "%s" "$stdin_content" | grep -F -- "$SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "stdin missing expected content" >&2',
        "    exit 3",
        "  }",
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN" ]; then',
        '  if printf "%s" "$stdin_content" | grep -F -- "$SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN" >/dev/null; then',
        '    printf "%s\\n" "stdin contained forbidden content" >&2',
        "    exit 4",
        "  fi",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME" = "1" ] && [ -z "$CODEX_HOME" ]; then',
        '  printf "%s\\n" "missing CODEX_HOME" >&2',
        "  exit 5",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON" = "1" ] && [ ! -f "$CODEX_HOME/auth.json" ]; then',
        '  printf "%s\\n" "missing auth.json in CODEX_HOME" >&2',
        "  exit 6",
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN" ]; then',
        '  grep -F -- "$SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN" "$CODEX_HOME/config.toml" >/dev/null || {',
        '    printf "%s\\n" "CODEX_HOME config missing expected content" >&2',
        "    exit 7",
        "  }",
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN" ]; then',
        '  if grep -F -- "$SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN" "$CODEX_HOME/config.toml" >/dev/null; then',
        '    printf "%s\\n" "CODEX_HOME config contained forbidden content" >&2',
        "    exit 8",
        "  fi",
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_STDERR" ]; then',
        '  printf "%s\\n" "$SYNARA_FAKE_CODEX_STDERR" >&2',
        "fi",
        'if [ -n "$output_path" ]; then',
        '  node -e \'const fs=require("node:fs"); const value=process.argv[2] ?? ""; fs.writeFileSync(process.argv[1], Buffer.from(value, "base64"));\' "$output_path" "${SYNARA_FAKE_CODEX_OUTPUT_B64:-e30=}"',
        "fi",
        'exit "${SYNARA_FAKE_CODEX_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);
    return binDir;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
    requireCodexHome?: boolean;
    requireAuthJson?: boolean;
    requireSkipGitRepoCheck?: boolean;
    requireApprovalNever?: boolean;
    codexHomeConfigMustContain?: string;
    codexHomeConfigMustNotContain?: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const releaseLock = yield* acquireCodexEnvLock();
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({
        prefix: "synara-codex-text-",
      });
      const binDir = yield* makeFakeCodexBinary(tempDir);
      const previousPath = process.env.PATH;
      const previousScientHome = process.env.SCIENT_HOME;
      const previousOutput = process.env.SYNARA_FAKE_CODEX_OUTPUT_B64;
      const previousExitCode = process.env.SYNARA_FAKE_CODEX_EXIT_CODE;
      const previousStderr = process.env.SYNARA_FAKE_CODEX_STDERR;
      const previousRequireImage = process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE;
      const previousStdinMustContain = process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN;
      const previousStdinMustNotContain = process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
      const previousRequireCodexHome = process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME;
      const previousRequireAuthJson = process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON;
      const previousRequireSkipGitRepoCheck =
        process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
      const previousRequireApprovalNever = process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
      const previousCodexHomeConfigMustContain =
        process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
      const previousCodexHomeConfigMustNotContain =
        process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;

      yield* Effect.sync(() => {
        process.env.PATH = `${binDir}:${previousPath ?? ""}`;
        process.env.SCIENT_HOME = tempDir;
        process.env.SYNARA_FAKE_CODEX_OUTPUT_B64 = Buffer.from(input.output, "utf8").toString(
          "base64",
        );

        if (input.exitCode !== undefined) {
          process.env.SYNARA_FAKE_CODEX_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.SYNARA_FAKE_CODEX_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.SYNARA_FAKE_CODEX_STDERR = input.stderr;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_STDERR;
        }

        if (input.requireImage) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN;
        }

        if (input.stdinMustNotContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN = input.stdinMustNotContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        }

        if (input.requireCodexHome) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME;
        }

        if (input.requireAuthJson) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON;
        }

        if (input.requireSkipGitRepoCheck) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
        }

        if (input.requireApprovalNever) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
        }

        if (input.codexHomeConfigMustContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN =
            input.codexHomeConfigMustContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
        }

        if (input.codexHomeConfigMustNotContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN =
            input.codexHomeConfigMustNotContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;
        }
      });

      return {
        previousPath,
        previousScientHome,
        previousOutput,
        previousExitCode,
        previousStderr,
        previousRequireImage,
        previousStdinMustContain,
        previousStdinMustNotContain,
        previousRequireCodexHome,
        previousRequireAuthJson,
        previousRequireSkipGitRepoCheck,
        previousRequireApprovalNever,
        previousCodexHomeConfigMustContain,
        previousCodexHomeConfigMustNotContain,
        releaseLock,
      };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env.PATH = previous.previousPath;
        if (previous.previousScientHome === undefined) {
          delete process.env.SCIENT_HOME;
        } else {
          process.env.SCIENT_HOME = previous.previousScientHome;
        }

        if (previous.previousOutput === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_OUTPUT_B64;
        } else {
          process.env.SYNARA_FAKE_CODEX_OUTPUT_B64 = previous.previousOutput;
        }

        if (previous.previousExitCode === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_EXIT_CODE;
        } else {
          process.env.SYNARA_FAKE_CODEX_EXIT_CODE = previous.previousExitCode;
        }

        if (previous.previousStderr === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_STDERR;
        } else {
          process.env.SYNARA_FAKE_CODEX_STDERR = previous.previousStderr;
        }

        if (previous.previousRequireImage === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE = previous.previousRequireImage;
        }

        if (previous.previousStdinMustContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN = previous.previousStdinMustContain;
        }

        if (previous.previousStdinMustNotContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN =
            previous.previousStdinMustNotContain;
        }

        if (previous.previousRequireCodexHome === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME = previous.previousRequireCodexHome;
        }

        if (previous.previousRequireAuthJson === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON = previous.previousRequireAuthJson;
        }

        if (previous.previousRequireSkipGitRepoCheck === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK =
            previous.previousRequireSkipGitRepoCheck;
        }

        if (previous.previousRequireApprovalNever === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER =
            previous.previousRequireApprovalNever;
        }

        if (previous.previousCodexHomeConfigMustContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN =
            previous.previousCodexHomeConfigMustContain;
        }

        if (previous.previousCodexHomeConfigMustNotContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN =
            previous.previousCodexHomeConfigMustNotContain;
        }

        previous.releaseLock();
      }),
  );
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGenerationLive", (it) => {
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
        });

        expect(generated.subject.length).toBeLessThanOrEqual(72);
        expect(generated.subject.endsWith(".")).toBe(false);
        expect(generated.body).toBe("- added migration\n- updated tests");
        expect(generated.branch).toBeUndefined();
      }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          includeBranch: true,
        });

        expect(generated.subject).toBe("Add important change");
        expect(generated.branch).toBe("feature/fix/important-system-change");
      }),
    ),
  );

  it.effect("formats conventional commits from schema-validated structured fields", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Improve repository search.",
          body: "",
          conventionalType: "perf",
          conventionalScope: "Search UI",
          breaking: false,
        }),
        stdinMustContain: "Scient formats the final conventional-commit subject deterministically",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M search.ts",
          stagedPatch: "diff --git a/search.ts b/search.ts",
          policy: { mode: "conventional_commits" },
        });

        expect(generated.subject).toBe("perf(search-ui): Improve repository search");
      }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/codex-effect",
          commitSummary: "feat: improve orchestration flow",
          diffSummary: "2 files changed",
          diffPatch: "diff --git a/a.ts b/a.ts",
        });

        expect(generated.title).toBe("Improve orchestration flow");
        expect(generated.body.startsWith("## Summary")).toBe(true);
        expect(generated.body.endsWith("\n\n")).toBe(false);
      }),
    ),
  );

  it.effect("passes a committed pull request template as a subordinate outline", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "Improve orchestration flow",
          body: "## User effect\n- Faster orchestration\n\n## Verification\n- Tests pass",
        }),
        stdinMustContain: "## User effect",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/codex-effect",
          commitSummary: "feat: improve orchestration flow",
          diffSummary: "2 files changed",
          diffPatch: "diff --git a/a.ts b/a.ts",
          pullRequestTemplate: {
            path: ".github/pull_request_template.md",
            content: "## User effect\n\n## Verification",
          },
        });

        expect(generated.body).toContain("## User effect");
      }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Please update session handling.",
        });

        expect(generated.branch).toBe("feat/session");
      }),
    ),
  );

  it.effect("generates compact thread titles from the first user message", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: ' "Polish sidebar loading state." ',
        }),
        stdinMustContain: "Never exceed 6 words.",
        requireSkipGitRepoCheck: true,
        requireApprovalNever: true,
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "The sidebar loading state feels noisy and needs polish.",
        });

        expect(generated.title).toBe("Polish sidebar loading state");
      }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Fix timeout behavior.",
        });

        expect(generated.branch).toBe("fix/session-timeout");
      }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-branch-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(Effect.ensuring(fs.remove(attachmentPath).pipe(Effect.catch(() => Effect.void))));

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(imagePath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(
            Effect.tap(() =>
              fs.stat(imagePath).pipe(
                Effect.map((fileInfo) => {
                  expect(fileInfo.type).toBe("File");
                }),
              ),
            ),
            Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
          );

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const missingAttachmentId = `thread-missing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
        yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: missingAttachmentId,
                name: "outside.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Left" as const, left: error }),
              onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
            }),
          );

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TextGenerationError);
          expect(result.left.message).toContain("missing --image input");
        }
      }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const result = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Fix websocket reconnect flake",
            })
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: "Left" as const, left: error }),
                onSuccess: (value) => ({
                  _tag: "Right" as const,
                  right: value,
                }),
              }),
            );

          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(TextGenerationError);
            expect(result.left.message).toContain("Codex returned invalid structured output");
          }
        }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const result = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-error",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Left" as const, left: error }),
              onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
            }),
          );

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TextGenerationError);
          expect(result.left.message).toContain("Codex CLI command failed: codex execution failed");
        }
      }),
    ),
  );

  it("preserves selected provider WebSocket transport without executable configuration", () => {
    const sanitized = sanitizeCodexConfigForTextGeneration(
      [
        'model_provider = "azure"',
        "supports_websockets = false",
        "[model_providers.azure]",
        'base_url = "https://example.invalid/v1"',
        "supports_websockets = true",
        "websocket_connect_timeout_ms = 4321",
        "[profiles.unsafe.mcp_servers.repo]",
        'command = "read-secrets"',
      ].join("\n"),
    );

    expect(sanitized).toContain('model_provider = "azure"');
    expect(sanitized).toContain("supports_websockets = true");
    expect(sanitized).toContain("websocket_connect_timeout_ms = 4321");
    expect(sanitized).not.toContain("profiles");
    expect(sanitized).not.toContain("mcp_servers");
    expect(sanitized).not.toContain("read-secrets");
  });

  it("does not let isolated providers dereference arbitrary server environment variables", () => {
    const sanitized = sanitizeCodexConfigForTextGeneration(
      [
        'model_provider = "azure"',
        "[model_providers.azure]",
        'base_url = "https://example.invalid/v1"',
        'env_key = "AZURE_OPENAI_API_KEY"',
        'query_params = { api-version = "2025-04-01-preview" }',
        'http_headers = { X-Static = "safe-value" }',
        'env_http_headers = { X-Backup-Key = "UNRELATED_BACKUP_SECRET" }',
      ].join("\n"),
    );

    expect(sanitized).toContain('env_key = "AZURE_OPENAI_API_KEY"');
    expect(sanitized).toContain('api-version = "2025-04-01-preview"');
    expect(sanitized).toContain('X-Static = "safe-value"');
    expect(sanitized).not.toContain("env_http_headers");
    expect(sanitized).not.toContain("UNRELATED_BACKUP_SECRET");
  });

  it("projects only non-rotating API auth into the isolated Codex runtime", () => {
    expect(
      selectCodexApiAuthForTextGeneration(
        JSON.stringify({
          OPENAI_API_KEY: "test-key",
          tokens: { access_token: "access", refresh_token: "refresh" },
          last_refresh: "2026-07-28T00:00:00Z",
        }),
      ),
    ).toBe('{"OPENAI_API_KEY":"test-key"}');
    expect(
      selectCodexApiAuthForTextGeneration(
        JSON.stringify({ tokens: { access_token: "access", refresh_token: "refresh" } }),
      ),
    ).toBeNull();
  });

  it.effect("rejects OAuth-only SCM writing before launching Codex", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const codexHome = yield* fs.makeTempDirectoryScoped({
        prefix: "synara-codex-oauth-preflight-",
      });
      yield* fs.writeFileString(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: "access", refresh_token: "refresh" },
        }),
      );
      const previousApiKey = process.env.OPENAI_API_KEY;
      yield* Effect.sync(() => {
        delete process.env.OPENAI_API_KEY;
      });

      const textGeneration = yield* TextGeneration;
      const error = yield* textGeneration
        .preflightSourceControlWriting({
          cwd: process.cwd(),
          operations: ["generateCommitMessage", "generatePrContent"],
          codexHomePath: codexHome,
          providerOptions: { codex: { binaryPath: "/must-not-launch/codex" } },
        })
        .pipe(
          Effect.flip,
          Effect.ensuring(
            Effect.sync(() => {
              if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
              else process.env.OPENAI_API_KEY = previousApiKey;
            }),
          ),
        );

      expect(error.message).toContain("requires API-key authentication");
      expect(error.message).toContain("ChatGPT OAuth");
    }),
  );

  it.effect("uses the provided codexHomePath and strips local skills config", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireCodexHome: true,
        requireAuthJson: true,
        codexHomeConfigMustContain: 'model_provider = "azure"',
        codexHomeConfigMustNotContain: "unsafe_text_generation_capability",
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const wrongCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-wrong-codex-",
        });
        const customCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-custom-codex-",
        });
        const previousCodexHome = process.env.CODEX_HOME;
        const previousAzureApiKey = process.env.AZURE_OPENAI_API_KEY;

        yield* fs.writeFileString(
          path.join(customCodexHome, "config.toml"),
          [
            'model_instructions_file = "/unsafe_text_generation_capability/instructions.md"',
            'skills.config = [{ path = "/unsafe_text_generation_capability/dotted-skill.md", enabled = true }]',
            'model_provider = "azure"',
            "",
            "[model_providers.azure]",
            'env_key = "AZURE_OPENAI_API_KEY"',
            "",
            "[mcp_servers]",
            'unsafe = { command = "unsafe_text_generation_capability" }',
            "",
            "[profiles.attacker.mcp_servers.untrusted]",
            'command = "unsafe_text_generation_capability"',
            "",
            "[apps]",
            'unsafe = { command = "unsafe_text_generation_capability" }',
            "",
            "[[plugins]]",
            'path = "/unsafe_text_generation_capability/plugin"',
            "",
            "[hooks]",
            'after_agent = ["publish-output"]',
            "unsafe_text_generation_capability = true",
            "",
            "[features]",
            "fast_mode = true",
            "",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(customCodexHome, "auth.json"),
          '{"OPENAI_API_KEY":"test-key","tokens":{"refresh_token":"must-not-copy"}}',
        );
        yield* fs.writeFileString(path.join(wrongCodexHome, "config.toml"), 'model = "gpt-5.4"');

        yield* Effect.sync(() => {
          process.env.CODEX_HOME = wrongCodexHome;
          process.env.AZURE_OPENAI_API_KEY = "test-key";
        });

        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            codexHomePath: customCodexHome,
          })
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previousCodexHome === undefined) {
                  delete process.env.CODEX_HOME;
                } else {
                  process.env.CODEX_HOME = previousCodexHome;
                }

                if (previousAzureApiKey === undefined) {
                  delete process.env.AZURE_OPENAI_API_KEY;
                } else {
                  process.env.AZURE_OPENAI_API_KEY = previousAzureApiKey;
                }
              }),
            ),
          );

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );
});
