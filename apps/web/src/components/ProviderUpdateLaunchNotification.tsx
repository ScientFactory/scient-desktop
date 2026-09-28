import { useNavigate } from "@tanstack/react-router";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironments } from "~/state/environments";
import { useStartProviderRuntimeAction } from "~/scient/providerConnection/useProviderLifecycleController";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { ProviderUpdateEnvironmentRows } from "./ProviderUpdateEnvironmentRows";
import { useLocalEnvironmentUpdateGroups } from "./ProviderUpdateLaunchNotification.environments";
import {
  collectProviderUpdateCandidates,
  collectManagedRuntimeUpdateCandidates,
  environmentGroupsWithUpdates,
  getManagedRuntimeUpdateResultToastView,
  getManagedRuntimeUpdateRunningToastView,
  getManagedRuntimeUpdateWaitingToastView,
  getProviderUpdateInitialToastView,
  localEnvironmentUpdateNotificationKey,
  managedRuntimeUpdateNotificationKey,
  managedRuntimeUpdateTargets,
  settleManagedRuntimeUpdateRuns,
  type ManagedRuntimeUpdateOutcome,
  type ManagedRuntimeUpdateRun,
  type ManagedRuntimeUpdateTarget,
} from "./ProviderUpdateLaunchNotification.logic";
import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "./ui/toast";

/**
 * True when a desktop-local secondary backend (the parallel WSL backend) is
 * present alongside the primary. Local secondaries connect over loopback with a
 * `local:<backendInstanceId>` bearer connection id; everything else (SSH, relay,
 * remote) is ignored. Gating on this keeps non-WSL users on the unchanged
 * single-prompt flow.
 */
function useHasLocalSecondaryEnvironment(): boolean {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environments.some((environment) => isDesktopLocalConnectionTarget(environment.entry.target)),
    [environments],
  );
}

/**
 * The provider update popover. With a WSL backend present it splits the update
 * trigger per environment; without one (the common case) it falls back to the
 * single-prompt flow so non-WSL users see no change.
 */
export function ProviderUpdateLaunchNotification() {
  const hasLocalSecondary = useHasLocalSecondaryEnvironment();

  return hasLocalSecondary ? (
    <>
      <ProviderUpdateEnvironmentsNotification />
      <ManagedRuntimeUpdateNotification />
    </>
  ) : (
    <>
      <ProviderUpdatePrimaryNotification />
      <ManagedRuntimeUpdateNotification />
    </>
  );
}

const seenProviderUpdateNotificationKeys = new Set<string>();
type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;

// While a local backend (e.g. WSL) is still connecting, defer the popover so it
// reflects every environment. Cap the wait so a stuck or failed backend can't
// suppress the primary's updates indefinitely.
const SETTLING_GRACE_MS = 30_000;

