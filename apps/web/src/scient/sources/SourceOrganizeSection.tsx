import {
  scientSourceTagCounts,
  scientSourceTagKey,
  scientSourceTopicKey,
  type ScientSourceCategorySummary,
  type ScientSourceStudyDesign,
} from "@scientfactory/scient-sources";
import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { Folder, Plus, Tag as TagIcon, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSearchInput,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { collectionIndent, orderedCollections } from "./collectionTree";
import { SCIENT_SOURCE_STUDY_DESIGN_LABELS } from "./sourceLabels";
import type { SourcesNameRequest } from "./SourcesNameDialog";
import type { SourcesOrganize } from "./useSourcesOrganize";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

export type SourceCategoryChoice = {
  readonly studyDesign?: ScientSourceStudyDesign;
  readonly topic?: string;
};

/** A tag or collection of the source; showing it lists its sources, × takes the source out. */
function Chip(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly showLabel: string;
  /** Absent where the Library cannot be changed: the chip only shows and navigates. */
  readonly remove?: {
    readonly label: string;
    readonly disabled: boolean;
    readonly run: () => void;
  };
  readonly onShow: () => void;
}) {
  return (
    <Badge variant="outline" className="max-w-full">
      <ScientTooltip content={props.label}>
        <button
          type="button"
          className="flex min-w-0 max-w-64 cursor-pointer items-center gap-1 outline-none focus-visible:underline"
          aria-label={props.showLabel}
          onClick={props.onShow}
        >
          {props.icon}
          <span className="min-w-0 truncate">{props.label}</span>
        </button>
      </ScientTooltip>
      {props.remove ? (
        <Button
          type="button"
          size="icon-micro"
          variant="ghost-muted"
          aria-label={props.remove.label}
          disabled={props.remove.disabled}
          onClick={props.remove.run}
        >
          <X />
        </Button>
      ) : null}
    </Badge>
  );
}

function AddTagMenu(props: {
  readonly organize: SourcesOrganize;
  readonly sourceId: string;
  readonly tags: ReadonlyArray<string>;
  readonly libraryTags: ReadonlyArray<string>;
}) {
  const [query, setQuery] = useState("");
  const own = new Set(props.tags.map(scientSourceTagKey));
  const typed = query.trim();
  const needle = typed.toLocaleLowerCase();
  const choices = props.libraryTags
    .filter((tag) => !own.has(scientSourceTagKey(tag)))
    .filter((tag) => !needle || tag.toLocaleLowerCase().includes(needle))
    .slice(0, 30);
  const exists = props.libraryTags.some((tag) => scientSourceTagKey(tag) === needle);
  const add = (tag: string) => {
    setQuery("");
    void props.organize.bulk({ sourceIds: [props.sourceId], addTags: [tag] }, "Tag was not added");
  };
  return (
    <Menu onOpenChange={(open) => (!open ? setQuery("") : undefined)}>
      <MenuTrigger
        render={
          <Button type="button" size="xs" variant="ghost-muted" disabled={props.organize.pending} />
        }
      >
        <Plus />
        Tag
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-52">
        <MenuSearchInput
          autoFocus
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && typed && !event.nativeEvent.isComposing) add(typed);
          }}
          placeholder="Find or create a tag"
          aria-label="Find or create a tag"
        />
        {choices.map((tag) => (
          <MenuItem key={scientSourceTagKey(tag)} onClick={() => add(tag)}>
            <span className="min-w-0 truncate">{tag}</span>
          </MenuItem>
        ))}
        {typed && !exists && !own.has(needle) ? (
          <MenuItem onClick={() => add(typed)}>
            <span className="min-w-0 truncate">Create “{typed}”</span>
          </MenuItem>
        ) : null}
        {!typed && choices.length === 0 ? <MenuItem disabled>Type a new tag</MenuItem> : null}
      </MenuPopup>
    </Menu>
  );
}

/** A registry category; showing it lists the sources that share it. */
function CategoryChip(props: { readonly label: string; readonly onShow: () => void }) {
  return (
    <Badge variant="outline" className="max-w-full">
      <ScientTooltip content={props.label}>
        <button
          type="button"
          className="min-w-0 cursor-pointer truncate outline-none focus-visible:underline"
          aria-label={`Show sources in ${props.label}`}
          onClick={props.onShow}
        >
          {props.label}
        </button>
      </ScientTooltip>
    </Badge>
  );
}

/**
 * One source's tags and collections, laid inline beside its reading state: + Tag, + Collection,
 * then a chip for each. A Library this connection cannot change shows the chips alone.
 */
