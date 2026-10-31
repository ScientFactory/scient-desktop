import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { SettingsPageContainer } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { ExtensionsSection } from "~/scient/extensions/ExtensionsPage";
import { ComputeLanguageMark } from "./ComputeLanguageMark";
import {
  ComputeInventoryFailure,
  ComputeSettingsUnavailable,
  FindRuntimesButton,
  useComputeSettingsEnvironment,
} from "./ComputeLanguagePage";
import {
  computeCurrentRuntimeSummary,
  computeLanguageAbsent,
  computeLanguageComingSoon,
  computeLanguageDetail,
  computeLanguageDownloadUrl,
  computeLanguageGroups,
  type ComputeLanguageEntry,
} from "./computeInstallationSettingsModel";
import { useComputeLanguages, type ComputeLanguages } from "./useComputeLanguages";

/** One language, drawn like an extension: the whole row opens its page. */
function LanguageRow({
  languageId,
  name,
  environmentId,
  detail,
  trailing,
}: {
  languageId: string;
  name: string;
  environmentId: EnvironmentId;
  detail: string;
  trailing?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col" data-compute-language={languageId}>
      <div className="relative flex items-center gap-3 rounded-xl p-2 transition-colors has-[a:hover]:bg-foreground/[0.035] has-[a:focus-visible]:outline has-[a:focus-visible]:outline-ring">
        <ComputeLanguageMark languageId={languageId} />
        <div className="min-w-0 flex-1">
          <Link
            to="/settings/scientific-computing/$languageId"
            params={{ languageId }}
            search={{ environmentId }}
            className="block text-sm font-medium wrap-anywhere text-foreground outline-none after:absolute after:inset-0 after:rounded-xl"
          >
            {name}
          </Link>
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        </div>
        {trailing ? <div className="relative z-10 shrink-0">{trailing}</div> : null}
      </div>
    </li>
  );
}

/** Nothing opens yet, so this is a name and not a link. */
function ComingSoonRow({
  languageId,
  name,
  checking,
}: {
  languageId: string;
  name: string;
  checking: boolean;
}) {
  return (
    <li className="flex min-w-0 items-center gap-3 p-2" data-compute-coming-soon={languageId}>
      <ComputeLanguageMark languageId={languageId} />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        {checking ? null : (
          <span className="shrink-0 text-xs text-muted-foreground">Coming soon</span>
        )}
      </div>
    </li>
  );
}

/** A language wherever it is listed: what it runs on, where to get it, or not yet. */
function LanguageEntry({
  entry: { languageId, name, runtime },
  inventory,
  environmentId,
}: {
  entry: ComputeLanguageEntry;
  inventory: ComputeLanguages;
  environmentId: EnvironmentId;
}) {
  if (runtime === undefined || (!inventory.pending && computeLanguageComingSoon(runtime))) {
    return <ComingSoonRow languageId={languageId} name={name} checking={inventory.pending} />;
  }
  const row = { languageId, name, environmentId };
  if (inventory.pending) return <LanguageRow {...row} detail="Checking…" />;
  if (computeLanguageAbsent(runtime)) {
    return (
      <LanguageRow
        {...row}
        detail={runtime.descriptor.setup === undefined ? "Not found" : "No kernel found"}
        trailing={
          <Button
            size="xs"
            variant="outline"
            aria-label={`Get ${name}`}
            render={
              <a href={computeLanguageDownloadUrl(runtime)} target="_blank" rel="noreferrer" />
            }
          >
            Get <ExternalLinkIcon />
          </Button>
        }
      />
    );
  }
  const preference = inventory.preferenceFor(runtime);
  return (
    <LanguageRow
      {...row}
      detail={computeLanguageDetail(
        runtime,
        computeCurrentRuntimeSummary({
          language: runtime,
          preference,
          managed: runtime.managedRuntime,
        }),
        preference,
        runtime.managedRuntime,
      )}
    />
  );
}

function LanguagesOverview({ environmentId }: { environmentId: EnvironmentId }) {
  const inventory = useComputeLanguages(environmentId);
  return (
    <SettingsPageContainer>
      <div className="@container/extensions grid gap-10">
        {computeLanguageGroups(inventory.languages).map((group, index) => (
          <ExtensionsSection
            key={group.title}
            title={group.title}
            {...(index === 0
              ? {
                  id: "scientific-computing",
                  action: <FindRuntimesButton inventory={inventory} />,
                }
              : {})}
          >
            <ul
              aria-label={group.title}
              className="-mx-2 grid grid-cols-1 gap-x-6 gap-y-1 @min-[440px]/extensions:grid-cols-2 @min-[840px]/extensions:grid-cols-3"
            >
              {group.entries.map((entry) => (
                <LanguageEntry
                  key={entry.languageId}
                  entry={entry}
                  inventory={inventory}
                  environmentId={environmentId}
                />
              ))}
            </ul>
          </ExtensionsSection>
        ))}
        <ComputeInventoryFailure inventory={inventory} />
      </div>
    </SettingsPageContainer>
  );
}

/** Every language at a glance; each opens its own page. */
export function ScientificComputingSettings(
  props: { environmentId?: EnvironmentId | undefined } = {},
) {
  const environmentId = useComputeSettingsEnvironment(props.environmentId);
  if (environmentId === null) return <ComputeSettingsUnavailable />;
  return <LanguagesOverview key={environmentId} environmentId={environmentId} />;
}
