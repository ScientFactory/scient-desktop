import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionMethod,
  type ProviderConnectionOperation,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimeOperation,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

export const PROVIDER_LAB_ENABLED = import.meta.env.VITE_SCIENT_PROVIDER_LAB === "1";

export type ProviderLabTarget = "darwin-arm64" | "win32-x64" | "linux-x64";
export type ProviderLabDriver = "codex" | "claudeAgent";
export type ProviderLabSnapshot =
  | "nothing-installed"
  | "installed-signed-out"
  | "browser-sign-in"
  | "device-code"
  | "authorization-code"
  | "authorization-code-expired"
  | "verifying"
  | "connected"
  | "update-available"
  | "updating"
  | "update-failed"
  | "install-failed"
  | "sign-in-failed";
export type ProviderLabFailure = "none" | "runtime" | "connection" | "disconnect";

export interface ProviderLabState {
  readonly driver: ProviderLabDriver;
  readonly target: ProviderLabTarget;
  readonly snapshot: ProviderLabSnapshot;
  readonly failure: ProviderLabFailure;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly events: ReadonlyArray<string>;
}

const checkedAt = "2026-08-09T08:00:00.000Z";
const startedAt = checkedAt;
const codexId = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

function runtimeOperation(
  status: ProviderRuntimeOperation["status"],
  message: string,
  action: ProviderManagedRuntimeAction = "install",
): ProviderRuntimeOperation {
  return {
    operationId: "provider-lab-runtime",
    action: status === "removing" ? "remove" : action,
    status,
    startedAt,
    finishedAt: ["failed", "cancelled", "succeeded"].includes(status) ? checkedAt : null,
    message,
    ...(status === "downloading" ? { downloadedBytes: 18_454_938, totalBytes: 92_274_688 } : {}),
  };
}

function connectionOperation(
  status: ProviderConnectionOperation["status"],
  method: ProviderConnectionMethod = "codex_browser",
): ProviderConnectionOperation {
  return {
    operationId: "provider-lab-connection",
    method,
    status,
    startedAt,
    finishedAt: ["failed", "cancelled", "connected"].includes(status) ? checkedAt : null,
    message:
      status === "waiting_for_browser"
        ? "Complete sign in in the secure browser window."
        : status === "waiting_for_device_code"
          ? "Enter this one-time code on the provider sign-in page."
          : status === "verifying"
            ? "Scient is verifying the provider account and available models."
            : status === "failed"
              ? "The provider did not confirm the connection. Your previous state was preserved."
              : "Connection ready.",
    ...(status === "waiting_for_browser" || status === "waiting_for_device_code"
      ? { authorizationUrl: "https://example.invalid/scient-provider-lab" }
      : {}),
    ...(status === "waiting_for_device_code" ? { userCode: "SCIENT-42" } : {}),
  };
}

function runtimeSummary(
  target: ProviderLabTarget,
  source: ProviderRuntimeSummary["source"],
  displayName: string,
  version: string,
  operation: ProviderRuntimeOperation | null = null,
  updateAvailable = false,
): ProviderRuntimeSummary {
  return {
    source,
    supportTier: "fully_assisted",
    target,
    actions:
      source === "missing"
        ? ["install"]
        : updateAvailable
          ? ["update", "repair", "remove"]
          : ["repair", "remove"],
    managedVersion: source === "scient_managed" ? version : null,
    previousManagedVersion: null,
    operation,
    message:
      source === "missing"
        ? `${displayName} is not installed. Scient can install a private, verified copy.`
        : `The managed ${displayName} runtime is verified and ready.`,
  };
}

