import {
  scientSourceTagCounts,
  scientSourceTagKey,
  scientSourceTopicKey,
  type ScientSourceStudyDesign,
} from "@scientfactory/scient-sources";
import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { Plus, X } from "lucide-react";
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
import { orderedCollections } from "./collectionTree";
import { SCIENT_SOURCE_STUDY_DESIGN_LABELS } from "./sourceLabels";
import type { SourcesNameRequest } from "./SourcesNameDialog";
import type { SourcesOrganize } from "./useSourcesOrganize";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.title}
      </h3>
      <div className="flex flex-wrap items-center gap-1.5">{props.children}</div>
    </section>
  );
}

function Chip(props: {
  readonly label: string;
  readonly showLabel: string;
  readonly removeLabel: string;
  readonly disabled: boolean;
  readonly onShow: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <Badge variant="outline">
      <button
        type="button"
        className="max-w-48 cursor-pointer truncate outline-none focus-visible:underline"
        aria-label={props.showLabel}
        onClick={props.onShow}
      >
        {props.label}
      </button>
      <Button
        type="button"
        size="icon-micro"
        variant="ghost-muted"
        aria-label={props.removeLabel}
        disabled={props.disabled}
        onClick={props.onRemove}
      >
        <X />
      </Button>
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
          <Button
            type="button"
            size="compact"
            variant="ghost-muted"
            disabled={props.organize.pending || !props.organize.canChange}
          />
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
    <Badge variant="outline">
      <button
        type="button"
        className="max-w-48 cursor-pointer truncate outline-none focus-visible:underline"
        aria-label={`Show sources in ${props.label}`}
        onClick={props.onShow}
      >
        {props.label}
      </button>
    </Badge>
  );
}

/** Tags and collections of one source, editable in place, and its registry categories. */
export function SourceOrganizeSection(props: {
  readonly organize: SourcesOrganize;
  readonly sourceId: string;
  readonly tags: ReadonlyArray<string>;
  readonly records: ReadonlyArray<SourceSummary>;
  readonly onShowTag: (tag: string) => void;
  readonly onShowCollection: (collectionId: string) => void;
  readonly onShowCategory?: (category: {
    readonly studyDesign?: ScientSourceStudyDesign;
    readonly topic?: string;
  }) => void;
  readonly onRequestName: (request: SourcesNameRequest) => void;
}) {
  const { organize, sourceId } = props;
  const tags = [...new Map(props.tags.map((tag) => [scientSourceTagKey(tag), tag])).values()];
  const libraryTags = scientSourceTagCounts(props.records).map((entry) => entry.tag);
  const collections = orderedCollections(organize.organization.collections);
  const memberOf = collections.filter(({ collection }) => collection.sourceIds.includes(sourceId));
  const categories = props.records.find((record) => record.sourceId === sourceId)?.categories;
  const onShowCategory = props.onShowCategory;
  const studyDesign = categories?.studyDesign;
  const setMembership = (collectionId: string, member: boolean) =>
    void organize.organize(
      member
        ? { action: "add-to-collection", collectionId, sourceIds: [sourceId] }
        : { action: "remove-from-collection", collectionId, sourceIds: [sourceId] },
      "Collection was not changed",
    );

  return (
    <>
      <Section title="Tags">
        {tags.map((tag) => (
          <Chip
            key={scientSourceTagKey(tag)}
            label={tag}
            showLabel={`Show sources tagged ${tag}`}
            removeLabel={`Remove tag ${tag}`}
            disabled={organize.pending || !organize.canChange}
            onShow={() => props.onShowTag(tag)}
            onRemove={() =>
              void organize.bulk(
                { sourceIds: [sourceId], removeTags: [tag] },
                "Tag was not removed",
              )
            }
          />
        ))}
        <AddTagMenu organize={organize} sourceId={sourceId} tags={tags} libraryTags={libraryTags} />
      </Section>
      <Section title="Collections">
        {memberOf.map(({ collection, label }) => (
          <Chip
            key={collection.collectionId}
            label={label}
            showLabel={`Show collection ${label}`}
            removeLabel={`Remove from ${label}`}
            disabled={organize.pending || !organize.canChange}
            onShow={() => props.onShowCollection(collection.collectionId)}
            onRemove={() => setMembership(collection.collectionId, false)}
          />
        ))}
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="compact"
                variant="ghost-muted"
                disabled={organize.pending || !organize.canChange}
              />
            }
          >
            <Plus />
            Collection
          </MenuTrigger>
          <MenuPopup align="start" side="bottom" className="min-w-48">
            {collections.map(({ collection, label }) => (
              <MenuCheckboxItem
                key={collection.collectionId}
                checked={collection.sourceIds.includes(sourceId)}
                onCheckedChange={(checked) => setMembership(collection.collectionId, checked)}
              >
                <span className="min-w-0 truncate">{label}</span>
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
      </Section>
      {categories && onShowCategory ? (
        <Section title="Categories">
          {studyDesign ? (
            <CategoryChip
              label={SCIENT_SOURCE_STUDY_DESIGN_LABELS[studyDesign]}
              onShow={() => onShowCategory({ studyDesign })}
            />
          ) : null}
          {(categories.topics ?? []).map((topic) => (
            <CategoryChip
              key={scientSourceTopicKey(topic.name)}
              label={topic.name}
              onShow={() => onShowCategory({ topic: topic.name })}
            />
          ))}
        </Section>
      ) : null}
    </>
  );
}
