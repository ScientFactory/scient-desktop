import type { SDKModel, SDKUser } from "@cursor/sdk";
import type {
  CursorSettings,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  createModelCapabilities,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";
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
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";

/** Session command catalogs stay scoped to their workspace across health refreshes. */
export const makeCursorCommandCatalog = Effect.fn("makeCursorCommandCatalog")(function* (
  provider: ServerProviderShape,
) {
  const workspaces = yield* SubscriptionRef.make<NonNullable<ServerProvider["workspaceSnapshots"]>>(
    [],
  );
  const getSnapshot = Effect.all([provider.getSnapshot, SubscriptionRef.get(workspaces)]).pipe(
    Effect.map(([snapshot, workspaceSnapshots]) =>
      workspaceSnapshots.length > 0 ? { ...snapshot, workspaceSnapshots } : snapshot,
    ),
  );
  const snapshotForCwd = Effect.fn("CursorCommandCatalog.snapshotForCwd")(function* (
    cwd: string,
    skills: ServerProvider["skills"],
  ) {
    const machineSnapshot = yield* provider.getSnapshot;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) =>
      [
        ...entries.filter((entry) => entry.cwd !== cwd),
        {
          cwd,
          checkedAt,
          slashCommands:
            entries.find((entry) => entry.cwd === cwd)?.slashCommands ??
            machineSnapshot.slashCommands,
          skills,
        },
      ].slice(-16),
    );
    const snapshot = yield* getSnapshot;
    return {
      ...snapshot,
      checkedAt,
      slashCommands:
        snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.slashCommands ??
        snapshot.slashCommands,
      skills,
    };
  });
  const onAvailableCommands = Effect.fn("CursorCommandCatalog.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
    skills?: ServerProvider["skills"],
  ) {
    const seen = new Set([COMPACT_SLASH_COMMAND.name]);
    const slashCommands = [
      COMPACT_SLASH_COMMAND,
      ...commands.flatMap((command) => {
        const name = command.name.trim();
        if (!name || seen.has(name)) return [];
        seen.add(name);
        const description = command.description.trim();
        const hint = command.input?.hint.trim();
        return [
          {
            name,
            ...(description ? { description } : {}),
            ...(hint ? { input: { hint } } : {}),
          },
        ];
      }),
    ];
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) => {
      const previous = entries.find((entry) => entry.cwd === cwd);
      const currentSkills = skills ?? previous?.skills;
      if (currentSkills === undefined) return entries;
      return [
        ...entries.filter((entry) => entry.cwd !== cwd),
        { cwd, checkedAt, slashCommands, skills: currentSkills },
      ].slice(-16);
    });
  });
  return {
    onAvailableCommands,
    snapshotForCwd,
    snapshot: {
      ...provider,
      getSnapshot,
      refresh: provider.refresh.pipe(Effect.andThen(getSnapshot)),
      streamChanges: Stream.merge(
        provider.streamChanges.pipe(Stream.map(() => undefined)),
        SubscriptionRef.changes(workspaces).pipe(Stream.map(() => undefined)),
      ).pipe(Stream.mapEffect(() => getSnapshot)),
    } satisfies ServerProviderShape,
  };
});

const CURSOR_PRESENTATION = {
  displayName: "Cursor",
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE = 2026_04_08;
const CURSOR_SDK_CATALOG_TIMEOUT_MS = 15_000;

export const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

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

interface CursorSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<CursorSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies CursorSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies CursorSessionSelectOption,
        ),
  );
}

function normalizeCursorReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function getCursorConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isCursorEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findCursorEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isCursorEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getCursorConfigOptionCategory(option) === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getCursorConfigOptionCategory(option) === "thought_level") ??
    candidates[0]
  );
}

function isCursorContextConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function isCursorFastConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "fast" || name === "fast" || name.includes("fast mode");
}

function normalizeCursorConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function findCursorSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: CursorSessionSelectOption) => boolean,
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

function findCursorBooleanConfigValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!configOption) {
    return undefined;
  }
  if (configOption.type === "boolean") {
    return requested;
  }
  return findCursorSelectOptionValue(
    configOption,
    (option) => normalizeCursorConfigOptionToken(option.value) === String(requested),
  );
}

export function resolveCursorAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "default";
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

export function resolveCursorAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{
  readonly configId: string;
  readonly value: string | boolean;
}> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const updates: Array<{
    readonly configId: string;
    readonly value: string | boolean;
  }> = [];

  const reasoningOption = findCursorEffortConfigOption(configOptions);
  const requestedReasoning = normalizeCursorReasoningValue(
    getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (reasoningOption && requestedReasoning) {
    const value = findCursorSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeCursorReasoningValue(option.value);
      const normalizedName = normalizeCursorReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    });
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorContextConfigOption(option),
  );
  const requestedContextWindow = getProviderOptionStringSelectionValue(selections, "contextWindow");
  if (contextOption && requestedContextWindow) {
    const value = findCursorSelectOptionValue(
      contextOption,
      (option) =>
        normalizeCursorConfigOptionToken(option.value) ===
          normalizeCursorConfigOptionToken(requestedContextWindow) ||
        normalizeCursorConfigOptionToken(option.name) ===
          normalizeCursorConfigOptionToken(requestedContextWindow),
    );
    if (value) {
      updates.push({ configId: contextOption.id, value });
    }
  }

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorFastConfigOption(option),
  );
  const requestedFastMode = getProviderOptionBooleanSelectionValue(selections, "fastMode");
  if (fastOption && typeof requestedFastMode === "boolean") {
    const value = findCursorBooleanConfigValue(fastOption, requestedFastMode);
    if (value !== undefined) {
      updates.push({ configId: fastOption.id, value });
    }
  }

  return updates;
}

function getCursorFallbackModels(
  cursorSettings: Pick<CursorSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], cursorSettings.customModels, EMPTY_CAPABILITIES);
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
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

    const label = parameter.displayName?.trim() || toTitleCaseWords(id);
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

/** Strip ANSI escape sequences so we can parse plain key-value lines. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

/**
 * Extract a value from `agent about` key-value output.
 * Lines look like: `CLI Version         2026.03.20-44cb435`
 */
function extractAboutField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}\\s{2,}(.+)$`, "mi");
  const match = regex.exec(plain);
  return match?.[1]?.trim();
}

export interface CursorAboutResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
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

interface CursorAboutJsonPayload {
  readonly cliVersion?: unknown;
  readonly subscriptionTier?: unknown;
  readonly userEmail?: unknown;
}

export function parseCursorVersionDate(version: string | null | undefined): number | undefined {
  const match = version?.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\b|-|$)/);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return Number(`${year}${month}${day}`);
}

export function parseCursorCliConfigChannel(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "channel" in parsed &&
      typeof parsed.channel === "string"
    ) {
      const channel = parsed.channel.trim().toLowerCase();
      return channel.length > 0 ? channel : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function cursorSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function cursorAuthMetadata(
  subscriptionType: string | undefined,
): Pick<ServerProviderAuth, "label" | "type"> | undefined {
  if (!subscriptionType) {
    return undefined;
  }
  const subscriptionLabel = cursorSubscriptionLabel(subscriptionType);
  return {
    type: subscriptionType,
    label: `Cursor ${subscriptionLabel ?? toTitleCaseWords(subscriptionType)} Subscription`,
  };
}

function parseCursorAboutJsonPayload(raw: string): CursorAboutJsonPayload | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as CursorAboutJsonPayload;
  } catch {
    return undefined;
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isCursorAboutJsonFormatUnsupported(result: CommandResult): boolean {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    lowerOutput.includes("unknown option '--format'") ||
    lowerOutput.includes("unexpected argument '--format'") ||
    lowerOutput.includes("unrecognized option '--format'") ||
    lowerOutput.includes("unknown argument '--format'")
  );
}

export function getCursorParameterizedModelPickerUnsupportedMessage(input: {
  readonly version: string | null | undefined;
  readonly channel: string | null | undefined;
}): string | undefined {
  const reasons: Array<string> = [];
  const versionDate = parseCursorVersionDate(input.version);
  if (
    versionDate !== undefined &&
    versionDate < CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE
  ) {
    reasons.push(
      `Cursor Agent CLI version ${input.version} is too old for Cursor ACP parameterized model picker`,
    );
  }

  const normalizedChannel = input.channel?.trim().toLowerCase();
  if (
    normalizedChannel !== undefined &&
    normalizedChannel.length > 0 &&
    normalizedChannel !== "lab"
  ) {
    reasons.push(
      `Cursor Agent CLI channel is ${JSON.stringify(input.channel)}, but parameterized model picker is only available on the lab channel`,
    );
  }

  if (reasons.length === 0) {
    return undefined;
  }

  return `${reasons.join(". ")}. Run \`agent set-channel lab && agent update\` and use Cursor Agent CLI 2026.04.08 or newer.`;
}