function codexProvider(snapshot: ProviderLabSnapshot, target: ProviderLabTarget): ServerProvider {
  const missing: ServerProvider = {
    instanceId: codexId,
    driver: codexDriver,
    displayName: "Codex",
    enabled: true,
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unauthenticated", required: true },
    checkedAt,
    message: "Set up Codex to use its models in Scient.",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: ["codex_browser", "codex_device_code"],
      canDisconnect: false,
      operation: null,
      runtime: runtimeSummary(target, "missing", "Codex", "0.147.0"),
    },
  };
  if (snapshot === "nothing-installed") return missing;
  if (snapshot === "install-failed") {
    return {
      ...missing,
      status: "error",
      connection: {
        ...missing.connection!,
        runtime: runtimeSummary(
          target,
          "missing",
          "Codex",
          "0.147.0",
          runtimeOperation("failed", "The simulated download failed verification."),
        ),
      },
    };
  }
  const installed: ServerProvider = {
    ...missing,
    installed: true,
    version: "0.147.0",
    message: "Codex is installed. Sign in to discover available models.",
    connection: {
      ...missing.connection!,
      runtime: runtimeSummary(target, "scient_managed", "Codex", "0.147.0"),
    },
  };
  if (snapshot === "installed-signed-out") return installed;
  if (snapshot === "browser-sign-in" || snapshot === "device-code" || snapshot === "verifying") {
    return {
      ...installed,
      connection: {
        ...installed.connection!,
        operation: connectionOperation(
          snapshot === "verifying"
            ? "verifying"
            : snapshot === "device-code"
              ? "waiting_for_device_code"
              : "waiting_for_browser",
          snapshot === "device-code" ? "codex_device_code" : "codex_browser",
        ),
      },
    };
  }
  if (snapshot === "sign-in-failed") {
    return {
      ...installed,
      status: "error",
      connection: { ...installed.connection!, operation: connectionOperation("failed") },
    };
  }
  const connected: ServerProvider = {
    ...installed,
    status: "ready",
    auth: {
      status: "authenticated",
      required: true,
      email: "scientist@example.test",
      label: "ChatGPT subscription",
    },
    message: "Connected and ready.",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    connection: { ...installed.connection!, canDisconnect: true, operation: null },
  };
  if (snapshot === "update-available") {
    return {
      ...connected,
      connection: {
        ...connected.connection!,
        runtime: runtimeSummary(target, "scient_managed", "Codex", "0.147.0", null, true),
      },
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "0.147.0",
        latestVersion: "0.148.0",
        updateCommand: null,
        canUpdate: false,
        checkedAt,
        message: "Codex 0.148.0 is available.",
      },
      updateState: {
        status: "idle",
        startedAt: null,
        finishedAt: null,
        message: null,
        output: null,
      },
    };
  }
  if (snapshot === "updating") {
    return {
      ...codexProvider("update-available", target),
      connection: {
        ...connected.connection!,
        runtime: runtimeSummary(
          target,
          "scient_managed",
          "Codex",
          "0.147.0",
          runtimeOperation("downloading", "Downloading and verifying Codex 0.148.0.", "update"),
          true,
        ),
      },
    };
  }
  if (snapshot === "update-failed") {
    return {
      ...codexProvider("update-available", target),
      connection: {
        ...connected.connection!,
        runtime: runtimeSummary(
          target,
          "scient_managed",
          "Codex",
          "0.147.0",
          runtimeOperation(
            "failed",
            "The update could not be verified. Codex 0.147.0 is still available.",
            "update",
          ),
          true,
        ),
      },
    };
  }
  return connected;
}

function claudeProvider(snapshot: ProviderLabSnapshot, target: ProviderLabTarget): ServerProvider {
  const missing: ServerProvider = {
    instanceId: claudeId,
    driver: claudeDriver,
    displayName: "Claude",
    enabled: true,
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unauthenticated", required: true },
    checkedAt,
    message: "Set up Claude to use its models in Scient.",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: ["claude_subscription", "claude_console"],
      canDisconnect: false,
      operation: null,
      runtime: runtimeSummary(target, "missing", "Claude", "2.1.170"),
    },
  };
  if (snapshot === "nothing-installed") return missing;
  if (snapshot === "install-failed") {
    return {
      ...missing,
      status: "error",
      connection: {
        ...missing.connection!,
        runtime: runtimeSummary(
          target,
          "missing",
          "Claude",
          "2.1.170",
          runtimeOperation("failed", "The simulated Claude download failed verification."),
        ),
      },
    };
  }
  const installed: ServerProvider = {
    ...missing,
    installed: true,
    version: "2.1.170",
    message: "Claude is installed. Sign in to discover available models.",
    connection: {
      ...missing.connection!,
      runtime: runtimeSummary(target, "scient_managed", "Claude", "2.1.170"),
    },
  };
  if (snapshot === "installed-signed-out") return installed;
  if (
    snapshot === "browser-sign-in" ||
    snapshot === "authorization-code" ||
    snapshot === "verifying"
  ) {
    return {
      ...installed,
      connection: {
        ...installed.connection!,
        operation: connectionOperation(
          snapshot === "verifying" ? "verifying" : "waiting_for_browser",
          "claude_subscription",
        ),
      },
    };
  }
  if (snapshot === "sign-in-failed" || snapshot === "authorization-code-expired") {
    return {
      ...installed,
      status: "error",
      connection: {
        ...installed.connection!,
        operation: connectionOperation("failed", "claude_subscription"),
      },
    };
  }
  const connected: ServerProvider = {
    ...installed,
    status: "ready",
    auth: {
      status: "authenticated",
      required: true,
      email: "scientist@example.test",
      label: "Claude subscription",
    },
    message: "Connected and ready.",
    models: [
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    connection: { ...installed.connection!, canDisconnect: true, operation: null },
  };
  if (snapshot === "update-available") {
    return {
      ...connected,
      connection: {
        ...connected.connection!,
        runtime: runtimeSummary(target, "scient_managed", "Claude", "2.1.170", null, true),
      },
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "2.1.170",
        latestVersion: "2.1.171",
        updateCommand: null,
        canUpdate: false,
        checkedAt,
        message: "Claude 2.1.171 is available.",
      },
      updateState: {
        status: "idle",
        startedAt: null,
        finishedAt: null,
        message: null,
        output: null,
      },
    };
  }
  if (snapshot === "updating" || snapshot === "update-failed") {
    return {
      ...claudeProvider("update-available", target),
      connection: {
        ...connected.connection!,
        runtime: runtimeSummary(
          target,
          "scient_managed",
          "Claude",
          "2.1.170",
          runtimeOperation(
            snapshot === "updating" ? "downloading" : "failed",
            snapshot === "updating"
              ? "Downloading and verifying Claude 2.1.171."
              : "The update could not be verified. Claude 2.1.170 is still available.",
            "update",
          ),
          true,
        ),
      },
    };
  }
  return connected;
}

