import type { ScientSkillCatalogItem, ScientSkillInvocationPolicy } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ArrowRightIcon, ChevronDownIcon, Layers3Icon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";

import { ScientSymbol } from "../../components/ScientSymbol";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Switch } from "../../components/ui/switch";
import { scientSkillsInventory, setScientSkillUserActivation } from "./scientSkillsState";
import { collectExternalSkillProviders, summarizeExternalSkills } from "./externalSkills";

function invocationPolicyLabel(policy: ScientSkillInvocationPolicy): string {
  return policy === "automatic" ? "Agent access" : "$name only";
}

function groupSkillsByCategory(skills: ReadonlyArray<ScientSkillCatalogItem>) {
  const groups = new Map<
    string,
    { category: string; description: string; skills: ScientSkillCatalogItem[] }
  >();
  for (const skill of skills) {
    const group = groups.get(skill.category);
    if (group) group.skills.push(skill);
    else {
      groups.set(skill.category, {
        category: skill.category,
        description: skill.categoryDescription,
        skills: [skill],
      });
    }
  }
  return [...groups.values()];
}

function SkillCategoryDisclosure(props: {
  readonly title: string;
  readonly description: string;
  readonly skillCount: number;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 pt-4 pb-2 text-left outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold tracking-[-0.01em] text-foreground">
            {props.title}
          </span>
          <span className="mt-1 block max-w-xl text-[13.5px] leading-[1.45] text-muted-foreground/80">
            {props.description}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {props.skillCount} {props.skillCount === 1 ? "skill" : "skills"}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>{props.children}</CollapsiblePanel>
    </Collapsible>
  );
}

export function ScientSkillsSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const externalSkillGroups = useMemo(() => collectExternalSkillProviders(providers), [providers]);
  const inventory = useEnvironmentQuery(
    environmentId === null ? null : scientSkillsInventory({ environmentId, input: {} }),
  );
  const setActivation = useAtomCommand(setScientSkillUserActivation, {
    reportFailure: true,
  });
  const [pendingReleaseKey, setPendingReleaseKey] = useState<string | null>(null);

  const updateSkill = async (
    skill: ScientSkillCatalogItem,
    patch: { readonly active?: boolean; readonly invocationPolicy?: ScientSkillInvocationPolicy },
  ) => {
    if (environmentId === null || pendingReleaseKey !== null) return;
    setPendingReleaseKey(skill.releaseKey);
    try {
      await setActivation({
        environmentId,
        input: {
          releaseKey: skill.releaseKey,
          active: patch.active ?? skill.active,
          invocationPolicy: patch.invocationPolicy ?? skill.invocationPolicy,
        },
      });
    } finally {
      setPendingReleaseKey(null);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("skills")} icon={<Layers3Icon className="size-4" />}>
        <p className="px-3 pb-2 text-sm leading-relaxed text-muted-foreground sm:px-4">
          Make reusable guidance available to supported agents. Skills add instructions, never tools
          or permissions.
        </p>
        <Link
          className="group block cursor-pointer rounded-xl outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          to="/settings/skills/external"
        >
          <SettingsRow
            description={summarizeExternalSkills(externalSkillGroups)}
            title={
              <span className="inline-flex items-center gap-2.5 transition-colors group-hover:text-foreground/75">
                External skills
                <ArrowRightIcon
                  aria-hidden
                  className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1"
                />
              </span>
            }
          />
        </Link>
        <div className="flex items-center gap-3 px-3 pt-4 pb-1 sm:px-4">
          <span className="relative flex size-9 shrink-0 items-center justify-center">
            <span
              aria-hidden
              className="absolute inset-1 bg-[#f3f1ed]/60 shadow-[0_0_3px_1px_rgba(243,241,237,0.2)] dark:bg-white/6 dark:shadow-[0_0_3px_1px_rgba(255,255,255,0.015)]"
            />
            <ScientSymbol className="relative size-7 drop-shadow-[0_0_0.3px_rgba(38,31,38,0.7)]" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-[-0.025em] text-foreground">
              Scient skills
            </h2>
          </div>
        </div>
        {inventory.error ? (
          <SettingsRow title="Skills unavailable" description={inventory.error} />
        ) : inventory.data === null ? (
          <SettingsRow
            title={environmentId === null ? "No execution environment" : "Loading skills"}
            description={
              environmentId === null
                ? "Connect an execution environment to manage skills."
                : "Reading the skills available in this Scient build."
            }
          />
        ) : inventory.data.skills.length === 0 ? (
          <SettingsRow
            title="No built-in skills"
            description="This Scient build does not publish any managed skills."
          />
        ) : (
          groupSkillsByCategory(inventory.data.skills).map((group) => (
            <SkillCategoryDisclosure
              key={group.category}
              title={group.category}
              description={group.description}
              skillCount={group.skills.length}
            >
              {group.skills.map((skill) => {
                const pending = pendingReleaseKey === skill.releaseKey;
                return (
                  <SettingsRow
                    key={skill.releaseKey}
                    className="sm:[&>div]:grid-cols-[minmax(0,1fr)_5rem] [&>div>div>p]:max-w-none"
                    title={
                      <span className="inline-flex items-center gap-2">
                        <span>
                          {skill.name
                            .split("-")
                            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                            .join(" ")}
                        </span>
                        <Select
                          value={skill.invocationPolicy}
                          disabled={!skill.active || pendingReleaseKey !== null}
                          onValueChange={(value) =>
                            void updateSkill(skill, {
                              invocationPolicy: value as ScientSkillInvocationPolicy,
                            })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            variant="ghost"
                            className="w-fit min-w-0 gap-1.5"
                            icon={
                              <ChevronDownIcon className="size-3 opacity-70" strokeWidth={2.25} />
                            }
                            aria-label={`${skill.name} use`}
                          >
                            <SelectValue>
                              {skill.active
                                ? invocationPolicyLabel(skill.invocationPolicy)
                                : "Deactivated"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            <SelectItem value="automatic">Agent access</SelectItem>
                            <SelectItem value="explicit">$name only</SelectItem>
                          </SelectPopup>
                        </Select>
                      </span>
                    }
                    description={skill.description}
                    status="Built into Scient · Personal"
                    control={
                      <Switch
                        checked={skill.active}
                        disabled={pending || pendingReleaseKey !== null}
                        aria-label={`Make ${skill.name} available`}
                        onCheckedChange={(checked) =>
                          void updateSkill(skill, { active: Boolean(checked) })
                        }
                      />
                    }
                  />
                );
              })}
            </SkillCategoryDisclosure>
          ))
        )}
        {inventory.data?.skills.some((skill) => skill.active) ? (
          <p className="px-3 pt-2 text-xs text-muted-foreground sm:px-4">
            Changes apply to the next message.
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
