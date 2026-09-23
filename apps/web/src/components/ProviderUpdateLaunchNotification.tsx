import { useNavigate } from "@tanstack/react-router";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironments } from "~/state/environments";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { ProviderUpdateEnvironmentRows } from "./ProviderUpdateEnvironmentRows";
import { useLocalEnvironmentUpdateGroups } from "./ProviderUpdateLaunchNotification.environments";
import {
  collectProviderUpdateCandidates,
  collectManagedRuntimeUpdateCandidates,
  environmentGroupsWithUpdates,
  getProviderUpdateInitialToastView,
  localEnvironmentUpdateNotificationKey,
  managedRuntimeUpdateNotificationKey,
} from "./ProviderUpdateLaunchNotification.logic";
import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";
import { stackedThreadToast, toastManager } from "./ui/toast";

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

function ManagedRuntimeUpdateNotification() {
  const navigate = useNavigate();
  const { groups } = useLocalEnvironmentUpdateGroups();
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();
  const candidates = useMemo(() => collectManagedRuntimeUpdateCandidates(groups), [groups]);
  const notificationKey = useMemo(
    () => managedRuntimeUpdateNotificationKey(candidates),
    [candidates],
  );
  const activeToastRef = useRef<{
    readonly toastId: ProviderUpdateToastId;
    readonly key: string;
  } | null>(null);

  const openProviderSettings = useCallback(() => {
    const candidate = candidates[0];
    const active = activeToastRef.current;
    if (active !== null) {
      activeToastRef.current = null;
      toastManager.close(active.toastId);
    }
    if (candidate) {
      void navigate({
        to: "/settings/providers",
        search: {
          environmentId: candidate.environmentId,
          instanceId: candidate.provider.instanceId,
        },
      });
    }
  }, [candidates, navigate]);

  useEffect(() => {
    return () => {
      const active = activeToastRef.current;
      if (active !== null) {
        activeToastRef.current = null;
        toastManager.close(active.toastId);
      }
    };
  }, []);

  useEffect(() => {
    const active = activeToastRef.current;
    if (active && active.key !== notificationKey) {
      // This is a state change, not a user dismissal. Clear ownership before
      // closing so the old toast cannot dismiss the new update set.
      activeToastRef.current = null;
      toastManager.close(active.toastId);
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
        ? "Open provider settings to review or install the Scient-managed update."
        : `Updates are ready for ${labels.join(", ")}. Open provider settings to review them.`;
    const dismissPrompt = () => {
      if (activeToastRef.current?.key !== notificationKey) return;
      activeToastRef.current = null;
      dismissNotificationKey(notificationKey);
    };
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "warning",
        title,
        description,
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
    candidates,
    dismissedNotificationKeys,
    dismissNotificationKey,
    notificationKey,
    openProviderSettings,
  ]);

  return null;
}
