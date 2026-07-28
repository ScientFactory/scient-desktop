import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "@synara/contracts";
import { sanitizeGeneratedThreadTitle } from "@synara/shared/chatThreads";
import { resolveCodexHome } from "@synara/shared/codexConfig";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@synara/shared/git";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildCodexProcessEnv } from "../../codexProcessEnv.ts";
import { ServerConfig } from "../../config.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  CodexTextGeneration,
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type DiffSummaryGenerationResult,
  type PrContentGenerationResult,
  type ThreadTitleGenerationResult,
  type ThreadRecapGenerationResult,
  type TextGenerationOperation,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildAutomationIntentPrompt,
  buildAutomationCompletionEvaluationPrompt,
  buildCommitMessagePrompt,
  buildDiffSummaryPrompt,
  buildPrContentPrompt,
  buildThreadRecapPrompt,
  buildThreadTitlePrompt,
  sanitizeCommitSubjectForPolicy,
  sanitizeDiffSummary,
  sanitizeThreadRecap,
  sanitizePrTitle,
  toJsonSchemaObject,
} from "../textGenerationShared.ts";

const CODEX_REASONING_EFFORT = "low";
const CODEX_TIMEOUT_MS = 180_000;

function normalizeCodexError(
  binaryPath: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${binaryPath}`) ||
      lower.includes(`spawn ${binaryPath.toLowerCase()}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `Codex CLI (${binaryPath}) is required but not available.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: `${fallback}: ${error.message}`,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}

const SAFE_MODEL_PROVIDER_STRING_KEYS = [
  "name",
  "base_url",
  "env_key",
  "env_key_instructions",
  "wire_api",
] as const;
const SAFE_MODEL_PROVIDER_NUMBER_KEYS = [
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
  "websocket_connect_timeout_ms",
] as const;
const SAFE_MODEL_PROVIDER_BOOLEAN_KEYS = ["requires_openai_auth", "supports_websockets"] as const;
const SAFE_MODEL_PROVIDER_STRING_MAP_KEYS = ["query_params", "http_headers"] as const;

function isTomlTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeCodexConfigForTextGeneration(content: string): string {
  try {
    const parsed = parseToml(content);
    const selectedProvider = parsed.model_provider;
    if (typeof selectedProvider !== "string" || selectedProvider.trim().length === 0) return "";

    const providerTables = parsed.model_providers;
    const selectedProviderTable = isTomlTable(providerTables)
      ? providerTables[selectedProvider]
      : undefined;
    const sanitizedProvider: Record<string, unknown> = {};

    if (isTomlTable(selectedProviderTable)) {
      for (const key of SAFE_MODEL_PROVIDER_STRING_KEYS) {
        const value = selectedProviderTable[key];
        if (typeof value === "string") sanitizedProvider[key] = value;
      }
      for (const key of SAFE_MODEL_PROVIDER_NUMBER_KEYS) {
        const value = selectedProviderTable[key];
        if (typeof value === "number" && Number.isFinite(value)) sanitizedProvider[key] = value;
      }
      for (const key of SAFE_MODEL_PROVIDER_BOOLEAN_KEYS) {
        const value = selectedProviderTable[key];
        if (typeof value === "boolean") sanitizedProvider[key] = value;
      }
      for (const key of SAFE_MODEL_PROVIDER_STRING_MAP_KEYS) {
        const value = selectedProviderTable[key];
        if (!isTomlTable(value)) continue;
        const stringEntries = Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        );
        if (stringEntries.length > 0) sanitizedProvider[key] = Object.fromEntries(stringEntries);
      }
    }

    return stringifyToml({
      model_provider: selectedProvider,
      ...(Object.keys(sanitizedProvider).length > 0
        ? { model_providers: { [selectedProvider]: sanitizedProvider } }
        : {}),
    }).trimEnd();
  } catch {
    return "";
  }
}

export function selectCodexApiAuthForTextGeneration(content: string): string | null {
  const parsed = JSON.parse(content) as unknown;
  if (!isTomlTable(parsed)) return null;
  const apiKey = parsed.OPENAI_API_KEY;
  return typeof apiKey === "string" && apiKey.trim().length > 0
    ? JSON.stringify({ OPENAI_API_KEY: apiKey })
    : null;
}

function resolveCodexProviderEnvKey(content: string): string {
  try {
    const parsed = parseToml(content);
    const selectedProvider = parsed.model_provider;
    if (typeof selectedProvider !== "string" || selectedProvider.trim().length === 0) {
      return "OPENAI_API_KEY";
    }
    const providerTables = parsed.model_providers;
    const selectedProviderTable = isTomlTable(providerTables)
      ? providerTables[selectedProvider]
      : undefined;
    const envKey = isTomlTable(selectedProviderTable) ? selectedProviderTable.env_key : undefined;
    return typeof envKey === "string" && envKey.trim().length > 0
      ? envKey.trim()
      : "OPENAI_API_KEY";
  } catch {
    return "OPENAI_API_KEY";
  }
}

const makeCodexTextGeneration = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);

  type MaterializedImageAttachments = {
    readonly imagePaths: ReadonlyArray<string>;
  };

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    Effect.gen(function* () {
      let text = "";
      yield* Stream.runForEach(stream, (chunk) =>
        Effect.sync(() => {
          text += Buffer.from(chunk).toString("utf8");
        }),
      ).pipe(
        Effect.mapError((cause) =>
          normalizeCodexError("codex", operation, cause, "Failed to collect process output"),
        ),
      );
      return text;
    });

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

  const safeRemoveDirectory = (directoryPath: string): Effect.Effect<void, never> =>
    fileSystem.remove(directoryPath, { recursive: true }).pipe(Effect.catch(() => Effect.void));

  const preflightSourceControlWriting: TextGenerationShape["preflightSourceControlWriting"] =
    Effect.fn("CodexTextGeneration.preflightSourceControlWriting")(function* (input) {
      if (input.operations.length === 0) return;
      const operation = input.operations[0]!;
      const sourceHome =
        resolveCodexHomePath(input.codexHomePath, input.providerOptions) ??
        resolveCodexHome(process.env);
      const sourceConfig = yield* fileSystem
        .readFileString(path.join(sourceHome, "config.toml"))
        .pipe(Effect.catch(() => Effect.succeed("")));
      const sourceAuth = yield* fileSystem
        .readFileString(path.join(sourceHome, "auth.json"))
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const hasApiAuth =
        sourceAuth === null
          ? false
          : yield* Effect.try({
              try: () => selectCodexApiAuthForTextGeneration(sourceAuth) !== null,
              catch: (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to inspect Codex API authentication for source-control writing.",
                  cause,
                }),
            });
      const providerEnvKey = resolveCodexProviderEnvKey(sourceConfig);
      if (!hasApiAuth && !process.env[providerEnvKey]?.trim()) {
        return yield* new TextGenerationError({
          operation,
          detail:
            "Automatic isolated Codex writing requires API-key authentication. " +
            `Add ${providerEnvKey} or select another Git writer; ChatGPT OAuth remains with the interactive Codex runtime and is not copied.`,
        });
      }
    });

  const prepareIsolatedCodexRuntime = (
    operation: TextGenerationOperation,
    sourceHomePath?: string,
  ): Effect.Effect<
    {
      readonly homePath: string;
      readonly runtimeRootPath: string;
      readonly workingDirectory: string;
    },
    TextGenerationError
  > => {
    const sourceCodexHome = sourceHomePath?.trim() || resolveCodexHome(process.env);
    const isolatedRuntimeRootPath = path.join(
      tempDir,
      `synara-codex-runtime-${process.pid}-${randomUUID()}`,
    );
    const isolatedHomePath = path.join(isolatedRuntimeRootPath, "codex-home-overlay");
    const isolatedWorkingDirectory = path.join(isolatedRuntimeRootPath, "workspace");

    return Effect.gen(function* () {
      yield* fileSystem.makeDirectory(isolatedHomePath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to create isolated Codex home at ${isolatedHomePath}.`,
              cause,
            }),
        ),
      );
      yield* fileSystem.chmod(isolatedRuntimeRootPath, 0o700).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to secure isolated Codex runtime permissions.",
              cause,
            }),
        ),
      );
      yield* fileSystem.chmod(isolatedHomePath, 0o700).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to secure isolated Codex home permissions.",
              cause,
            }),
        ),
      );

      const sourceConfig = yield* fileSystem
        .readFileString(path.join(sourceCodexHome, "config.toml"))
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (sourceConfig !== null) {
        const isolatedConfigPath = path.join(isolatedHomePath, "config.toml");
        yield* fileSystem
          .writeFileString(isolatedConfigPath, sanitizeCodexConfigForTextGeneration(sourceConfig))
          .pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to copy Codex config for isolated text generation.",
                  cause,
                }),
            ),
          );
        yield* fileSystem.chmod(isolatedConfigPath, 0o600).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Failed to secure isolated Codex configuration permissions.",
                cause,
              }),
          ),
        );
      }

      const sourceAuth = yield* fileSystem
        .readFileString(path.join(sourceCodexHome, "auth.json"))
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (sourceAuth !== null) {
        const apiAuth = yield* Effect.try({
          try: () => selectCodexApiAuthForTextGeneration(sourceAuth),
          catch: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to parse Codex API authentication for isolated text generation.",
              cause,
            }),
        });
        if (apiAuth !== null) {
          const isolatedAuthPath = path.join(isolatedHomePath, "auth.json");
          yield* fileSystem.writeFileString(isolatedAuthPath, apiAuth).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to project Codex API auth for isolated text generation.",
                  cause,
                }),
            ),
          );
          yield* fileSystem.chmod(isolatedAuthPath, 0o600).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to secure isolated Codex authentication permissions.",
                  cause,
                }),
            ),
          );
        }
      }

      yield* fileSystem.makeDirectory(isolatedWorkingDirectory, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to create an isolated Codex text-generation workspace.",
              cause,
            }),
        ),
      );
      yield* fileSystem.chmod(isolatedWorkingDirectory, 0o700).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to secure isolated Codex workspace permissions.",
              cause,
            }),
        ),
      );

      return {
        homePath: isolatedHomePath,
        runtimeRootPath: isolatedRuntimeRootPath,
        workingDirectory: isolatedWorkingDirectory,
      };
    }).pipe(Effect.onError(() => safeRemoveDirectory(isolatedRuntimeRootPath)));
  };

  const materializeImageAttachments = (
    _operation: TextGenerationOperation,
    attachments: BranchNameGenerationInput["attachments"],
  ): Effect.Effect<MaterializedImageAttachments, TextGenerationError> =>
    Effect.gen(function* () {
      if (!attachments || attachments.length === 0) {
        return { imagePaths: [] };
      }

      const imagePaths: string[] = [];
      for (const attachment of attachments) {
        if (attachment.type !== "image") {
          continue;
        }

        const resolvedPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
          continue;
        }
        const fileInfo = yield* fileSystem
          .stat(resolvedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          continue;
        }
        imagePaths.push(resolvedPath);
      }
      return { imagePaths };
    });

  const runCodexJson = <S extends Schema.Top>({
    operation,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    cleanupPaths = [],
    codexHomePath,
    model,
    modelSelection,
    providerOptions,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    imagePaths?: ReadonlyArray<string>;
    cleanupPaths?: ReadonlyArray<string>;
    codexHomePath?: string;
    model?: string;
    modelSelection?: BranchNameGenerationInput["modelSelection"];
    providerOptions?: BranchNameGenerationInput["providerOptions"];
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const codexBinaryPath = resolveCodexBinaryPath(providerOptions);
      const resolvedCodexHomePath = resolveCodexHomePath(codexHomePath, providerOptions);
      const isolatedCodexRuntime = yield* Effect.acquireRelease(
        prepareIsolatedCodexRuntime(operation, resolvedCodexHomePath),
        (runtime) => safeRemoveDirectory(runtime.runtimeRootPath),
      );
      const schemaPath = path.join(isolatedCodexRuntime.runtimeRootPath, "output-schema.json");
      const outputPath = path.join(isolatedCodexRuntime.runtimeRootPath, "output.json");
      yield* fileSystem
        .writeFileString(schemaPath, JSON.stringify(toJsonSchemaObject(outputSchemaJson)))
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Failed to write the isolated Codex output schema.",
                cause,
              }),
          ),
        );
      yield* fileSystem.writeFileString(outputPath, "").pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to create the isolated Codex output file.",
              cause,
            }),
        ),
      );

      const runCodexCommand = Effect.gen(function* () {
        const env = yield* Effect.promise(() =>
          buildCodexProcessEnv({
            env: {
              ...process.env,
              SCIENT_HOME: isolatedCodexRuntime.runtimeRootPath,
            },
            homePath: isolatedCodexRuntime.homePath,
          }),
        );
        const args = [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--config",
          'approval_policy="never"',
          "--config",
          "features.shell_tool=false",
          "--config",
          "features.remote_plugin=false",
          "--config",
          "features.skill_mcp_dependency_install=false",
          "--config",
          "agents.enabled=false",
          "--config",
          "apps._default.enabled=false",
          "--config",
          'web_search="disabled"',
          "--config",
          "check_for_update_on_startup=false",
          "-s",
          "read-only",
          "--model",
          resolveCodexModel(model, modelSelection) ?? DEFAULT_GIT_TEXT_GENERATION_MODEL,
          "--config",
          `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ];
        const prepared = prepareWindowsSafeProcess(codexBinaryPath, args, {
          cwd: isolatedCodexRuntime.workingDirectory,
          env,
        });
        const command = ChildProcess.make(prepared.command, prepared.args, {
          cwd: isolatedCodexRuntime.workingDirectory,
          env,
          shell: prepared.shell,
          ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          stdin: {
            stream: Stream.make(new TextEncoder().encode(prompt)),
          },
        });

        const child = yield* commandSpawner
          .spawn(command)
          .pipe(
            Effect.mapError((cause) =>
              normalizeCodexError(
                codexBinaryPath,
                operation,
                cause,
                "Failed to spawn Codex CLI process",
              ),
            ),
          );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            readStreamAsString(operation, child.stdout),
            readStreamAsString(operation, child.stderr),
            child.exitCode.pipe(
              Effect.map((value) => Number(value)),
              Effect.mapError((cause) =>
                normalizeCodexError(
                  codexBinaryPath,
                  operation,
                  cause,
                  "Failed to read Codex CLI exit code",
                ),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );

        if (exitCode !== 0) {
          const stderrDetail = stderr.trim();
          const stdoutDetail = stdout.trim();
          const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
          return yield* new TextGenerationError({
            operation,
            detail:
              detail.length > 0
                ? `Codex CLI command failed: ${detail}`
                : `Codex CLI command failed with code ${exitCode}.`,
          });
        }
      });

      yield* runCodexCommand.pipe(
        Effect.scoped,
        Effect.timeoutOption(CODEX_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Codex CLI request timed out.",
                }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))),
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Codex returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.all(
          cleanupPaths.map((filePath) => safeUnlink(filePath)),
          {
            concurrency: "unbounded",
          },
        ).pipe(Effect.asVoid),
      ),
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) => {
    const wantsBranch = input.includeBranch === true;
    const { prompt, outputSchemaJson } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: wantsBranch,
      ...(input.policy ? { policy: input.policy } : {}),
    });

    return runCodexJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            subject: sanitizeCommitSubjectForPolicy(generated, input.policy),
            body: generated.body.trim(),
            ...("branch" in generated && typeof generated.branch === "string"
              ? { branch: sanitizeFeatureBranchName(generated.branch) }
              : {}),
          }) satisfies CommitMessageGenerationResult,
      ),
    );
  };

  const generatePrContent: TextGenerationShape["generatePrContent"] = (input) => {
    const { prompt, outputSchemaJson } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
      ...(input.policy ? { policy: input.policy } : {}),
      ...(input.pullRequestTemplate ? { pullRequestTemplate: input.pullRequestTemplate } : {}),
    });

    return runCodexJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            title: sanitizePrTitle(generated.title),
            body: generated.body.trim(),
          }) satisfies PrContentGenerationResult,
      ),
    );
  };

  const generateDiffSummary: TextGenerationShape["generateDiffSummary"] = (input) => {
    const { prompt, outputSchemaJson } = buildDiffSummaryPrompt({
      patch: input.patch,
    });

    return runCodexJson({
      operation: "generateDiffSummary",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            summary: sanitizeDiffSummary(generated.summary),
          }) satisfies DiffSummaryGenerationResult,
      ),
    );
  };

  const generateBranchName: TextGenerationShape["generateBranchName"] = (input) => {
    return Effect.gen(function* () {
      const { imagePaths } = yield* materializeImageAttachments(
        "generateBranchName",
        input.attachments,
      );
      const { prompt, outputSchemaJson } = buildBranchNamePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.policy ? { policy: input.policy } : {}),
      });

      const generated = yield* runCodexJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        imagePaths,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      } satisfies BranchNameGenerationResult;
    });
  };

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) => {
    return Effect.gen(function* () {
      const { imagePaths } = yield* materializeImageAttachments(
        "generateThreadTitle",
        input.attachments,
      );
      const { prompt, outputSchemaJson } = buildThreadTitlePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });

      const generated = yield* runCodexJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        imagePaths,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        title: sanitizeGeneratedThreadTitle(generated.title),
      } satisfies ThreadTitleGenerationResult;
    });
  };

  const generateThreadRecap: TextGenerationShape["generateThreadRecap"] = (input) => {
    const { prompt, outputSchemaJson } = buildThreadRecapPrompt({
      ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
      newMaterial: input.newMaterial,
      ...(input.currentState ? { currentState: input.currentState } : {}),
    });

    return runCodexJson({
      operation: "generateThreadRecap",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            recap: sanitizeThreadRecap(generated.recap, input.previousRecap),
          }) satisfies ThreadRecapGenerationResult,
      ),
    );
  };

  const generateAutomationIntent: TextGenerationShape["generateAutomationIntent"] = (input) => {
    const { prompt, outputSchemaJson } = buildAutomationIntentPrompt({
      message: input.message,
      ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
      nowIso: input.nowIso,
    });

    return runCodexJson({
      operation: "generateAutomationIntent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
  };

  const evaluateAutomationCompletion: TextGenerationShape["evaluateAutomationCompletion"] = (
    input,
  ) => {
    const { prompt, outputSchemaJson } = buildAutomationCompletionEvaluationPrompt(input);

    return runCodexJson({
      operation: "evaluateAutomationCompletion",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
  };

  return {
    preflightSourceControlWriting,
    generateCommitMessage,
    generatePrContent,
    generateDiffSummary,
    generateBranchName,
    generateThreadTitle,
    generateThreadRecap,
    generateAutomationIntent,
    evaluateAutomationCompletion,
  } satisfies TextGenerationShape;
});

function resolveCodexBinaryPath(
  providerOptions: BranchNameGenerationInput["providerOptions"] | undefined,
): string {
  return providerOptions?.codex?.binaryPath?.trim() || "codex";
}

function resolveCodexHomePath(
  codexHomePath: string | undefined,
  providerOptions: BranchNameGenerationInput["providerOptions"] | undefined,
): string | undefined {
  const resolved = codexHomePath?.trim() || providerOptions?.codex?.homePath?.trim();
  return resolved && resolved.length > 0 ? resolved : undefined;
}

function resolveCodexModel(
  model: string | undefined,
  modelSelection: BranchNameGenerationInput["modelSelection"] | undefined,
): string | undefined {
  if (modelSelection?.provider === "codex") {
    return modelSelection.model;
  }
  return model;
}

export const CodexTextGenerationServiceLive = Layer.effect(
  CodexTextGeneration,
  makeCodexTextGeneration,
);

export const CodexTextGenerationLive = Layer.effect(TextGeneration, makeCodexTextGeneration);
