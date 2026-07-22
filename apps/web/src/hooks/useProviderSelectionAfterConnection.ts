// FILE: useProviderSelectionAfterConnection.ts
// Purpose: Carries a picker-origin provider selection through installation/authentication
//          and commits it only after the provider is verified usable.
// Layer: Web UI orchestration

import {
  type ModelSlug,
  type ProviderKind,
  type ServerProviderConnectionState,
  type ServerProviderInstallationState,
  type ServerProviderStatus,
} from "@synara/contracts";
import { getDefaultModel, resolveSelectableModel } from "@synara/shared/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { findProviderStatus, isProviderUsable } from "../lib/providerAvailability";
import type { ProviderModelOption } from "../providerModelOptions";
import { useProviderConnectionDialogStore } from "../providerConnectionDialogStore";

type ConnectionStatus = ServerProviderConnectionState["status"];
type InstallationStatus = ServerProviderInstallationState["status"];

const ACTIVE_CONNECTION_STATUSES = new Set<ConnectionStatus>([
  "starting",
  "waiting_for_browser",
  "verifying",
]);
const FAILED_CONNECTION_STATUSES = new Set<ConnectionStatus>(["failed", "cancelled"]);
const ACTIVE_INSTALLATION_STATUSES = new Set<InstallationStatus>([
  "resolving",
  "awaiting_consent",
  "downloading",
  "verifying",
  "installing",
  "smoke_testing",
]);
const FAILED_INSTALLATION_STATUSES = new Set<InstallationStatus>(["failed", "cancelled"]);

interface OperationBaseline<TStatus extends string> {
  readonly operationId: string;
  readonly status: TStatus;
}

export interface ProviderSelectionIntent {
  readonly token: number;
  readonly scopeKey: string;
  readonly provider: ProviderKind;
  readonly requestedAt: number;
  readonly baselineConnection: OperationBaseline<ConnectionStatus> | null;
  readonly baselineInstallation: OperationBaseline<InstallationStatus> | null;
  readonly observedConnectionOperationId: string | null;
  readonly observedInstallationOperationId: string | null;
}

export interface ProviderSelectionIntentController {
  readonly intent: ProviderSelectionIntent | null;
  readonly pendingProvider: ProviderKind | null;
  request: (provider: ProviderKind, status: ServerProviderStatus | null | undefined) => void;
  clear: (token?: number) => void;
  replace: (token: number, intent: ProviderSelectionIntent) => void;
}

export type ProviderSelectionIntentOutcome =
  | { readonly type: "pending"; readonly intent: ProviderSelectionIntent }
  | { readonly type: "ready"; readonly provider: ProviderKind }
  | { readonly type: "clear"; readonly reason: "scope_changed" | "provider_locked" | "failed" };

function operationBaseline<TStatus extends string>(
  operation: { readonly operationId: string; readonly status: TStatus } | null | undefined,
): OperationBaseline<TStatus> | null {
  return operation
    ? {
        operationId: operation.operationId,
        status: operation.status,
      }
    : null;
}

export function createProviderSelectionIntent(input: {
  readonly token: number;
  readonly scopeKey: string;
  readonly provider: ProviderKind;
  readonly status: ServerProviderStatus | null | undefined;
  readonly requestedAt?: number;
}): ProviderSelectionIntent {
  const connection = input.status?.connectionState;
  const installation = input.status?.installationState;
  return {
    token: input.token,
    scopeKey: input.scopeKey,
    provider: input.provider,
    requestedAt: input.requestedAt ?? Date.now(),
    baselineConnection: operationBaseline(connection),
    baselineInstallation: operationBaseline(installation),
    observedConnectionOperationId:
      connection && ACTIVE_CONNECTION_STATUSES.has(connection.status)
        ? connection.operationId
        : null,
    observedInstallationOperationId:
      installation && ACTIVE_INSTALLATION_STATUSES.has(installation.status)
        ? installation.operationId
        : null,
  };
}