export function SourceFiling(props: {
  readonly organize: SourcesOrganize;
  readonly sourceId: string;
  readonly tags: ReadonlyArray<string>;
  readonly records: ReadonlyArray<SourceSummary>;
  readonly onShowTag: (tag: string) => void;
  readonly onShowCollection: (collectionId: string) => void;
  readonly onRequestName: (request: SourcesNameRequest) => void;
}) {
  const { organize, sourceId } = props;
  const editable = organize.canChange;
  const tags = [...new Map(props.tags.map((tag) => [scientSourceTagKey(tag), tag])).values()];
  const collections = orderedCollections(organize.organization.collections);
  const memberOf = collections.filter(({ collection }) => collection.sourceIds.includes(sourceId));
  const setMembership = (collectionId: string, member: boolean) =>
    void organize.organize(
      member
        ? { action: "add-to-collection", collectionId, sourceIds: [sourceId] }
        : { action: "remove-from-collection", collectionId, sourceIds: [sourceId] },
      "Collection was not changed",
    );

  return (
    <>
      {editable ? (
        <>
          <AddTagMenu
            organize={organize}
            sourceId={sourceId}
            tags={tags}
            libraryTags={scientSourceTagCounts(props.records).map((entry) => entry.tag)}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button type="button" size="xs" variant="ghost-muted" disabled={organize.pending} />
              }
            >
              <Plus />
              Collection
            </MenuTrigger>
            <MenuPopup align="start" side="bottom" className="min-w-48">
              {collections.map(({ collection, aboveIds }) => (
                <MenuCheckboxItem
                  key={collection.collectionId}
                  checked={collection.sourceIds.includes(sourceId)}
                  onCheckedChange={(checked) => setMembership(collection.collectionId, checked)}
                >
                  <span
                    className="block min-w-0 truncate"
                    style={collectionIndent(aboveIds.length)}
                  >
                    {collection.name}
                  </span>
                </MenuCheckboxItem>
              ))}
              {collections.length > 0 ? <MenuSeparator /> : null}
              <MenuItem
                onClick={() =>
                  props.onRequestName({
                    title: "New collection",
                    label: "Collection name",
                    initialName: "",
                    action: "Create",
                    onSubmit: async (name) =>
                      (await organize.createCollection(name, [sourceId])) !== null,
                  })
                }
              >
                New collection…
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      ) : null}
      {tags.map((tag) => (
        <Chip
          key={scientSourceTagKey(tag)}
          icon={<TagIcon className="text-muted-foreground" aria-hidden />}
          label={tag}
          showLabel={`Show sources tagged ${tag}`}
          {...(editable
            ? {
                remove: {
                  label: `Remove tag ${tag}`,
                  disabled: organize.pending,
                  run: () =>
                    void organize.bulk(
                      { sourceIds: [sourceId], removeTags: [tag] },
                      "Tag was not removed",
                    ),
                },
              }
            : {})}
          onShow={() => props.onShowTag(tag)}
        />
      ))}
      {memberOf.map(({ collection, label }) => (
        <Chip
          key={collection.collectionId}
          icon={<Folder className="text-muted-foreground" aria-hidden />}
          label={label}
          showLabel={`Show collection ${label}`}
          {...(editable
            ? {
                remove: {
                  label: `Remove from ${label}`,
                  disabled: organize.pending,
                  run: () => setMembership(collection.collectionId, false),
                },
              }
            : {})}
          onShow={() => props.onShowCollection(collection.collectionId)}
        />
      ))}
    </>
  );
}

/** A source's registry categories among its facts; nothing when it has none. */
export function SourceCategories(props: {
  readonly categories: ScientSourceCategorySummary | undefined;
  readonly onShowCategory: (category: SourceCategoryChoice) => void;
}) {
  const studyDesign = props.categories?.studyDesign;
  const topics = props.categories?.topics ?? [];
  if (!studyDesign && topics.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Categories
      </h3>
      <div className="flex flex-wrap items-center gap-1.5">
        {studyDesign ? (
          <CategoryChip
            label={SCIENT_SOURCE_STUDY_DESIGN_LABELS[studyDesign]}
            onShow={() => props.onShowCategory({ studyDesign })}
          />
        ) : null}
        {topics.map((topic) => (
          <CategoryChip
            key={scientSourceTopicKey(topic.name)}
            label={topic.name}
            onShow={() => props.onShowCategory({ topic: topic.name })}
          />
        ))}
      </div>
    </section>
  );
}