function ProviderUpdateEnvironmentsNotification() {
  const navigate = useNavigate();
  const { groups, isAnySettling } = useLocalEnvironmentUpdateGroups();
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();

  const activeToastRef = useRef<{
    readonly toastId: ProviderUpdateToastId;
    readonly key: string;
  } | null>(null);
  const notificationKeyRef = useRef<string | null>(null);
  // Whether the user has triggered an update from the current toast. Until they
  // do, the prompt is replaced when the available updates change; afterward it
  // is kept so in-progress rows are not torn down.
  const hasInteractedRef = useRef(false);

  // Close our prompt if this flow unmounts (e.g. the WSL backend is disabled
  // and we fall back to the single-prompt flow).
  useEffect(() => {
    return () => {
      if (activeToastRef.current !== null) {
        toastManager.close(activeToastRef.current.toastId);
        activeToastRef.current = null;
      }
    };
  }, []);

  const updateGroups = useMemo(() => environmentGroupsWithUpdates(groups), [groups]);
  const notificationKey = useMemo(() => localEnvironmentUpdateNotificationKey(groups), [groups]);
  useEffect(() => {
    notificationKeyRef.current = notificationKey;
  }, [notificationKey]);

  // Title summarizes the distinct providers on offer across all environments;
  // the per-environment detail lives in the popover body.
  const candidateUnion = useMemo(
    () => collectProviderUpdateCandidates(updateGroups.flatMap((group) => group.candidates)),
    [updateGroups],
  );

  // Defer while any local backend is still connecting, up to the grace period.
  const [settleGraceElapsed, setSettleGraceElapsed] = useState(false);
  useEffect(() => {
    if (!isAnySettling) {
      setSettleGraceElapsed(false);
      return;
    }
    const timer = setTimeout(() => setSettleGraceElapsed(true), SETTLING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isAnySettling]);
  const isGated = isAnySettling && !settleGraceElapsed;

  const openProviderSettings = useCallback(() => {
    const active = activeToastRef.current;
    if (active !== null) {
      toastManager.close(active.toastId);
      activeToastRef.current = null;
    }
    void navigate({ to: "/settings/providers" });
  }, [navigate]);

  useEffect(() => {
    // Whether a fresh prompt can actually be shown for the current update set.
    const canShowPrompt =
      notificationKey !== null &&
      !isGated &&
      !dismissedNotificationKeys.has(notificationKey) &&
      !seenProviderUpdateNotificationKeys.has(notificationKey);

    // Close a prompt the user hasn't acted on yet when the available updates
    // change: when they clear entirely (key null) so the toast doesn't linger,
    // and when a fresh set is ready to replace it. Keep it only while a backend
    // is re-settling (updates still exist, just gated) — and once an update is
    // in progress, so its rows survive.
    const active = activeToastRef.current;
    if (
      active &&
      active.key !== notificationKey &&
      !hasInteractedRef.current &&
      (notificationKey === null || !isGated)
    ) {
      toastManager.close(active.toastId);
      activeToastRef.current = null;
    }

    if (!notificationKey || !canShowPrompt || activeToastRef.current !== null) {
      return;
    }

    seenProviderUpdateNotificationKeys.add(notificationKey);
    hasInteractedRef.current = false;

    const dismissPrompt = () => {
      // Dismiss whatever set is still on offer at close time, so the popover
      // does not re-pop for updates the user just declined.
      const liveKey = notificationKeyRef.current;
      if (liveKey) {
        dismissNotificationKey(liveKey);
      }
      activeToastRef.current = null;
    };

    const toastId = toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: getProviderUpdateInitialToastView({
          updateProviders: candidateUnion,
          oneClickProviders: candidateUnion,
        }).title,
        description: (
          <ProviderUpdateEnvironmentRows
            onInteract={() => {
              hasInteractedRef.current = true;
            }}
          />
        ),
        timeout: 0,
        actionProps: {
          children: "Settings",
          onClick: openProviderSettings,
        },
        actionVariant: "outline",
        data: {
          hideCopyButton: true,
          leadingIcon: <DownloadIcon aria-hidden="true" className="size-4 text-success" />,
          onClose: dismissPrompt,
        },
      }),
    );
    activeToastRef.current = { toastId, key: notificationKey };
  }, [
    notificationKey,
    isGated,
    candidateUnion,
    dismissedNotificationKeys,
    dismissNotificationKey,
    openProviderSettings,
  ]);

  return null;
}

const seenManagedRuntimeUpdateKeys = new Set<string>();
let nextManagedRuntimeUpdateId = 0;

type ActiveManagedRuntimeToast =
  | { readonly kind: "prompt"; readonly key: string; readonly toastId: ProviderUpdateToastId }
  | {
      readonly kind: "updating";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
      readonly updateId: number;
      readonly runs: ReadonlyArray<ManagedRuntimeUpdateRun>;
      readonly startsFinished: boolean;
      /** The waiting message the progress notice currently shows, if any. */
      readonly shownWaitingMessage: string | null;
    };
type ActiveManagedRuntimeUpdate = Extract<ActiveManagedRuntimeToast, { kind: "updating" }>;

function managedRuntimeSettingsSearch(targets: ReadonlyArray<ManagedRuntimeUpdateTarget>) {
  const [only] = targets;
  return targets.length === 1 && only
    ? { environmentId: only.environmentId, instanceId: only.instanceId }
    : undefined;
}

function startFailure(error: unknown): ManagedRuntimeUpdateOutcome {
  return {
    status: "failed",
    message:
      error instanceof Error
        ? error.message
        : "Scient could not start the update. Review the provider in Settings.",
  };
}

/**
 * Offers a reviewed Scient-managed runtime update and starts it in place. The
 * server stages the update while turns run and switches runtimes once the
 * provider is idle; this notice follows that operation to its result.
 */
