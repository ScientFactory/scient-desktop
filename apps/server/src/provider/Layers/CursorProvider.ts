import type { SDKModel, SDKUser } from "@cursor/sdk";
import type {
  CursorSettings,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { cursorSdkParameterPriority, cursorSdkProviderOptionId } from "../cursorSdkModel.ts";
import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  collectStreamAsString,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { cursorCliArgs } from "./CursorCli.ts";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";

// SCIENT-FORK:START
import {
  getCursorParameterizedModelPickerUnsupportedMessage,
  isCursorAboutJsonFormatUnsupported,
  parseCursorAboutOutput,
  parseCursorCliConfigChannel,
  parseCursorVersionDate,
  toTitleCaseWords,
  type CursorAboutResult,
} from "../../scient/providerLifecycle/cursorAbout.ts";
export {
  getCursorParameterizedModelPickerUnsupportedMessage,
  parseCursorAboutOutput,
  parseCursorCliConfigChannel,
  parseCursorVersionDate,
};
// SCIENT-FORK:END

// SCIENT-FORK:START
import { makeCursorCommandCatalog } from "../../scient/providerLifecycle/cursorCommandCatalog.ts";
export { makeCursorCommandCatalog };
// SCIENT-FORK:END

const CURSOR_PRESENTATION = {
  displayName: "Cursor",
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CURSOR_SDK_CATALOG_TIMEOUT_MS = 15_000;

export function buildInitialCursorProviderSnapshot(
  cursorSettings: CursorSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getCursorFallbackModels(cursorSettings);

    if (!cursorSettings.enabled) {
      return buildServerProvider({
        presentation: CURSOR_PRESENTATION,
        slashCommands: [COMPACT_SLASH_COMMAND],
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cursor is disabled in Scient settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      slashCommands: [COMPACT_SLASH_COMMAND],
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Cursor SDK availability...",
      },
    });
  });
}

function getCursorFallbackModels(
  cursorSettings: Pick<CursorSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], cursorSettings.customModels, EMPTY_CAPABILITIES);
}

function cursorSdkDefaultParameterValue(model: SDKModel, parameterId: string): string | undefined {
  return model.variants
    ?.find((variant) => variant.isDefault)
    ?.params.find((parameter) => parameter.id === parameterId)?.value;
}

export function buildCursorCapabilitiesFromSdkModel(model: SDKModel): ModelCapabilities {
  const seen = new Set<string>();
  const optionDescriptors: Array<ProviderOptionDescriptor> = [];
  const parameters = (model.parameters ?? [])
    .map((parameter, index) => ({ parameter, index }))
    .toSorted(
      (left, right) =>
        cursorSdkParameterPriority(left.parameter.id) -
          cursorSdkParameterPriority(right.parameter.id) || left.index - right.index,
    );
  for (const { parameter } of parameters) {
    const nativeId = parameter.id.trim();
    const id = cursorSdkProviderOptionId(nativeId);
    if (!nativeId || !id || seen.has(id)) {
      continue;
    }
    seen.add(id);

    const values = parameter.values.flatMap((entry) => {
      const value = entry.value.trim();
      if (!value) {
        return [];
      }
      return [
        {
          value,
          label: entry.displayName?.trim() || value,
        },
      ];
    });
    if (values.length === 0) {
      continue;
    }

    // SCIENT-FORK:START
    const label = parameter.displayName?.trim() || toTitleCaseWords(id);
    // SCIENT-FORK:END
    const defaultValue = cursorSdkDefaultParameterValue(model, nativeId);
    const normalizedValues = new Set(values.map((entry) => entry.value.toLowerCase()));
    if (values.length === 2 && normalizedValues.has("true") && normalizedValues.has("false")) {
      if (defaultValue === "true" || defaultValue === "false") {
        optionDescriptors.push(
          buildBooleanOptionDescriptor({
            id,
            label,
            currentValue: defaultValue === "true",
          }),
        );
      } else {
        optionDescriptors.push(buildBooleanOptionDescriptor({ id, label }));
      }
      continue;
    }

    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id,
        label,
        options: values.map((entry) => ({
          ...entry,
          ...(entry.value === defaultValue ? { isDefault: true } : {}),
        })),
      }),
    );
  }

  return createModelCapabilities({ optionDescriptors });
}