function startedAfterRequest(startedAt: string, requestedAt: number): boolean {
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) && parsed >= requestedAt;
}

function operationFailedAfterIntent<TStatus extends string>(input: {
  readonly operation:
    | { readonly operationId: string; readonly status: TStatus; readonly startedAt: string }
    | null
    | undefined;
  readonly failedStatuses: ReadonlySet<TStatus>;
  readonly baseline: OperationBaseline<TStatus> | null;
  readonly observedOperationId: string | null;
  readonly requestedAt: number;
}): boolean {
  const operation = input.operation;
  if (!operation || !input.failedStatuses.has(operation.status)) {
    return false;
  }
  if (input.observedOperationId === operation.operationId) {
    return true;
  }
  if (
    input.baseline?.operationId === operation.operationId &&
    input.baseline.status !== operation.status
  ) {
    return true;
  }
  return startedAfterRequest(operation.startedAt, input.requestedAt);
}

export function evaluateProviderSelectionIntent(input: {
  readonly intent: ProviderSelectionIntent;
  readonly scopeKey: string;
  readonly lockedProvider: ProviderKind | null;
  readonly status: ServerProviderStatus | null | undefined;
}): ProviderSelectionIntentOutcome {
  const { intent } = input;
  if (intent.scopeKey !== input.scopeKey) {
    return { type: "clear", reason: "scope_changed" };
  }
  if (input.lockedProvider !== null) {
    return { type: "clear", reason: "provider_locked" };
  }
  if (isProviderUsable(input.status)) {
    return { type: "ready", provider: intent.provider };
  }

  const connection = input.status?.connectionState;
  const installation = input.status?.installationState;
  if (
    operationFailedAfterIntent({
      operation: connection,
      failedStatuses: FAILED_CONNECTION_STATUSES,
      baseline: intent.baselineConnection,
      observedOperationId: intent.observedConnectionOperationId,
      requestedAt: intent.requestedAt,
    }) ||
    operationFailedAfterIntent({
      operation: installation,
      failedStatuses: FAILED_INSTALLATION_STATUSES,
      baseline: intent.baselineInstallation,
      observedOperationId: intent.observedInstallationOperationId,
      requestedAt: intent.requestedAt,
    })
  ) {
    return { type: "clear", reason: "failed" };
  }

  const observedConnectionOperationId =
    connection && ACTIVE_CONNECTION_STATUSES.has(connection.status)
      ? connection.operationId
      : intent.observedConnectionOperationId;
  const observedInstallationOperationId =
    installation && ACTIVE_INSTALLATION_STATUSES.has(installation.status)
      ? installation.operationId
      : intent.observedInstallationOperationId;
  if (
    observedConnectionOperationId === intent.observedConnectionOperationId &&
    observedInstallationOperationId === intent.observedInstallationOperationId
  ) {
    return { type: "pending", intent };
  }
  return {
    type: "pending",
    intent: {
      ...intent,
      observedConnectionOperationId,
      observedInstallationOperationId,
    },
  };
}

export function resolvePostConnectionModel(input: {
  readonly provider: ProviderKind;
  readonly preferredModel: string | null | undefined;
  readonly options: ReadonlyArray<ProviderModelOption>;
}): ModelSlug | null {
  const preferred = resolveSelectableModel(input.provider, input.preferredModel, input.options);
  if (preferred) {
    return preferred;
  }
  const providerDefault = getDefaultModel(input.provider);
  const resolvedDefault = resolveSelectableModel(input.provider, providerDefault, input.options);
  return resolvedDefault ?? input.options[0]?.slug ?? null;
}

