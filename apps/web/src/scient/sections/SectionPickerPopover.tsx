import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import {
  Autocomplete,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "../../components/ui/autocomplete";
import { Popover, PopoverPopup, PopoverTitle } from "../../components/ui/popover";
import { readThreadShell, useQuietThreadShells } from "../../state/entities";
import { useThreadSectionCatalogs } from "./catalog";
import { loadedThreadEnvironmentsKeyAtom } from "./loadedEnvironments";
import {
  GENERAL_SECTION_GROUP_ID,
  type SectionRef,
  sectionGroupId,
  sectionGroupIdsInProjectScope,
} from "./logic";
import type { SectionCreateAnchor } from "./NewSectionPopover";
import { type SectionPickerEntry, sectionPickerList } from "./picker";
import { readSidebarSectionScope } from "./sidebarScope";

const CREATE_ITEM = "__create__";

/** Move to section: search the sections, pick one, or create one by its typed name. */
export function SectionPickerPopover(props: {
  readonly open: boolean;
  readonly requestKey: number;
  readonly threadRefs: readonly ScopedThreadRef[];
  readonly anchor: SectionCreateAnchor | null;
  readonly onOpenChange: (open: boolean) => void;
  /** Null files the threads in General. */
  readonly onMove: (section: SectionRef | null) => void;
  readonly onCreate: (name: string) => Promise<boolean>;
}) {
  const origin = props.anchor;
  const anchor =
    origin === null || "getBoundingClientRect" in origin
      ? origin
      : { getBoundingClientRect: () => DOMRect.fromRect({ x: origin.x, y: origin.y }) };
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange} modal={false}>
      <PopoverPopup
        anchor={anchor ?? undefined}
        side="right"
        align="start"
        width="sm"
        padding="tight"
        initialFocus
        finalFocus={() => (origin !== null && "getBoundingClientRect" in origin ? origin : true)}
      >
        <SectionPicker key={props.requestKey} {...props} />
      </PopoverPopup>
    </Popover>
  );
}

function SectionPicker(props: Parameters<typeof SectionPickerPopover>[0]) {
  const { catalogFor } = useThreadSectionCatalogs();
  const threads = useQuietThreadShells();
  const loadedKey = useAtomValue(loadedThreadEnvironmentsKeyAtom);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);

  // Sections belong to one environment; a selection across several can only go to General or a new one.
  const environmentIds = new Set(props.threadRefs.map((ref) => ref.environmentId));
  const [onlyEnvironment] = environmentIds;
  const catalog =
    environmentIds.size === 1 && onlyEnvironment !== undefined ? catalogFor(onlyEnvironment) : null;
  const sections = catalog?.sections ?? [];

  const scope = readSidebarSectionScope();
  const listedGroupIds =
    catalog === null
      ? null
      : sectionGroupIdsInProjectScope({
          layouts: [catalog],
          scopeProjectKeys:
            scope === null
              ? null
              : new Set(scope.map((ref) => `${ref.environmentId}:${ref.projectId}`)),
          loadedEnvironmentIds: new Set(loadedKey.length > 0 ? loadedKey.split("\n") : []),
          threads,
        });
  const groupIdOf = (sectionId: string) =>
    sectionGroupId({ environmentId: catalog!.environmentId, sectionId });
  const inScope =
    listedGroupIds === null
      ? null
      : new Set(
          sections
            .filter((section) => listedGroupIds.has(groupIdOf(section.id)))
            .map((section) => section.id),
        );

  const known = new Set<string>(sections.map((section) => section.id));
  const lastActivity = new Map<string, number>();
  for (const thread of threads) {
    if (thread.environmentId !== catalog?.environmentId || thread.archivedAt !== null) continue;
    if (thread.sectionId == null || !known.has(thread.sectionId)) continue;
    const at = Date.parse(thread.updatedAt);
    if (at > (lastActivity.get(thread.sectionId) ?? Number.NEGATIVE_INFINITY)) {
      lastActivity.set(thread.sectionId, at);
    }
  }

  // An id its own catalog doesn't hold reads as General.
  const currentIds = new Set(
    props.threadRefs.map((ref) => {
      const sectionId = readThreadShell(ref)?.sectionId ?? null;
      const ownSections = catalogFor(ref.environmentId)?.sections ?? [];
      return sectionId !== null && ownSections.some((section) => section.id === sectionId)
        ? sectionId
        : GENERAL_SECTION_GROUP_ID;
    }),
  );
  const [current] = currentIds.size === 1 ? currentIds : [null];

  const list = sectionPickerList({ sections, inScope, lastActivity, query });

  const choose = (entry: SectionPickerEntry) => {
    props.onOpenChange(false);
    if (entry.id === current) return;
    props.onMove(
      entry.id === GENERAL_SECTION_GROUP_ID || catalog === null
        ? null
        : { environmentId: catalog.environmentId, sectionId: entry.id },
    );
  };
  const create = async (name: string) => {
    if (creating) return;
    setCreating(true);
    setFailed(false);
    const created = await props.onCreate(name).catch(() => false);
    setCreating(false);
    if (created) props.onOpenChange(false);
    else setFailed(true);
  };

  const renderEntries = (entries: readonly SectionPickerEntry[]) =>
    entries.map((entry) => (
      <AutocompleteItem
        key={entry.id}
        value={entry.id}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(entry)}
      >
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.id === current ? <CheckIcon aria-label="Current section" /> : null}
      </AutocompleteItem>
    ));
  const groups = [
    { label: "Recent", entries: list.recent },
    { label: list.recent.length > 0 ? "All sections" : null, entries: list.sections },
    { label: "Other projects", entries: list.otherProjects },
  ].filter((group) => group.entries.length > 0);

  return (
    <div className="flex min-h-0 flex-col gap-1">
      <div className="sr-only">
        <PopoverTitle size="compact">
          {props.threadRefs.length > 1
            ? `Move ${props.threadRefs.length} threads to a section`
            : "Move to section"}
        </PopoverTitle>
      </div>
      <Autocomplete
        inline
        open
        mode="none"
        autoHighlight="always"
        keepHighlight
        value={query}
        onValueChange={(value) => {
          setQuery(value);
          setFailed(false);
        }}
      >
        <AutocompleteInput
          aria-label="Search sections"
          placeholder="Search or create a section"
          size="sm"
          autoFocus
          maxLength={80}
          startAddon={<SearchIcon />}
        />
        <AutocompleteList className="max-h-72">
          {groups.map((group) => (
            <AutocompleteGroup key={group.label ?? "sections"}>
              {group.label ? <AutocompleteGroupLabel>{group.label}</AutocompleteGroupLabel> : null}
              {renderEntries(group.entries)}
            </AutocompleteGroup>
          ))}
          {list.createName !== null ? (
            <AutocompleteItem
              value={CREATE_ITEM}
              disabled={creating}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void create(list.createName!)}
            >
              <PlusIcon />
              <span className="min-w-0 flex-1 truncate">Create “{list.createName}”</span>
            </AutocompleteItem>
          ) : null}
        </AutocompleteList>
      </Autocomplete>
      {failed ? (
        <p className="px-2 text-xs text-destructive">The section could not be saved. Try again.</p>
      ) : null}
    </div>
  );
}
