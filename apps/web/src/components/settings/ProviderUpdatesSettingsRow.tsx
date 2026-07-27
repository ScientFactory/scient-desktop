// FILE: ProviderUpdatesSettingsRow.tsx
// Purpose: Render truthful Settings provider-update summary and action states.
// Layer: Settings component
// Exports: ProviderUpdatesSettingsRow

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerSettings,
} from "@synara/contracts";
import type { ReactNode } from "react";

import {
  getVisibleProviderUpdateRows,
  isProviderUpdateActive,
  providerUpdateSummaryStatus,
  shouldOfferProviderUpdateAction,
  shouldShowProviderUpdateStatus,
} from "../../providerUpdates";
import { cn } from "../../lib/utils";
import { SETTINGS_INSET_LIST_CLASS_NAME } from "../../settingsPanelStyles";
import { ProviderUpdateActionButton } from "./ProviderUpdateActionButton";
import { SettingsListRow, SettingsRow } from "./SettingsPanelPrimitives";

function formatVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function updateDescription(provider: ServerProviderStatus): string | undefined {
  const state = provider.updateState?.status;
  if (state === "queued") return "Update queued";
  if (state === "running") return "Updating";
  const advisory = provider.versionAdvisory;
  if (advisory?.status === "behind_latest" && advisory.latestVersion) {
    const current = formatVersion(advisory.currentVersion);
    const latest = formatVersion(advisory.latestVersion);
    return current ? `${current} -> ${latest}` : `Latest ${latest}`;
  }
  return undefined;
}

export function ProviderUpdatesSettingsRow({
  providers,
  hiddenProviders,
  serverSettings,
  loading,
  locallyUpdatingProviders,
  onUpdate,
  children,
}: {
  readonly providers: ReadonlyArray<ServerProviderStatus>;
  readonly hiddenProviders: ReadonlyArray<ProviderKind>;
  readonly serverSettings: Pick<ServerSettings, "providers" | "enableProviderUpdateChecks"> | null;
  readonly loading: boolean;
  readonly locallyUpdatingProviders: ReadonlySet<ProviderKind>;
  readonly onUpdate: (provider: ServerProviderStatus) => void;
  readonly children?: ReactNode;
}) {
  const summary = providerUpdateSummaryStatus({
    providers,
    hiddenProviders,
    serverSettings,
    loading,
    locallyUpdatingProviders,
  });
  const rows = getVisibleProviderUpdateRows({
    providers,
    hiddenProviders,
    serverSettings,
    locallyUpdatingProviders,
  });
  const hiddenProviderSet = new Set(hiddenProviders);

  return (
    <SettingsRow
      title="Provider updates"
      description="Review installed provider tools that Scient can safely update."
      status={summary}
    >
      {rows.length > 0 ? (
        <div
          className={cn(
            "mt-4",
            SETTINGS_INSET_LIST_CLASS_NAME,
            "divide-y divide-[color:var(--color-border)]",
          )}
        >
          {rows.map((provider) => {
            const active =
              isProviderUpdateActive(provider) || locallyUpdatingProviders.has(provider.provider);
            const confirmedVisible = shouldShowProviderUpdateStatus({
              provider,
              hiddenProviderSet,
              serverSettings,
            });
            return (
              <SettingsListRow
                key={provider.provider}
                title={PROVIDER_DISPLAY_NAMES[provider.provider]}
                description={updateDescription(provider)}
                actions={
                  shouldOfferProviderUpdateAction(provider) || active ? (
                    <ProviderUpdateActionButton
                      providerStatus={provider}
                      confirmedUpdateVisible={confirmedVisible}
                      locallyUpdating={locallyUpdatingProviders.has(provider.provider)}
                      onUpdate={() => onUpdate(provider)}
                    />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">Manual update</span>
                  )
                }
              />
            );
          })}
        </div>
      ) : null}
      {children}
    </SettingsRow>
  );
}
