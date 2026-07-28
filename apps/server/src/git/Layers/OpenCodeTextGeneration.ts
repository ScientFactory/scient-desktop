// FILE: OpenCodeTextGeneration.ts
// Purpose: Runs OpenCode-compatible one-shot text generation for titles, branches, recaps, and release text.
// Layer: Server git/text-generation adapter
// Depends on: OpenCode SDK runtime, prompt builders, attachment projection, and server config.

import { homedir } from "node:os";

import { Effect, Exit, Fiber, FileSystem, Layer, Path, Schema, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import type {
  ChatAttachment,
  KiloModelSelection,
  OpenCodeModelSelection,
  OpenCodeModelOptions,
  ProviderStartOptions,
} from "@synara/contracts";
import { sanitizeGeneratedThreadTitle } from "@synara/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@synara/shared/git";
import { getModelSelectionStringOptionValue } from "@synara/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../../provider/attachmentProjection.ts";
import {
  OpenCodeRuntime,
  KILO_CLI_SPEC,
  OPENCODE_CLI_SPEC,
  type OpenCodeCompatibleCliSpec,
  type OpenCodeServerConnection,
  type OpenCodeServerProcess,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  resolveOpenCodeAuthFilePath,
  toOpenCodeFileParts,
} from "../../provider/opencodeRuntime.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  type TextGenerationOperation,
  type TextGenerationShape,
  KiloTextGeneration,
  OpenCodeTextGeneration,
} from "../Services/TextGeneration.ts";
import {
  buildAutomationIntentPrompt,
  buildAutomationCompletionEvaluationPrompt,
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildDiffSummaryPrompt,
  buildPrContentPrompt,
  buildThreadRecapPrompt,
  buildThreadTitlePrompt,
  decodeStructuredTextGenerationOutput,
  type RawTextFallback,
  sanitizeCommitSubjectForPolicy,
  sanitizeDiffSummary,
  sanitizeThreadRecap,
  sanitizePrTitle,
} from "../textGenerationShared.ts";

const OPENCODE_TEXT_GENERATION_IDLE_TTL = "30 seconds";
const SCM_TEXT_GENERATION_OPERATIONS = new Set<TextGenerationOperation>([
  "generateCommitMessage",
  "generatePrContent",
  "generateDiffSummary",
  "generateBranchName",
]);

function sanitizeOpenCodeAuthFile(content: string): string {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "{}";
  }

  const sanitized: Record<string, unknown> = {};
  for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const credential = value as Record<string, unknown>;
    if (
      credential.type === "oauth" &&
      typeof credential.refresh === "string" &&
      typeof credential.access === "string" &&
      typeof credential.expires === "number"
    ) {
      sanitized[providerId] = {
        type: "oauth",
        refresh: credential.refresh,
        access: credential.access,
        expires: credential.expires,
        ...(typeof credential.accountId === "string" ? { accountId: credential.accountId } : {}),
        ...(typeof credential.enterpriseUrl === "string"
          ? { enterpriseUrl: credential.enterpriseUrl }
          : {}),
      };
      continue;
    }

    if (credential.type === "api" && typeof credential.key === "string") {
      const metadata =
        credential.metadata &&
        typeof credential.metadata === "object" &&
        !Array.isArray(credential.metadata)
          ? Object.fromEntries(
              Object.entries(credential.metadata as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : null;
      sanitized[providerId] = {
        type: "api",
        key: credential.key,
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
      };
    }

    // `wellknown` credentials can load remote organization configuration, so the
    // automatic writer deliberately excludes them from its auth-only overlay.
  }

  return JSON.stringify(sanitized);
}

function getOpenCodePromptErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return message;
  }

  if ("name" in error && typeof error.name === "string") {
    const name = error.name.trim();
    return name.length > 0 ? name : null;
  }

  return null;
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      if (!("type" in part) || part.type !== "text") {
        return [];
      }
      if (!("text" in part) || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("")
    .trim();
}

