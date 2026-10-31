import { useNavigate } from "@tanstack/react-router";
import {
  AuthProvidersManageScope,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import { useProviderUpdates } from "~/components/ProviderUpdatesAction";
import { collectProviderUpdateCandidates } from "~/components/ProviderUpdateLaunchNotification.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { readEnvironmentScope, useEnvironmentsWithScope } from "~/state/session";
import { managedRuntimeUpdateNotificationKey } from "./ManagedRuntimeUpdateNotification.logic";
import {
  connectedProviderEnvironments,
  useManagedRuntimeUpdates,
} from "./useManagedRuntimeUpdates";

const dismissalsSchema = Schema.Struct({ keys: Schema.Array(Schema.String) });
const seenNotificationKeys = new Set<string>();

interface AvailabilityNotice {
  readonly key: string | null;
  readonly title: string;
  readonly description: string;
  readonly update?: {
    readonly environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
    readonly run: () => Promise<unknown>;
  };
  readonly settings: () => void;
}

function useAvailabilityNotice(notice: AvailabilityNotice) {
  const updateEnvironments = notice.update?.environments ?? [];
  const allowedEnvironments = useEnvironmentsWithScope(
    updateEnvironments,
    AuthProvidersManageScope,
  );
  const canUpdate = updateEnvironments.every(({ environmentId }) =>
    allowedEnvironments.has(environmentId),
  );
  // Keep the existing browser dismissal namespace and published-version identities.
  const [dismissals, setDismissals] = useLocalStorage(
    "t3code:provider-update-dismissals:v1",
    { keys: [] },
    dismissalsSchema,
  );
  const active = useRef<{ readonly id: string; readonly key: string } | null>(null);
  const close = useStableCallback(() => {
    const previous = active.current;
    active.current = null;
    if (previous) toastManager.close(previous.id);
  });
  const settings = useStableCallback((key: string) => {
    if (active.current?.key !== key || notice.key !== key) return;
    close();
    notice.settings();
  });
  const update = useStableCallback((key: string) => {
    if (active.current?.key !== key || notice.key !== key) return;
    if (
      !notice.update ||
      !notice.update.environments.every(({ environmentId }) =>
        readEnvironmentScope(environmentId, AuthProvidersManageScope),
      )
    ) {
      return;
    }
    close();
    // Execution and result reporting remain in the shared update owners.
    void notice.update.run();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the imperative toast on unmount
  useEffect(() => close, [close]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the imperative update-notification toast in step with the current notice
  useEffect(() => {
    if (active.current?.key !== notice.key) close();
    const key = notice.key;
    if (key === null) return;
    const actionProps = {
      children: notice.update ? "Update" : "Settings",
      disabled: notice.update !== undefined && !canUpdate,
      onClick: () => (notice.update ? update(key) : settings(key)),
    };
    let id = active.current?.id;
    const data = {
      hideCopyButton: true,
      ...(notice.update
        ? {
            secondaryActionProps: { children: "Settings", onClick: () => settings(key) },
            secondaryActionVariant: "outline" as const,
          }
        : {}),
      onClose: () => {
        if (active.current === null || active.current.id !== id) return;
        active.current = null;
        setDismissals((current) => ({
          keys: current.keys.includes(key) ? current.keys : [...current.keys, key],
        }));
      },
    };
    const options = stackedThreadToast({
      type: "warning",
      title: notice.title,
      description: notice.description,
      timeout: 0,
      actionProps,
      actionVariant: "outline",
      data,
    });
    if (id !== undefined) {
      toastManager.update(id, options);
      return;
    }
    if (dismissals.keys.includes(key) || seenNotificationKeys.has(key)) {
      return;
    }
    seenNotificationKeys.add(key);
    id = toastManager.add(options);
    active.current = { id, key };
  }, [notice, canUpdate, dismissals.keys, setDismissals, close, settings, update]);
}

function BrowserAvailabilityNotices() {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const cliUpdates = useProviderUpdates();
  const managedUpdates = useManagedRuntimeUpdates();
  const groups = connectedProviderEnvironments(environments, providersByEnvironment).flatMap(
    (environment) => {
      const candidates = collectProviderUpdateCandidates(environment.providers);
      return candidates.length > 0 ? [{ ...environment, candidates }] : [];
    },
  );
  const parts = groups.map((group) => ({
    environmentId: group.environmentId,
    providers: group.candidates
      .map((provider) => `${provider.driver}:${provider.versionAdvisory.latestVersion}`)
      .toSorted(),
  }));
  const only = parts[0];
  const cliKey =
    only === undefined
      ? null
      : parts.length === 1 && only.environmentId === primaryEnvironmentId
        ? only.providers.join("|")
        : parts
            .map(({ environmentId, providers }) => `${environmentId}=${providers.join(",")}`)
            .toSorted()
            .join("|");
  const labels = groups.flatMap((group) =>
    group.candidates.map(
      (provider) =>
        `${PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver} ${provider.versionAdvisory.latestVersion} in ${group.label}`,
    ),
  );
  useAvailabilityNotice({
    key: cliKey,
    title:
      labels.length === 1
        ? `Update available for ${labels[0]}`
        : `${labels.length} provider updates available`,
    description:
      "Review provider settings, or update with the app or tool that installed the provider.",
    ...(cliUpdates.machines.length > 0
      ? {
          update: {
            environments: cliUpdates.machines,
            run: () => cliUpdates.updateAll(),
          },
        }
      : {}),
    settings: () => {
      void navigate({ to: "/settings/providers" });
    },
  });
  const targets = managedUpdates.targets;
  const managedLabels = managedUpdates.candidates.map(
    ({ provider, environmentLabel, availableVersion }) =>
      `${PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver}${availableVersion ? ` ${availableVersion.startsWith("v") ? availableVersion : `v${availableVersion}`}` : ""} in ${environmentLabel}`,
  );
  useAvailabilityNotice({
    key: managedRuntimeUpdateNotificationKey(managedUpdates.candidates),
    title:
      managedLabels.length === 1
        ? `Update available for ${managedLabels[0]}`
        : `${managedLabels.length} managed provider updates available`,
    description: "A verified Scient-managed update is ready to install.",
    update: {
      environments: targets,
      run: () => managedUpdates.update(targets),
    },
    settings: () => {
      const onlyTarget = targets.length === 1 ? targets[0] : undefined;
      void navigate({
        to: "/settings/providers",
        ...(onlyTarget
          ? {
              search: {
                environmentId: onlyTarget.environmentId,
                instanceId: onlyTarget.instanceId,
              },
            }
          : {}),
      });
    },
  });
  return null;
}

/** Desktop availability belongs to the circle; browser clients retain launch notices. */
export function BrowserProviderUpdateNotification() {
  return isElectron ? null : <BrowserAvailabilityNotices />;
}
