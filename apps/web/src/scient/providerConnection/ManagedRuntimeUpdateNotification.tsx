import { useNavigate } from "@tanstack/react-router";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ProviderUpdateToastId } from "~/components/ProviderUpdateLaunchNotification";
import { useLocalEnvironmentUpdateGroups } from "~/components/ProviderUpdateLaunchNotification.environments";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useDismissedProviderUpdateNotificationKeys } from "~/providerUpdateDismissal";

import {
  collectManagedRuntimeUpdateCandidates,
  getManagedRuntimeUpdateResultToastView,
  getManagedRuntimeUpdateRunningToastView,
  getManagedRuntimeUpdateWaitingToastView,
  managedRuntimeUpdateNotificationKey,
  managedRuntimeUpdateTargets,
  settleManagedRuntimeUpdateRuns,
  type ManagedRuntimeUpdateOutcome,
  type ManagedRuntimeUpdateRun,
  type ManagedRuntimeUpdateTarget,
} from "./ManagedRuntimeUpdateNotification.logic";
import { useStartProviderRuntimeAction } from "./useProviderLifecycleController";

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