export function ManagedRuntimeUpdateNotification() {
  const navigate = useNavigate();
  const { groups } = useLocalEnvironmentUpdateGroups();
  const startRuntimeAction = useStartProviderRuntimeAction();
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();
  const candidates = useMemo(() => collectManagedRuntimeUpdateCandidates(groups), [groups]);
  const notificationKey = useMemo(
    () => managedRuntimeUpdateNotificationKey(candidates),
    [candidates],
  );
  const activeToastRef = useRef<ActiveManagedRuntimeToast | null>(null);
  const groupsRef = useRef(groups);
  const startUpdatesRef = useRef<
    (key: string, targets: ReadonlyArray<ManagedRuntimeUpdateTarget>) => void
  >(() => {});

  // Replacing or closing our own toast is a state change, not a user dismissal:
  // release ownership before closing so its onClose cannot record one.
  const releaseActiveToast = useCallback(() => {
    const active = activeToastRef.current;
    activeToastRef.current = null;
    if (active !== null) toastManager.close(active.toastId);
  }, []);

  const openProviderSettings = useCallback(
    (targets: ReadonlyArray<ManagedRuntimeUpdateTarget>, toastId?: ProviderUpdateToastId) => {
      if (toastId !== undefined && activeToastRef.current?.toastId !== toastId) {
        toastManager.close(toastId);
      } else if (activeToastRef.current?.kind === "prompt") {
        releaseActiveToast();
      }
      const search = managedRuntimeSettingsSearch(targets);
      void navigate({ to: "/settings/providers", ...(search ? { search } : {}) });
    },
    [navigate, releaseActiveToast],
  );

  useEffect(() => releaseActiveToast, [releaseActiveToast]);

  const settleActiveUpdate = useCallback(() => {
    const active = activeToastRef.current;
    if (active?.kind !== "updating") return;
    const runs = settleManagedRuntimeUpdateRuns(active.runs, groupsRef.current);
    const targets = runs.map(({ target }) => target);
    const waitingMessage =
      runs.find(({ waitingMessage: message }) => message !== null)?.waitingMessage ?? null;
    if (waitingMessage !== active.shownWaitingMessage) {
      const view =
        waitingMessage !== null
          ? getManagedRuntimeUpdateWaitingToastView(targets, waitingMessage)
          : getManagedRuntimeUpdateRunningToastView(targets);
      toastManager.update(active.toastId, {
        title: view.title,
        description: view.description,
        actionProps:
          waitingMessage !== null
            ? { children: "Settings", onClick: () => openProviderSettings(targets) }
            : hiddenToastActionProps,
      });
    }
    activeToastRef.current = { ...active, runs, shownWaitingMessage: waitingMessage };
    const settled = runs.flatMap(({ target, outcome }) =>
      outcome.status === "pending" ? [] : [{ target, outcome }],
    );
    if (!active.startsFinished || settled.length < runs.length) return;

    releaseActiveToast();
    const view = getManagedRuntimeUpdateResultToastView(settled);
    if (view === null) return;
    if (view.type === "success") {
      toastManager.add({
        type: view.type,
        title: view.title,
        description: view.description,
        timeout: 0,
        actionProps: hiddenToastActionProps,
        data: {
          hideCopyButton: true,
          ...(view.dismissAfterVisibleMs !== undefined
            ? { dismissAfterVisibleMs: view.dismissAfterVisibleMs }
            : {}),
        },
      });
      return;
    }
    const failedTargets = settled.flatMap(({ target, outcome }) =>
      outcome.status === "failed" ? [target] : [],
    );
    let toastId!: ProviderUpdateToastId;
    toastId = toastManager.add(
      stackedThreadToast({
        type: view.type,
        title: view.title,
        description: view.description,
        timeout: 0,
        actionProps: {
          children: "Retry",
          onClick: () => {
            toastManager.close(toastId);
            if (activeToastRef.current === null) startUpdatesRef.current(active.key, failedTargets);
          },
        },
        actionVariant: "outline",
        data: {
          secondaryActionProps: {
            children: "Settings",
            onClick: () => openProviderSettings(failedTargets, toastId),
          },
          secondaryActionVariant: "outline",
        },
      }),
    );
  }, [openProviderSettings, releaseActiveToast]);

  const startUpdates = useCallback(
    (key: string, targets: ReadonlyArray<ManagedRuntimeUpdateTarget>) => {
      const view = getManagedRuntimeUpdateRunningToastView(targets);
      releaseActiveToast();
      const updateId = ++nextManagedRuntimeUpdateId;
      activeToastRef.current = {
        kind: "updating",
        key,
        updateId,
        toastId: toastManager.add({
          type: view.type,
          title: view.title,
          description: view.description,
          timeout: 0,
          actionProps: hiddenToastActionProps,
          data: { hideCopyButton: true },
        }),
        runs: targets.map((target) => ({
          target,
          operationId: null,
          observed: false,
          outcome: { status: "pending" },
          waitingMessage: null,
        })),
        startsFinished: false,
        shownWaitingMessage: null,
      };
      const updateCurrent = (
        update: (active: ActiveManagedRuntimeUpdate) => ActiveManagedRuntimeUpdate,
      ) => {
        const active = activeToastRef.current;
        if (active?.kind !== "updating" || active.updateId !== updateId) return false;
        activeToastRef.current = update(active);
        return true;
      };
      void (async () => {
        // One at a time: each environment's runtime manager serializes its driver.
        for (const [index, target] of targets.entries()) {
          const started = await startRuntimeAction({
            environmentId: target.environmentId,
            instanceId: target.instanceId,
            action: "update",
          }).then(
            (provider) => {
              const operationId = provider.connection?.runtime?.operation?.operationId ?? null;
              return {
                operationId,
                outcome:
                  operationId === null
                    ? startFailure(undefined)
                    : ({ status: "pending" } as ManagedRuntimeUpdateOutcome),
              };
            },
            (error: unknown) => ({ operationId: null, outcome: startFailure(error) }),
          );
          const current = updateCurrent((active) => ({
            ...active,
            runs: active.runs.map((run, runIndex) =>
              runIndex === index ? { ...run, ...started } : run,
            ),
          }));
          if (!current) return;
        }
        if (updateCurrent((active) => ({ ...active, startsFinished: true }))) {
          settleActiveUpdate();
        }
      })();
    },
    [releaseActiveToast, settleActiveUpdate, startRuntimeAction],
  );

  useEffect(() => {
    startUpdatesRef.current = startUpdates;
  }, [startUpdates]);

  useEffect(() => {
    groupsRef.current = groups;
    settleActiveUpdate();
  }, [groups, settleActiveUpdate]);

  useEffect(() => {
    const active = activeToastRef.current;
    if (active?.kind === "prompt" && active.key !== notificationKey) {
      releaseActiveToast();
    }

    if (
      !notificationKey ||
      activeToastRef.current !== null ||
      dismissedNotificationKeys.has(notificationKey) ||
      seenManagedRuntimeUpdateKeys.has(notificationKey)
    ) {
      return;
    }

    seenManagedRuntimeUpdateKeys.add(notificationKey);
    const targets = managedRuntimeUpdateTargets(candidates);
    const labels = candidates.map(({ provider, environmentLabel, availableVersion }) => {
      const name = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
      const version = availableVersion
        ? ` ${availableVersion.startsWith("v") ? availableVersion : `v${availableVersion}`}`
        : "";
      return `${name}${version} in ${environmentLabel}`;
    });
    const title =
      candidates.length === 1
        ? `Update available for ${labels[0]}`
        : `${candidates.length} managed provider updates available`;
    const description =
      candidates.length === 1
        ? "A verified Scient-managed update is ready to install."
        : `Verified updates are ready for ${labels.join(", ")}.`;
    let toastId!: ProviderUpdateToastId;
    const isCurrentPrompt = () =>
      activeToastRef.current?.kind === "prompt" && activeToastRef.current.toastId === toastId;
    const dismissPrompt = () => {
      if (!isCurrentPrompt()) return;
      activeToastRef.current = null;
      dismissNotificationKey(notificationKey);
    };
    toastId = toastManager.add(
      stackedThreadToast({
        type: "warning",
        title,
        description,
        timeout: 0,
        actionProps: {
          children: "Update",
          onClick: () => {
            if (isCurrentPrompt()) startUpdates(notificationKey, targets);
          },
        },
        actionVariant: "outline",
        data: {
          hideCopyButton: true,
          leadingIcon: <DownloadIcon aria-hidden="true" className="size-4 text-success" />,
          onClose: dismissPrompt,
          secondaryActionProps: {
            children: "Settings",
            onClick: () => openProviderSettings(targets),
          },
          secondaryActionVariant: "outline",
        },
      }),
    );
    activeToastRef.current = { kind: "prompt", key: notificationKey, toastId };
  }, [
    candidates,
    dismissedNotificationKeys,
    dismissNotificationKey,
    notificationKey,
    openProviderSettings,
    releaseActiveToast,
    startUpdates,
  ]);

  return null;
}
