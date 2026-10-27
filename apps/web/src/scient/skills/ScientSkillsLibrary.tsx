import type {
  EnvironmentId,
  ScientSkillCatalogItem,
  ScientSkillInvocationPolicy,
  ServerProvider,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { scientSkillsInventory, setScientSkillUserActivation } from "./scientSkillsState";
import { matchesQuery } from "../extensions/extensionsView";
import { ManagedSkillCard } from "./ManagedSkillCard";
import { SkillSettingsRow } from "./SkillSettingsRow";

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
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
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

/**
 * Scient's built-in skills by category, each with its own switch. `onlyActive`
 * lists just the ones turned on; categories without any are left out.
 */
export function ScientSkillsLibrary({
  environmentId,
  providers,
  onlyActive = false,
  query = "",
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onlyActive?: boolean;
  /** Words every listed skill matches; matching categories open. */
  readonly query?: string;
}) {
  const inventory = useEnvironmentQuery(scientSkillsInventory({ environmentId, input: {} }));
  const setActivation = useAtomCommand(setScientSkillUserActivation, {
    reportFailure: true,
  });
  const [selectedSkill, setSelectedSkill] = useState<ScientSkillCatalogItem | null>(null);
  const [pendingReleaseKey, setPendingReleaseKey] = useState<string | null>(null);

  const updateSkill = async (
    skill: ScientSkillCatalogItem,
    patch: { readonly active?: boolean; readonly invocationPolicy?: ScientSkillInvocationPolicy },
  ) => {
    if (pendingReleaseKey !== null) return;
    setPendingReleaseKey(skill.releaseKey);
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      await setActivation({
        environmentId,
        input: {
          releaseKey: skill.releaseKey,
          active: patch.active ?? skill.active,
          invocationPolicy: patch.invocationPolicy ?? skill.invocationPolicy,
        },
      });
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingReleaseKey(null);
    if (actionFailure) throw actionFailure.cause;
  };

  const userSkills = (inventory.data?.skills ?? []).filter(
    (skill) =>
      skill.scope === "user" &&
      (!onlyActive || skill.active) &&
      matchesQuery(query, [skill.name, skill.description, skill.category]),
  );

  return (
    <>
      {inventory.error ? (
        <p className="text-sm text-muted-foreground">Skills unavailable: {inventory.error}</p>
      ) : inventory.data === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : userSkills.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query
            ? "No skills match."
            : onlyActive
              ? "None turned on. Turn them on from Discover."
              : "This Scient build does not publish any skills."}
        </p>
      ) : (
        <div className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>:not(:first-child)]:border-t [&>:not(:first-child)]:border-border/50">
          {groupSkillsByCategory(userSkills).map((group) => (
            <SkillCategoryDisclosure
              key={`${group.category}:${query === "" ? "browse" : "search"}`}
              defaultOpen={query !== ""}
              title={group.category}
              description={group.description}
              skillCount={group.skills.length}
            >
              {group.skills.map((skill) => {
                const pending = pendingReleaseKey === skill.releaseKey;
                return (
                  <SkillSettingsRow
                    key={skill.releaseKey}
                    skill={skill}
                    pending={pending}
                    disabled={pendingReleaseKey !== null}
                    status="Built into Scient · Personal"
                    onOpen={() => setSelectedSkill(skill)}
                    onUpdate={(patch) => void updateSkill(skill, patch)}
                  />
                );
              })}
            </SkillCategoryDisclosure>
          ))}
        </div>
      )}
      {userSkills.length > 0 ? (
        <p className="text-xs text-muted-foreground">Changes apply to the next message.</p>
      ) : null}
      {selectedSkill ? (
        <ManagedSkillCard
          key={`${environmentId}:${selectedSkill.releaseKey}`}
          environmentId={environmentId}
          skill={
            inventory.data?.skills.find(
              (skill) => skill.releaseKey === selectedSkill.releaseKey,
            ) ?? { ...selectedSkill, active: false }
          }
          provider={providers.find(
            (provider) =>
              provider.enabled &&
              provider.installed &&
              inventory.data?.supportedProviders.includes(provider.driver) &&
              !provider.skills.some((skill) => skill.name === selectedSkill.name),
          )}
          onClose={() => setSelectedSkill(null)}
        />
      ) : null}
    </>
  );
}