export function useProviderConnectionSelectionIntent(
  scopeKey: string,
): ProviderSelectionIntentController {
  const [intent, setIntent] = useState<ProviderSelectionIntent | null>(null);
  const nextTokenRef = useRef(0);

  const request = useCallback(
    (provider: ProviderKind, status: ServerProviderStatus | null | undefined) => {
      nextTokenRef.current += 1;
      setIntent(
        createProviderSelectionIntent({
          token: nextTokenRef.current,
          scopeKey,
          provider,
          status,
        }),
      );
    },
    [scopeKey],
  );
  const clear = useCallback((token?: number) => {
    setIntent((current) => (token === undefined || current?.token === token ? null : current));
  }, []);
  const replace = useCallback((token: number, nextIntent: ProviderSelectionIntent) => {
    setIntent((current) => (current?.token === token ? nextIntent : current));
  }, []);

  return useMemo(
    () => ({
      intent,
      pendingProvider: intent?.provider ?? null,
      request,
      clear,
      replace,
    }),
    [clear, intent, replace, request],
  );
}

export function useApplyProviderSelectionAfterConnection(input: {
  readonly controller: ProviderSelectionIntentController;
  readonly scopeKey: string;
  readonly lockedProvider: ProviderKind | null;
  readonly statuses: readonly ServerProviderStatus[];
  readonly modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  readonly loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  readonly preferredModelByProvider?: Partial<Record<ProviderKind, string | null>>;
  readonly canApply?: boolean;
  readonly onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
}): void {
  const consumedTokenRef = useRef<number | null>(null);
  const seenPickerDialogTokenRef = useRef<number | null>(null);
  const connectionDialogOpen = useProviderConnectionDialogStore((state) => state.isOpen);
  const connectionDialogProvider = useProviderConnectionDialogStore((state) => state.provider);
  const connectionDialogSource = useProviderConnectionDialogStore((state) => state.source);
  const {
    canApply,
    controller,
    loadingModelProviders,
    lockedProvider,
    modelOptionsByProvider,
    onProviderModelChange,
    preferredModelByProvider,
    scopeKey,
    statuses,
  } = input;

  useEffect(() => {
    const intent = controller.intent;
    if (!intent) {
      return;
    }
    const status = findProviderStatus(statuses, intent.provider);
    const pickerDialogMatchesIntent =
      connectionDialogOpen &&
      connectionDialogProvider === intent.provider &&
      connectionDialogSource === "provider_picker";
    if (pickerDialogMatchesIntent) {
      seenPickerDialogTokenRef.current = intent.token;
    }
    const outcome = evaluateProviderSelectionIntent({
      intent,
      scopeKey,
      lockedProvider,
      status,
    });
    if (outcome.type === "clear") {
      controller.clear(intent.token);
      return;
    }
    if (outcome.type === "pending") {
      const operationStillRunning =
        (status?.connectionState &&
          ACTIVE_CONNECTION_STATUSES.has(status.connectionState.status)) ||
        (status?.installationState &&
          ACTIVE_INSTALLATION_STATUSES.has(status.installationState.status));
      const operationWasObserved =
        outcome.intent.observedConnectionOperationId !== null ||
        outcome.intent.observedInstallationOperationId !== null;
      if (
        seenPickerDialogTokenRef.current === intent.token &&
        !pickerDialogMatchesIntent &&
        !operationStillRunning &&
        !operationWasObserved
      ) {
        controller.clear(intent.token);
        return;
      }
      if (outcome.intent !== intent) {
        controller.replace(intent.token, outcome.intent);
      }
      return;
    }
    if (loadingModelProviders?.[outcome.provider]) {
      return;
    }
    if (canApply === false) {
      return;
    }
    const model = resolvePostConnectionModel({
      provider: outcome.provider,
      preferredModel: preferredModelByProvider?.[outcome.provider],
      options: modelOptionsByProvider[outcome.provider],
    });
    if (!model || consumedTokenRef.current === intent.token) {
      return;
    }
    consumedTokenRef.current = intent.token;
    controller.clear(intent.token);
    onProviderModelChange(outcome.provider, model);
  }, [
    canApply,
    controller,
    connectionDialogOpen,
    connectionDialogProvider,
    connectionDialogSource,
    loadingModelProviders,
    lockedProvider,
    modelOptionsByProvider,
    onProviderModelChange,
    preferredModelByProvider,
    scopeKey,
    statuses,
  ]);
}