/**
 * Parse the output of `agent about` to extract version and authentication
 * status in a single probe.
 *
 * Example output (logged in):
 * ```
 * About Cursor CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          user@example.com
 * ```
 *
 * Example output (logged out):
 * ```
 * About Cursor CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          Not logged in
 * ```
 */
export function parseCursorAboutOutput(result: CommandResult): CursorAboutResult {
  const jsonPayload = parseCursorAboutJsonPayload(result.stdout);
  if (jsonPayload) {
    const version =
      typeof jsonPayload.cliVersion === "string" ? jsonPayload.cliVersion.trim() : null;
    const hasUserEmailField = hasOwn(jsonPayload, "userEmail");
    const userEmail =
      typeof jsonPayload.userEmail === "string" ? jsonPayload.userEmail.trim() : undefined;
    const subscriptionType =
      typeof jsonPayload.subscriptionTier === "string"
        ? jsonPayload.subscriptionTier.trim()
        : undefined;
    const authMetadata = cursorAuthMetadata(subscriptionType);

    if (hasUserEmailField && jsonPayload.userEmail == null) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
      };
    }

    if (!userEmail) {
      if (result.code === 0) {
        return {
          version,
          status: "ready",
          auth: {
            status: "unknown",
            ...authMetadata,
          },
        };
      }
      return {
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Cursor Agent authentication status.",
      };
    }

    const lowerEmail = userEmail.toLowerCase();
    if (
      lowerEmail === "not logged in" ||
      lowerEmail.includes("login required") ||
      lowerEmail.includes("authentication required")
    ) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
      };
    }

    return {
      version,
      status: "ready",
      auth: {
        status: "authenticated",
        email: userEmail,
        ...authMetadata,
      },
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = combined.toLowerCase();

  // If the command itself isn't recognised, we're on an old CLI version.
  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "The `agent about` command is unavailable in this version of the Cursor Agent CLI.",
    };
  }

  const plain = stripAnsi(combined);
  const version = extractAboutField(plain, "CLI Version") ?? null;
  const userEmail = extractAboutField(plain, "User Email");

  // Determine auth from the User Email field.
  if (userEmail === undefined) {
    // Field missing entirely — can't determine auth.
    if (result.code === 0) {
      return { version, status: "ready", auth: { status: "unknown" } };
    }
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify Cursor Agent authentication status.",
    };
  }

  const lowerEmail = userEmail.toLowerCase();
  if (
    lowerEmail === "not logged in" ||
    lowerEmail.includes("login required") ||
    lowerEmail.includes("authentication required")
  ) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    };
  }

  // Any non-empty email value means authenticated.
  return {
    version,
    status: "ready",
    auth: { status: "authenticated", email: userEmail },
  };
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
    if (!isCursorAboutJsonFormatUnsupported(jsonResult)) {
      return jsonResult;
    }
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
