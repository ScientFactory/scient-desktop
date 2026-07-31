import type {
  ModelSelection,
  ProviderKind,
  ProviderStartOptions,
  ServerSettings,
} from "@synara/contracts";

export interface TextGenerationProviderInput {
  readonly modelSelection: ModelSelection;
  readonly providerOptions?: ProviderStartOptions;
  readonly codexHomePath?: string;
}

export function hasDedicatedTextGenerationProvider(provider: ProviderKind | undefined): boolean {
  return (
    provider === "codex" || provider === "cursor" || provider === "kilo" || provider === "opencode"
  );
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveConfiguredTextGenerationProviderOptions(
  settings: ServerSettings,
): ProviderStartOptions | undefined {
  switch (settings.textGenerationModelSelection.provider) {
    case "codex": {
      const provider = settings.providers.codex;
      const binaryPath = nonEmpty(provider.binaryPath);
      const homePath = nonEmpty(provider.homePath);
      return {
        codex: {
          ...(binaryPath ? { binaryPath } : {}),
          ...(homePath ? { homePath } : {}),
        },
      };
    }
    case "cursor": {
      const provider = settings.providers.cursor;
      const binaryPath = nonEmpty(provider.binaryPath);
      const apiEndpoint = nonEmpty(provider.apiEndpoint);
      return {
        cursor: {
          ...(binaryPath ? { binaryPath } : {}),
          ...(apiEndpoint ? { apiEndpoint } : {}),
        },
      };
    }
    case "opencode": {
      const provider = settings.providers.opencode;
      const binaryPath = nonEmpty(provider.binaryPath);
      const serverUrl = nonEmpty(provider.serverUrl);
      const serverPassword = nonEmpty(provider.serverPassword);
      return {
        opencode: {
          ...(binaryPath ? { binaryPath } : {}),
          ...(serverUrl ? { serverUrl } : {}),
          ...(serverPassword ? { serverPassword } : {}),
          experimentalWebSockets: provider.experimentalWebSockets,
        },
      };
    }
    case "kilo": {
      const provider = settings.providers.kilo;
      const binaryPath = nonEmpty(provider.binaryPath);
      const serverUrl = nonEmpty(provider.serverUrl);
      const serverPassword = nonEmpty(provider.serverPassword);
      return {
        kilo: {
          ...(binaryPath ? { binaryPath } : {}),
          ...(serverUrl ? { serverUrl } : {}),
          ...(serverPassword ? { serverPassword } : {}),
        },
      };
    }
    default:
      return undefined;
  }
}

export function resolveTextGenerationInputForSelection(
  modelSelection: ModelSelection | undefined,
  providerOptions: ProviderStartOptions | undefined,
): TextGenerationProviderInput | null {
  if (!modelSelection || !hasDedicatedTextGenerationProvider(modelSelection.provider)) {
    return null;
  }

  if (modelSelection.provider === "codex") {
    return {
      modelSelection,
      ...(providerOptions ? { providerOptions } : {}),
      ...(providerOptions?.codex?.homePath
        ? { codexHomePath: providerOptions.codex.homePath }
        : {}),
    };
  }

  return {
    modelSelection,
    ...(providerOptions ? { providerOptions } : {}),
  };
}

export function buildGitTextGenerationCallInput(input: {
  readonly textGenerationModel?: string | undefined;
  readonly textGenerationModelSelection?: ModelSelection | undefined;
  readonly codexHomePath?: string | undefined;
  readonly providerOptions?: ProviderStartOptions | undefined;
}): {
  readonly model?: string;
  readonly modelSelection?: ModelSelection;
  readonly codexHomePath?: string;
  readonly providerOptions?: ProviderStartOptions;
} {
  const modelSelection = input.textGenerationModelSelection;
  const model = input.textGenerationModel?.trim() || modelSelection?.model;

  return {
    ...(model ? { model } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
    ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
  };
}