interface SharedOpenCodeTextGenerationServerState {
  server: OpenCodeServerProcess | null;
  serverScope: Scope.Closeable | null;
  binaryPath: string | null;
  clientDirectory: string | null;
  runtimeRoot: string | null;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

interface AcquiredOpenCodeTextGenerationServer {
  server: OpenCodeServerProcess;
  shared: boolean;
  serverScope: Scope.Closeable | null;
  clientDirectory: string;
  runtimeRoot: string;
}

type OpenCodeCompatibleTextGenerationProvider = "opencode" | "kilo";
type OpenCodeCompatibleModelSelection = OpenCodeModelSelection | KiloModelSelection;

interface OpenCodeCompatibleTextGenerationConfig {
  readonly provider: OpenCodeCompatibleTextGenerationProvider;
  readonly displayName: string;
  readonly serviceName: string;
  readonly cliSpec: OpenCodeCompatibleCliSpec;
}

function resolveOpenCodeCompatibleModelSelection(
  config: OpenCodeCompatibleTextGenerationConfig,
  input: {
    readonly model?: string;
    readonly modelSelection?: {
      provider: string;
      model: string;
      options?: unknown;
    };
  },
): OpenCodeCompatibleModelSelection | null {
  if (input.modelSelection?.provider === config.provider) {
    return input.modelSelection as OpenCodeCompatibleModelSelection;
  }

  const model = input.model?.trim();
  if (config.provider !== "opencode" || !model || parseOpenCodeModelSlug(model) === null) {
    return null;
  }

  return {
    provider: "opencode",
    model,
  };
}

const makeOpenCodeCompatibleTextGeneration = (config: OpenCodeCompatibleTextGenerationConfig) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hardenedInlineConfig = JSON.stringify({
      autoupdate: false,
      share: "disabled",
      snapshot: false,
      permission: { "*": "deny" },
      tools: {
        bash: false,
        edit: false,
        write: false,
        webfetch: false,
        websearch: false,
        codesearch: false,
      },
      mcp: {},
      plugin: [],
      agent: {},
      command: {},
      instructions: [],
    });
    const externalClientRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: `scient-${config.provider}-external-writer-`,
    });
    const externalClientDirectory = path.join(externalClientRoot, "workspace");
    yield* fileSystem.makeDirectory(externalClientDirectory, {
      recursive: true,
    });
    if (process.platform !== "win32") {
      yield* Effect.all(
        [externalClientRoot, externalClientDirectory].map((directory) =>
          fileSystem.chmod(directory, 0o700),
        ),
        { concurrency: "unbounded" },
      );
    }

    const prepareManagedWriterRuntime = (
      operation: TextGenerationOperation,
      serverScope: Scope.Closeable,
    ) =>
      Effect.gen(function* () {
        const runtimeRoot = yield* fileSystem.makeTempDirectory({
          prefix: `scient-${config.provider}-writer-`,
        });
        yield* Scope.addFinalizer(
          serverScope,
          fileSystem.remove(runtimeRoot, { recursive: true }).pipe(Effect.catch(() => Effect.void)),
        );
        const workingDirectory = path.join(runtimeRoot, "workspace");
        const configHome = path.join(runtimeRoot, "config");
        const configDirectory = path.join(runtimeRoot, "config-directory");
        const dataHome = path.join(runtimeRoot, "data");
        const cacheHome = path.join(runtimeRoot, "cache");
        const stateHome = path.join(runtimeRoot, "state");
        const claudeConfigDirectory = path.join(runtimeRoot, "claude-config");
        const providerDataDirectory = path.join(dataHome, config.cliSpec.dataDirectoryName);
        yield* Effect.all(
          [
            workingDirectory,
            configHome,
            configDirectory,
            providerDataDirectory,
            cacheHome,
            stateHome,
            claudeConfigDirectory,
          ].map((directory) => fileSystem.makeDirectory(directory, { recursive: true })),
          { concurrency: "unbounded" },
        );
        if (process.platform !== "win32") {
          yield* Effect.all(
            [
              runtimeRoot,
              workingDirectory,
              configHome,
              configDirectory,
              dataHome,
              providerDataDirectory,
              cacheHome,
              stateHome,
              claudeConfigDirectory,
            ].map((directory) => fileSystem.chmod(directory, 0o700)),
            { concurrency: "unbounded" },
          );
        }

        const sourceAuthPath = resolveOpenCodeAuthFilePath({ home: homedir() }, config.cliSpec);
        const sourceAuth = yield* fileSystem
          .readFileString(sourceAuthPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (sourceAuth !== null) {
          const isolatedAuthPath = path.join(providerDataDirectory, "auth.json");
          const sanitizedAuth = yield* Effect.try({
            try: () => sanitizeOpenCodeAuthFile(sourceAuth),
            catch: (cause) =>
              new TextGenerationError({
                operation,
                detail: `Failed to parse ${config.displayName} credentials for isolated text generation.`,
                cause,
              }),
          });
          yield* fileSystem.writeFileString(isolatedAuthPath, sanitizedAuth);
          if (process.platform !== "win32") {
            yield* fileSystem.chmod(isolatedAuthPath, 0o600);
          }
        }

        const configPath = path.join(configHome, "opencode.json");
        yield* fileSystem.writeFileString(configPath, hardenedInlineConfig);
        if (process.platform !== "win32") {
          yield* fileSystem.chmod(configPath, 0o600);
        }
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.OPENCODE_CONFIG;
        delete env.OPENCODE_CONFIG_DIR;
        delete env.OPENCODE_CONFIG_CONTENT;
        delete env.KILO_CONFIG;
        delete env.KILO_CONFIG_DIR;
        delete env.KILO_CONFIG_CONTENT;
        delete env.OPENCODE_ENABLE_EXA;
        delete env.OPENCODE_EXPERIMENTAL;
        delete env.OPENCODE_EXPERIMENTAL_LSP_TOOL;
        delete env.OPENCODE_EXPERIMENTAL_WEBSOCKETS;
        env.XDG_CONFIG_HOME = configHome;
        env.XDG_DATA_HOME = dataHome;
        env.XDG_CACHE_HOME = cacheHome;
        env.XDG_STATE_HOME = stateHome;
        env.APPDATA = dataHome;
        env.CLAUDE_CONFIG_DIR = claudeConfigDirectory;
        env.OPENCODE_CONFIG = configPath;
        env.OPENCODE_CONFIG_DIR = configDirectory;
        env[config.cliSpec.configContentEnvVar] = hardenedInlineConfig;
        env.OPENCODE_AUTO_SHARE = "false";
        env.OPENCODE_DISABLE_AUTOUPDATE = "1";
        env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
        env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
        env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
        env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1";
        env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
        env.OPENCODE_EXPERIMENTAL_WEBSOCKETS = "false";
        env.OPENCODE_PURE = "1";
        env.KILO_DISABLE_DEFAULT_PLUGINS = "1";
        env.KILO_DISABLE_CODEBASE_INDEXING = "vscode-no-workspace";
        env.KILO_PURE = "1";
        return { runtimeRoot, workingDirectory, env };
      }).pipe(
        Effect.provideService(Scope.Scope, serverScope),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to prepare isolated ${config.displayName} text-generation runtime.`,
              cause,
            }),
        ),
      );
    const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const sharedServerMutex = yield* Semaphore.make(1);
    const sharedServerState: SharedOpenCodeTextGenerationServerState = {
      server: null,
      serverScope: null,
      binaryPath: null,
      clientDirectory: null,
      runtimeRoot: null,
      activeRequests: 0,
      idleCloseFiber: null,
    };

    const closeSharedServer = Effect.fn("closeSharedServer")(function* () {
      const scope = sharedServerState.serverScope;
      const runtimeRoot = sharedServerState.runtimeRoot;
      sharedServerState.server = null;
      sharedServerState.serverScope = null;
      sharedServerState.binaryPath = null;
      sharedServerState.clientDirectory = null;
      sharedServerState.runtimeRoot = null;
      if (scope !== null) {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      }
      if (runtimeRoot !== null) {
        yield* fileSystem
          .remove(runtimeRoot, { recursive: true })
          .pipe(Effect.catch(() => Effect.void));
      }
    });

    const cancelIdleCloseFiber = Effect.fn("cancelIdleCloseFiber")(function* () {
      const idleCloseFiber = sharedServerState.idleCloseFiber;
      sharedServerState.idleCloseFiber = null;
      if (idleCloseFiber !== null) {
        yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
      }
    });

    const scheduleIdleClose = Effect.fn("scheduleIdleClose")(function* (
      server: OpenCodeServerProcess,
    ) {
      yield* cancelIdleCloseFiber();
      const fiber = yield* Effect.sleep(OPENCODE_TEXT_GENERATION_IDLE_TTL).pipe(
        Effect.andThen(
          sharedServerMutex.withPermit(
            Effect.gen(function* () {
              if (sharedServerState.server !== server || sharedServerState.activeRequests > 0) {
                return;
              }
              sharedServerState.idleCloseFiber = null;
              yield* closeSharedServer();
            }),
          ),
        ),
        Effect.forkIn(idleFiberScope),
      );
      sharedServerState.idleCloseFiber = fiber;
    });

    const acquireSharedServer = (input: {
      readonly binaryPath: string;
      readonly operation: TextGenerationOperation;
    }) =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          yield* cancelIdleCloseFiber();

          const startServer = Effect.fn("startOpenCodeTextGenerationServer")(function* () {
            const serverScope = yield* Scope.make();
            const isolatedRuntimeExit = yield* Effect.exit(
              prepareManagedWriterRuntime(input.operation, serverScope),
            );
            if (isolatedRuntimeExit._tag === "Failure") {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(isolatedRuntimeExit.cause);
            }
            const isolatedRuntime = isolatedRuntimeExit.value;
            const startedExit = yield* Effect.exit(
              openCodeRuntime
                .startOpenCodeServerProcess({
                  binaryPath: input.binaryPath,
                  cliSpec: config.cliSpec,
                  cwd: isolatedRuntime.workingDirectory,
                  env: isolatedRuntime.env,
                })
                .pipe(
                  Effect.provideService(Scope.Scope, serverScope),
                  Effect.mapError(
                    (cause) =>
                      new TextGenerationError({
                        operation: input.operation,
                        detail: openCodeRuntimeErrorDetail(cause),
                        cause,
                      }),
                  ),
                ),
            );

            if (startedExit._tag === "Failure") {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(startedExit.cause);
            }

            return {
              server: startedExit.value,
              serverScope,
              clientDirectory: isolatedRuntime.workingDirectory,
              runtimeRoot: isolatedRuntime.runtimeRoot,
            };
          });

          const existingServer = sharedServerState.server;
          if (existingServer !== null) {
            const sameConfigScope = sharedServerState.binaryPath === input.binaryPath;
            if (!sameConfigScope && sharedServerState.activeRequests === 0) {
              yield* closeSharedServer();
            } else {
              if (!sameConfigScope) {
                yield* Effect.logWarning(
                  `${config.displayName} shared server config scope mismatch: requested ` +
                    input.binaryPath +
                    " but active server uses " +
                    sharedServerState.binaryPath +
                    "; starting a dedicated server for this request",
                );
                const dedicated = yield* startServer();
                return {
                  server: dedicated.server,
                  shared: false,
                  serverScope: dedicated.serverScope,
                  clientDirectory: dedicated.clientDirectory,
                  runtimeRoot: dedicated.runtimeRoot,
                } satisfies AcquiredOpenCodeTextGenerationServer;
              }
              sharedServerState.activeRequests += 1;
              return {
                server: existingServer,
                shared: true,
                serverScope: null,
                clientDirectory: sharedServerState.clientDirectory!,
                runtimeRoot: sharedServerState.runtimeRoot!,
              } satisfies AcquiredOpenCodeTextGenerationServer;
            }
          }

          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const { server, serverScope, clientDirectory, runtimeRoot } =
                yield* restore(startServer());
              sharedServerState.server = server;
              sharedServerState.serverScope = serverScope;
              sharedServerState.binaryPath = input.binaryPath;
              sharedServerState.clientDirectory = clientDirectory;
              sharedServerState.runtimeRoot = runtimeRoot;
              sharedServerState.activeRequests = 1;
              return {
                server,
                shared: true,
                serverScope: null,
                clientDirectory,
                runtimeRoot,
              } satisfies AcquiredOpenCodeTextGenerationServer;
            }),
          );
        }),
      );

    const releaseSharedServer = (acquired: AcquiredOpenCodeTextGenerationServer) =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          if (!acquired.shared) {
            if (acquired.serverScope !== null) {
              yield* Scope.close(acquired.serverScope, Exit.void).pipe(Effect.ignore);
            }
            yield* fileSystem
              .remove(acquired.runtimeRoot, { recursive: true })
              .pipe(Effect.catch(() => Effect.void));
            return;
          }
          if (sharedServerState.server !== acquired.server) {
            return;
          }
          sharedServerState.activeRequests = Math.max(0, sharedServerState.activeRequests - 1);
          if (sharedServerState.activeRequests === 0) {
            yield* scheduleIdleClose(acquired.server);
          }
        }),
      );

    yield* Effect.addFinalizer(() =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          yield* cancelIdleCloseFiber();
          sharedServerState.activeRequests = 0;
          yield* closeSharedServer();
        }),
      ),
    );

    const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
      readonly operation: TextGenerationOperation;
      readonly cwd: string;
      readonly prompt: string;
      readonly outputSchemaJson: S;
      readonly rawTextFallback?: RawTextFallback;
      readonly modelSelection: OpenCodeCompatibleModelSelection;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
      readonly providerOptions?: ProviderStartOptions;
    }) {
      const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
      if (!parsedModel) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: `${config.displayName} model selection must use the 'provider/model' format.`,
        });
      }

      const providerOptions = input.providerOptions?.[config.provider];
      const binaryPath = providerOptions?.binaryPath?.trim() || config.cliSpec.defaultBinaryPath;
      const serverUrl = providerOptions?.serverUrl?.trim() || "";
      const serverPassword = providerOptions?.serverPassword?.trim() || "";
      if (serverUrl.length > 0 && SCM_TEXT_GENERATION_OPERATIONS.has(input.operation)) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            `Configured external ${config.displayName} servers are not permitted for automatic ` +
            "source-control writing because Scient cannot verify their sharing or extension policy.",
        });
      }
      const providerId = parsedModel.providerID;
      const modelId = parsedModel.modelID;
      const modelOptions = input.modelSelection.options as OpenCodeModelOptions | undefined;
      const agent = modelOptions?.agent?.trim();
      const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant")?.trim();

      const promptText =
        appendFileAttachmentsPromptBlock({
          text: input.prompt,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        }) ?? input.prompt;
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });

      const runAgainstServer = (server: {
        readonly url: string;
        readonly clientDirectory: string;
      }) =>
        Effect.tryPromise({
          try: async () => {
            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: server.clientDirectory,
              ...(serverPassword.length > 0 ? { serverPassword } : {}),
              cliSpec: config.cliSpec,
            });
            const sessionCreateInput = {
              title: `Scient ${input.operation}`,
              model: {
                providerID: providerId,
                id: modelId,
                ...(variant ? { variant } : {}),
              },
              ...(agent ? { agent } : {}),
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            };
            const session = await client.session.create(
              sessionCreateInput as unknown as Parameters<typeof client.session.create>[0],
            );
            if (!session.data) {
              throw new Error("OpenCode session.create returned no session payload.");
            }

            const result = await client.session.prompt({
              sessionID: session.data.id,
              model: parsedModel,
              ...(agent ? { agent } : {}),
              ...(variant ? { variant } : {}),
              parts: [{ type: "text", text: promptText }, ...fileParts],
            });
            const info = result.data?.info;
            const errorMessage = getOpenCodePromptErrorMessage(info?.error);
            if (errorMessage) {
              throw new Error(errorMessage);
            }
            const rawText = getOpenCodeTextResponse(result.data?.parts);
            if (rawText.length === 0) {
              throw new Error("OpenCode returned empty output.");
            }
            return rawText;
          },
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: [
                openCodeRuntimeErrorDetail(cause),
                `model=${providerId}/${modelId}`,
                variant ? `variant=${variant}` : null,
                agent ? `agent=${agent}` : null,
                serverUrl.length > 0 ? "server=external" : "server=managed",
              ]
                .filter(Boolean)
                .join(" "),
              cause,
            }),
        });

      yield* Effect.logDebug("OpenCode text generation request", {
        operation: input.operation,
        cwd: input.cwd,
        providerId,
        modelId,
        variant,
        agent,
        attachmentCount: input.attachments?.length ?? 0,
        filePartCount: fileParts.length,
        binaryPath,
        usingExternalServer: serverUrl.length > 0,
      });

      const rawOutput =
        serverUrl.length > 0
          ? yield* runAgainstServer({
              url: serverUrl,
              clientDirectory: externalClientDirectory,
            })
          : yield* Effect.acquireUseRelease(
              acquireSharedServer({
                binaryPath,
                operation: input.operation,
              }),
              (acquired) =>
                runAgainstServer({
                  url: acquired.server.url,
                  clientDirectory: acquired.clientDirectory,
                }),
              releaseSharedServer,
            );

      return yield* decodeStructuredTextGenerationOutput({
        schema: input.outputSchemaJson,
        raw: rawOutput,
        operation: input.operation,
        providerLabel: config.displayName,
        ...(input.rawTextFallback ? { rawTextFallback: input.rawTextFallback } : {}),
      });
    });

    const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
      `${config.serviceName}.generateCommitMessage`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateCommitMessage",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        ...(input.policy ? { policy: input.policy } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        subject: sanitizeCommitSubjectForPolicy(generated, input.policy),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

    const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
      `${config.serviceName}.generatePrContent`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generatePrContent",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        ...(input.policy ? { policy: input.policy } : {}),
        ...(input.pullRequestTemplate ? { pullRequestTemplate: input.pullRequestTemplate } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

    const generateDiffSummary: TextGenerationShape["generateDiffSummary"] = Effect.fn(
      `${config.serviceName}.generateDiffSummary`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateDiffSummary",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildDiffSummaryPrompt({
        patch: input.patch,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateDiffSummary",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        summary: sanitizeDiffSummary(generated.summary),
      };
    });

    const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
      `${config.serviceName}.generateBranchName`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateBranchName",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildBranchNamePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.policy ? { policy: input.policy } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

    const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
      `${config.serviceName}.generateThreadTitle`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildThreadTitlePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        title: sanitizeGeneratedThreadTitle(generated.title),
      };
    });

    const generateThreadRecap: TextGenerationShape["generateThreadRecap"] = Effect.fn(
      `${config.serviceName}.generateThreadRecap`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateThreadRecap",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildThreadRecapPrompt({
        ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
        newMaterial: input.newMaterial,
        ...(input.currentState ? { currentState: input.currentState } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadRecap",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        recap: sanitizeThreadRecap(generated.recap, input.previousRecap),
      };
    });

    const generateAutomationIntent: TextGenerationShape["generateAutomationIntent"] = Effect.fn(
      `${config.serviceName}.generateAutomationIntent`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateAutomationIntent",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson } = buildAutomationIntentPrompt({
        message: input.message,
        ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
        nowIso: input.nowIso,
      });
      return yield* runOpenCodeJson({
        operation: "generateAutomationIntent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });
    });

    const evaluateAutomationCompletion: TextGenerationShape["evaluateAutomationCompletion"] =
      Effect.fn(`${config.serviceName}.evaluateAutomationCompletion`)(function* (input) {
        const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
        if (!modelSelection) {
          return yield* new TextGenerationError({
            operation: "evaluateAutomationCompletion",
            detail: `Invalid ${config.displayName} model selection.`,
          });
        }

        const { prompt, outputSchemaJson } = buildAutomationCompletionEvaluationPrompt(input);
        return yield* runOpenCodeJson({
          operation: "evaluateAutomationCompletion",
          cwd: input.cwd,
          prompt,
          outputSchemaJson,
          modelSelection,
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        });
      });

    return {
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

export const OpenCodeTextGenerationServiceLive = Layer.effect(
  OpenCodeTextGeneration,
  makeOpenCodeCompatibleTextGeneration({
    provider: "opencode",
    displayName: "OpenCode",
    serviceName: "OpenCodeTextGeneration",
    cliSpec: OPENCODE_CLI_SPEC,
  }),
);

export const KiloTextGenerationServiceLive = Layer.effect(
  KiloTextGeneration,
  makeOpenCodeCompatibleTextGeneration({
    provider: "kilo",
    displayName: "Kilo",
    serviceName: "KiloTextGeneration",
    cliSpec: KILO_CLI_SPEC,
  }),
);