export function providersForSnapshot(
  snapshot: ProviderLabSnapshot,
  target: ProviderLabTarget,
  driver: ProviderLabDriver = "codex",
): ReadonlyArray<ServerProvider> {
  return [
    driver === "codex"
      ? codexProvider(snapshot, target)
      : codexProvider("nothing-installed", target),
    driver === "claudeAgent"
      ? claudeProvider(snapshot, target)
      : claudeProvider("nothing-installed", target),
  ];
}

export function makeProviderLabState(
  snapshot: ProviderLabSnapshot = "nothing-installed",
  target: ProviderLabTarget = "darwin-arm64",
  driver: ProviderLabDriver = "codex",
): ProviderLabState {
  return {
    driver,
    target,
    snapshot,
    failure: "none",
    providers: providersForSnapshot(snapshot, target, driver),
    events: ["Fresh simulated computer. No real provider state or credentials were read."],
  };
}

export const providerLabStateAtom = Atom.make(makeProviderLabState()).pipe(
  Atom.withLabel("scient-provider-full-app-lab"),
);

export function replaceActiveProvider(
  state: ProviderLabState,
  provider: ServerProvider,
  event: string,
): ProviderLabState {
  return {
    ...state,
    providers: state.providers.map((item) => (item.driver === state.driver ? provider : item)),
    events: [event, ...state.events].slice(0, 6),
  };
}

export function activeProvider(state: ProviderLabState): ServerProvider {
  return state.providers.find((provider) => provider.driver === state.driver)!;
}

export function replaceCodex(
  state: ProviderLabState,
  provider: ServerProvider,
  event: string,
): ProviderLabState {
  return replaceActiveProvider({ ...state, driver: "codex" }, provider, event);
}

export function activeCodex(state: ProviderLabState): ServerProvider {
  return state.providers.find((provider) => provider.driver === "codex")!;
}

export function activeClaude(state: ProviderLabState): ServerProvider {
  return state.providers.find((provider) => provider.driver === "claudeAgent")!;
}

function providerForSnapshot(
  driver: ProviderLabDriver,
  snapshot: ProviderLabSnapshot,
  target: ProviderLabTarget,
): ServerProvider {
  return driver === "codex" ? codexProvider(snapshot, target) : claudeProvider(snapshot, target);
}

export function setActiveProviderSnapshot(
  state: ProviderLabState,
  snapshot: ProviderLabSnapshot,
  event: string,
): ProviderLabState {
  return {
    ...replaceActiveProvider(
      state,
      providerForSnapshot(state.driver, snapshot, state.target),
      event,
    ),
    snapshot,
  };
}

