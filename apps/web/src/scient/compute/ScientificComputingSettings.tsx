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
  computeLanguageGroups,
  computeLanguageStatus,
  type ComputeLanguageEntry,
} from "./computeInstallationSettingsModel";
import { useComputeLanguages, type ComputeLanguages } from "./useComputeLanguages";

/** One language, drawn like an extension: the whole row opens its page. */
function LanguageRow({
  languageId,
  name,
  environmentId,
  comingSoon = false,
  detail,
  trailing,
}: {
  languageId: string;
  name: string;
  environmentId: EnvironmentId;
  comingSoon?: boolean;
  detail: string;
  trailing?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col" data-compute-language={languageId}>
      <div className="relative flex items-center gap-3 rounded-xl p-2 transition-colors has-[a:hover]:bg-foreground/[0.035] has-[a:focus-visible]:outline has-[a:focus-visible]:outline-ring">
        <ComputeLanguageMark languageId={languageId} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <Link
              to="/settings/scientific-computing/$languageId"
              params={{ languageId }}
              search={{ environmentId }}
              className="text-sm font-medium wrap-anywhere text-foreground outline-none after:absolute after:inset-0 after:rounded-xl"
            >
              {name}
            </Link>
            {comingSoon ? (
              <span className="shrink-0 text-xs text-muted-foreground">Coming soon</span>
            ) : null}
          </div>
          {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        {trailing ? <div className="relative z-10 shrink-0">{trailing}</div> : null}
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
  const row = { languageId, name, environmentId };
  if (inventory.pending) return <LanguageRow {...row} detail="Checking…" />;
  if (runtime === undefined) return <LanguageRow {...row} comingSoon detail="" />;
  const status = computeLanguageStatus({
    language: runtime,
    preference: inventory.preferenceFor(runtime),
    incomplete: inventory.incomplete,
  });
  return (
    <LanguageRow
      {...row}
      comingSoon={status.comingSoon}
      detail={status.detail}
      {...(status.getUrl === undefined
        ? {}
        : {
            trailing: (
              <Button
                size="xs"
                variant="outline"
                aria-label={`Get ${name}`}
                render={<a href={status.getUrl} target="_blank" rel="noreferrer" />}
              >
                Get <ExternalLinkIcon />
              </Button>
            ),
          })}
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
