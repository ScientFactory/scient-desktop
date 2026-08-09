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
export type ProviderLabSnapshot =
  | "nothing-installed"
  | "installed-signed-out"
  | "browser-sign-in"
  | "device-code"
  | "verifying"
  | "connected"
  | "update-available"
  | "updating"
  | "update-failed"
  | "install-failed"
  | "sign-in-failed";
export type ProviderLabFailure = "none" | "runtime" | "connection" | "disconnect";

export interface ProviderLabState {
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

function runtimeOperation(
  status: ProviderRuntimeOperation["status"],
  message: string,
): ProviderRuntimeOperation {
  return {
    operationId: "provider-lab-runtime",
    action: status === "removing" ? "remove" : "install",
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
  operation: ProviderRuntimeOperation | null = null,
): ProviderRuntimeSummary {
  return {
    source,
    supportTier: "fully_assisted",
    target,
    actions: source === "missing" ? ["install"] : ["repair", "remove"],
    managedVersion: source === "scient_managed" ? "0.147.0" : null,
    previousManagedVersion: null,
    operation,
    message:
      source === "missing"
        ? "Codex is not installed. Scient can install a private, verified copy."
        : "The managed Codex runtime is verified and ready.",
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
      runtime: runtimeSummary(target, "missing"),
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
      runtime: runtimeSummary(target, "scient_managed"),
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
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "0.147.0",
        latestVersion: "0.148.0",
        updateCommand: "npm install -g @openai/codex@0.148.0",
        canUpdate: true,
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
      updateState: {
        status: "running",
        startedAt,
        finishedAt: null,
        message: "Downloading and verifying Codex 0.148.0.",
        output: null,
      },
    };
  }
  if (snapshot === "update-failed") {
    return {
      ...codexProvider("update-available", target),
      updateState: {
        status: "failed",
        startedAt,
        finishedAt: checkedAt,
        message: "The update could not be verified. Codex 0.147.0 is still available.",
        output: null,
      },
    };
  }
  return connected;
}

export function providersForSnapshot(
  snapshot: ProviderLabSnapshot,
  target: ProviderLabTarget,
): ReadonlyArray<ServerProvider> {
  return [codexProvider(snapshot, target)];
}

export function makeProviderLabState(
  snapshot: ProviderLabSnapshot = "nothing-installed",
  target: ProviderLabTarget = "darwin-arm64",
): ProviderLabState {
  return {
    target,
    snapshot,
    failure: "none",
    providers: providersForSnapshot(snapshot, target),
    events: ["Fresh simulated computer. No real provider state or credentials were read."],
  };
}

export const providerLabStateAtom = Atom.make(makeProviderLabState()).pipe(
  Atom.withLabel("scient-provider-full-app-lab"),
);

export function replaceCodex(
  state: ProviderLabState,
  provider: ServerProvider,
  event: string,
): ProviderLabState {
  return {
    ...state,
    providers: state.providers.map((item) => (item.driver === "codex" ? provider : item)),
    events: [event, ...state.events].slice(0, 6),
  };
}

export function activeCodex(state: ProviderLabState): ServerProvider {
  return state.providers.find((provider) => provider.driver === "codex")!;
}

export function nextProviderLabState(state: ProviderLabState): ProviderLabState | null {
  const provider = activeCodex(state);
  if (provider.updateState?.status === "running") {
    return {
      ...makeProviderLabState("connected", state.target),
      providers: [
        {
          ...codexProvider("connected", state.target),
          version: "0.148.0",
          versionAdvisory: {
            status: "current",
            currentVersion: "0.148.0",
            latestVersion: "0.148.0",
            updateCommand: null,
            canUpdate: false,
            checkedAt,
            message: "Codex is up to date.",
          },
          updateState: {
            status: "succeeded",
            startedAt,
            finishedAt: checkedAt,
            message: "Codex was updated successfully.",
            output: null,
          },
        },
      ],
      events: ["Codex updated and verified.", ...state.events],
    };
  }
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
    return replaceCodex(
      state,
      {
        ...provider,
        connection: {
          ...provider.connection!,
          runtime: {
            ...runtime!,
            operation: runtimeOperation(nextStatus, `Simulated runtime step: ${nextStatus}.`),
          },
        },
      },
      `Advanced runtime to ${nextStatus}.`,
    );
  }
  if (status === "activating") {
    return {
      ...makeProviderLabState("installed-signed-out", state.target),
      events: ["Runtime activated.", ...state.events],
    };
  }
  const connectionStatus = provider.connection?.operation?.status;
  if (
    connectionStatus === "waiting_for_browser" ||
    connectionStatus === "waiting_for_device_code"
  ) {
    return {
      ...replaceCodex(
        state,
        {
          ...provider,
          connection: { ...provider.connection!, operation: connectionOperation("verifying") },
        },
        "Advanced sign in to verification.",
      ),
      snapshot: "verifying",
    };
  }
  if (connectionStatus === "verifying") {
    return {
      ...makeProviderLabState("connected", state.target),
      events: ["Provider connected.", ...state.events],
    };
  }
  return null;
}

export function runtimePlan(action: ProviderManagedRuntimeAction, target: ProviderLabTarget) {
  return {
    instanceId: codexId,
    action,
    target,
    version: "0.147.0",
    downloadBytes: action === "remove" ? null : 92_274_688,
    sourceLabel: "Pinned Scient provider catalog · simulated",
    catalogRevision: "provider-lab-catalog-1",
    message:
      action === "remove"
        ? "Remove only the private runtime managed by Scient."
        : "Download and verify a private Codex runtime without changing system tools.",
  } as const;
}

export { codexProvider, connectionOperation, runtimeOperation };
