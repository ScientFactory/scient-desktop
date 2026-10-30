import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ComputeLanguageRuntimeInventory, EnvironmentId } from "@t3tools/contracts";

import { SettingsPageContainer } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { ExtensionGrid } from "~/scient/extensions/ExtensionRow";
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
  computeLanguageDetail,
  computeLanguageDownloadUrl,
} from "./computeInstallationSettingsModel";
import { useComputeLanguages } from "./useComputeLanguages";

/** One language, drawn like an extension: the whole row opens its page. */
function LanguageRow({
  language,
  environmentId,
  detail,
  trailing,
}: {
  language: ComputeLanguageRuntimeInventory;
  environmentId: EnvironmentId;
  detail: string;
  trailing?: ReactNode;
}) {
  const languageId = language.descriptor.languageId;
  return (
    <li className="flex min-w-0 flex-col" data-compute-language={languageId}>
      <div className="relative flex items-center gap-3 rounded-xl p-2 transition-colors has-[a:hover]:bg-foreground/[0.035] has-[a:focus-visible]:outline has-[a:focus-visible]:outline-ring">
        <ComputeLanguageMark languageId={languageId} />
        <div className="min-w-0 flex-1">
          <Link
            to="/settings/scientific-computing/$languageId"
            params={{ languageId }}
            search={{ environmentId }}
            className="block truncate text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-xl"
          >
            {language.descriptor.displayName}
          </Link>
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        </div>
        {trailing ? <div className="relative z-10 shrink-0">{trailing}</div> : null}
      </div>
    </li>
  );
}

function LanguagesOverview({ environmentId }: { environmentId: EnvironmentId }) {
  const inventory = useComputeLanguages(environmentId);
  const here = inventory.languages.filter(
    (language) => inventory.pending || !computeLanguageAbsent(language),
  );
  const notHere = inventory.pending ? [] : inventory.languages.filter(computeLanguageAbsent);
  return (
    <SettingsPageContainer>
      <div className="@container/extensions grid gap-10">
        <ExtensionsSection
          id="scientific-computing"
          title="On this computer"
          action={<FindRuntimesButton inventory={inventory} />}
        >
          <ExtensionGrid label="Languages on this computer">
            {here.map((language) => {
              const preference = inventory.preferenceFor(language);
              return (
                <LanguageRow
                  key={language.descriptor.languageId}
                  language={language}
                  environmentId={environmentId}
                  detail={
                    inventory.pending
                      ? "Checking…"
                      : computeLanguageDetail(
                          language,
                          computeCurrentRuntimeSummary({
                            language,
                            preference,
                            managed: language.managedRuntime,
                          }),
                          preference,
                          language.managedRuntime,
                        )
                  }
                />
              );
            })}
          </ExtensionGrid>
        </ExtensionsSection>
        {notHere.length > 0 ? (
          <ExtensionsSection id="scientific-computing-more" title="Not installed">
            <ExtensionGrid label="Languages not installed">
              {notHere.map((language) => {
                const url = computeLanguageDownloadUrl(language);
                return (
                  <LanguageRow
                    key={language.descriptor.languageId}
                    language={language}
                    environmentId={environmentId}
                    detail={language.descriptor.setup?.needs ?? "Not found on this computer"}
                    trailing={
                      url ? (
                        <Button
                          size="xs"
                          variant="outline"
                          aria-label={`Get ${language.descriptor.displayName}`}
                          render={<a href={url} target="_blank" rel="noreferrer" />}
                        >
                          Get <ExternalLinkIcon />
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Coming soon</span>
                      )
                    }
                  />
                );
              })}
            </ExtensionGrid>
          </ExtensionsSection>
        ) : null}
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