export function switchActiveProvider(
  state: ProviderLabState,
  driver: ProviderLabDriver,
  event: string,
): ProviderLabState {
  const snapshot = "nothing-installed";
  const provider = providerForSnapshot(driver, snapshot, state.target);
  return {
    ...state,
    driver,
    snapshot,
    providers: state.providers.map((item) => (item.driver === driver ? provider : item)),
    events: [event, ...state.events].slice(0, 6),
  };
}

export function nextProviderLabState(state: ProviderLabState): ProviderLabState | null {
  const provider = activeProvider(state);
  const runtime = provider.connection?.runtime;
  const status = runtime?.operation?.status;
  const nextRuntime: Partial<
    Record<ProviderRuntimeOperation["status"], ProviderRuntimeOperation["status"]>
  > = {
    downloading: "verifying",
    verifying: "installing",
    installing: "testing",
    testing: "activating",
  };
  if (status && nextRuntime[status]) {
    const nextStatus = nextRuntime[status]!;
    return replaceActiveProvider(
      state,
      {
        ...provider,
        connection: {
          ...provider.connection!,
          runtime: {
            ...runtime!,
            operation: runtimeOperation(
              nextStatus,
              `Simulated runtime step: ${nextStatus}.`,
              runtime!.operation!.action,
            ),
          },
        },
      },
      `Advanced runtime to ${nextStatus}.`,
    );
  }
  if (status === "activating") {
    if (runtime?.operation?.action === "update") {
      const updated = providerForSnapshot(state.driver, "connected", state.target);
      const currentVersion = state.driver === "codex" ? "0.147.0" : "2.1.170";
      const updatedVersion = state.driver === "codex" ? "0.148.0" : "2.1.171";
      const displayName = state.driver === "codex" ? "Codex" : "Claude";
      return {
        ...replaceActiveProvider(
          state,
          {
            ...updated,
            version: updatedVersion,
            connection: {
              ...updated.connection!,
              runtime: {
                ...updated.connection!.runtime!,
                managedVersion: updatedVersion,
                previousManagedVersion: currentVersion,
                operation: runtimeOperation(
                  "succeeded",
                  `${displayName} ${updatedVersion} was activated successfully.`,
                  "update",
                ),
              },
            },
            versionAdvisory: {
              status: "current",
              currentVersion: updatedVersion,
              latestVersion: updatedVersion,
              updateCommand: null,
              canUpdate: false,
              checkedAt,
              message: `${displayName} is up to date.`,
            },
          },
          `${displayName} updated and verified.`,
        ),
        snapshot: "connected",
        events: [`${displayName} updated and verified.`, ...state.events],
      };
    }
    return setActiveProviderSnapshot(state, "installed-signed-out", "Runtime activated.");
  }
  if (status === "removing") {
    return setActiveProviderSnapshot(
      state,
      "nothing-installed",
      `Private ${state.driver === "codex" ? "Codex" : "Claude"} runtime removed.`,
    );
  }
  const connectionStatus = provider.connection?.operation?.status;
  if (
    connectionStatus === "waiting_for_browser" ||
    connectionStatus === "waiting_for_device_code"
  ) {
    return {
      ...replaceActiveProvider(
        state,
        {
          ...provider,
          connection: {
            ...provider.connection!,
            operation: connectionOperation(
              "verifying",
              provider.connection?.operation?.method ??
                (state.driver === "claudeAgent" ? "claude_subscription" : "codex_browser"),
            ),
          },
        },
        "Advanced sign in to verification.",
      ),
      snapshot: "verifying",
    };
  }
  if (connectionStatus === "verifying") {
    return setActiveProviderSnapshot(state, "connected", "Provider connected.");
  }
  return null;
}

export function runtimePlan(
  action: ProviderManagedRuntimeAction,
  target: ProviderLabTarget,
  driver: ProviderLabDriver = "codex",
) {
  const displayName = driver === "codex" ? "Codex" : "Claude";
  const version = driver === "codex" ? "0.147.0" : "2.1.170";
  return {
    instanceId: driver === "codex" ? codexId : claudeId,
    action,
    target,
    version,
    downloadBytes: action === "remove" ? null : driver === "codex" ? 92_274_688 : 222_102_816,
    sourceLabel: "Pinned Scient provider catalog · simulated",
    catalogRevision: "provider-lab-catalog-1",
    message:
      action === "remove"
        ? "Remove only the private runtime managed by Scient."
        : `Download and verify a private ${displayName} runtime without changing system tools.`,
  } as const;
}

export { claudeProvider, codexProvider, connectionOperation, runtimeOperation };