export function buildCursorDiscoveredModelsFromSdk(
  models: ReadonlyArray<SDKModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return models.flatMap((model) => {
    const slug = model.id.trim();
    const name = model.displayName.trim();
    if (!slug || !name || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name,
        isCustom: false,
        capabilities: buildCursorCapabilitiesFromSdkModel(model),
      } satisfies ServerProviderModel,
    ];
  });
}

function cursorSdkAuth(user: SDKUser, type: "api-key" | "browser"): ServerProviderAuth {
  const email = user.userEmail?.trim();
  const apiKeyName = user.apiKeyName.trim();
  return {
    status: "authenticated",
    type,
    label:
      type === "browser"
        ? "Cursor account"
        : apiKeyName
          ? `Cursor API key (${apiKeyName})`
          : "Cursor API key",
    ...(email ? { email } : {}),
  };
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts: Array<string> = [];
  for (const message of messages) {
    const trimmed = message?.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

const runCursorCommand = (
  cursorSettings: CursorSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawnCommand = yield* resolveSpawnCommand(
      cursorSettings.binaryPath || "cursor-agent",
      cursorCliArgs(args, environment),
      environment ? { env: environment } : {},
    );
    const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      ...(environment ? { env: environment, extendEnv: false } : { extendEnv: true }),
      shell: spawnCommand.shell,
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const runCursorAboutCommand = (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const jsonResult = yield* runCursorCommand(
      cursorSettings,
      ["about", "--format", "json"],
      environment,
    );
    // SCIENT-FORK:START
    if (!isCursorAboutJsonFormatUnsupported(jsonResult)) {
      return jsonResult;
    }
    // SCIENT-FORK:END
    return yield* runCursorCommand(cursorSettings, ["about"], environment);
  });

export function buildCursorProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly cursorSettings: CursorSettings;
  readonly parsed: CursorAboutResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    presentation: CURSOR_PRESENTATION,
    slashCommands: [COMPACT_SLASH_COMMAND],
    enabled: input.cursorSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      input.cursorSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

export const checkCursorProviderStatus = Effect.fn("checkCursorProviderStatus")(function* (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
  authenticationType: "api-key" | "browser" = "api-key",
): Effect.fn.Return<ServerProviderDraft, never, CursorSdkCatalog.CursorSdkCatalog> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getCursorFallbackModels(cursorSettings);

  if (!cursorSettings.enabled) {
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      slashCommands: [COMPACT_SLASH_COMMAND],
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cursor is disabled in Scient settings.",
      },
    });
  }

  const sdkApiKey = environment?.CURSOR_API_KEY?.trim();
  if (!sdkApiKey) {
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      slashCommands: [COMPACT_SLASH_COMMAND],
      enabled: cursorSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Sign in with Cursor or add CURSOR_API_KEY in provider settings.",
      },
    });
  }

  const sdkCatalog = yield* CursorSdkCatalog.CursorSdkCatalog;
  const catalogResult = yield* sdkCatalog
    .read(sdkApiKey)
    .pipe(Effect.timeoutOption(CURSOR_SDK_CATALOG_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(catalogResult)) {
    yield* Effect.logWarning("Cursor SDK catalog probe failed", {
      cause: catalogResult.failure.cause,
    });
    const authenticationFailure = catalogResult.failure.authenticationFailure;
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      slashCommands: [COMPACT_SLASH_COMMAND],
      enabled: cursorSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: authenticationFailure ? "unauthenticated" : "unknown" },
        message: authenticationFailure
          ? authenticationType === "browser"
            ? "Cursor sign-in expired or was rejected. Sign in again in provider settings."
            : "Cursor SDK authentication failed. Check CURSOR_API_KEY."
          : "Cursor SDK catalog request failed. Check server logs for details.",
      },
    });
  }

  if (Option.isNone(catalogResult.success)) {
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      slashCommands: [COMPACT_SLASH_COMMAND],
      enabled: cursorSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Cursor SDK catalog request timed out after ${CURSOR_SDK_CATALOG_TIMEOUT_MS}ms.`,
      },
    });
  }

  const snapshot = catalogResult.success.value;
  const discoveredModels = buildCursorDiscoveredModelsFromSdk(snapshot.models);
  return buildCursorProviderSnapshot({
    checkedAt,
    cursorSettings,
    parsed: {
      version: null,
      status: "ready",
      auth: cursorSdkAuth(snapshot.user, authenticationType),
    },
    discoveredModels,
    ...(discoveredModels.length === 0
      ? { discoveryWarning: "Cursor SDK model discovery returned no built-in models." }
      : {}),
  });
});
