import { decodeMsg, msg, T, useGT, useLocale, useMessages, Var } from "gt-react";
import type {
  EnvironmentId,
  ScientSourceDetailResult,
  ScientSourceMetadataUpdateRequest,
} from "@t3tools/contracts";
import { AlertCircle, ChevronLeft, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";

import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../../components/ui/autocomplete";
import { Button } from "../../components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "../../components/ui/field";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { ScrollArea } from "../../components/ui/scroll-area";
import { toastManager } from "../../components/ui/toast";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { cn } from "../../lib/utils";
import { changedDraftFields, rebaseSourceDraft } from "./sourceEditorDraft";
import { useSourceEditor } from "./useSourceEditor";
import { SCIENT_SOURCE_TYPE_LABELS } from "./sourceLabels";
import {
  CITATION_KEY_SYNTAX_MESSAGE,
  SCIENT_SOURCE_MORE_FIELDS,
  isValidCitationKey,
} from "@scientfactory/scient-sources";

type SourceRecord = ScientSourceDetailResult;
type Metadata = ScientSourceMetadataUpdateRequest["metadata"];
type Creator = Metadata["creators"][number];
type Identifier = Metadata["identifiers"][number];

const COMMON_SOURCE_TYPES: ReadonlyArray<Metadata["type"]> = [
  "article",
  "preprint",
  "book",
  "thesis",
  "report",
  "software",
  "other",
];

/** Creator roles as the source records them (Zotero's spelling), under the words people use. */
const CREATOR_ROLES: ReadonlyArray<readonly [token: string, label: string]> = [
  ["author", msg("Author", { $context: "bibliographic creator role" })],
  ["editor", msg("Editor", { $context: "bibliographic creator role" })],
  ["translator", msg("Translator", { $context: "bibliographic creator role" })],
  ["contributor", msg("Contributor", { $context: "bibliographic creator role" })],
  ["bookAuthor", msg("Book author", { $context: "bibliographic creator role" })],
  ["seriesEditor", msg("Series editor", { $context: "bibliographic creator role" })],
  ["reviewedAuthor", msg("Reviewed author", { $context: "bibliographic creator role" })],
  ["presenter", msg("Presenter", { $context: "bibliographic creator role" })],
  ["programmer", msg("Programmer", { $context: "bibliographic creator role" })],
  ["inventor", msg("Inventor", { $context: "bibliographic creator role" })],
  ["interviewer", msg("Interviewer", { $context: "bibliographic creator role" })],
  ["interviewee", msg("Interviewee", { $context: "bibliographic creator role" })],
  ["director", msg("Director", { $context: "bibliographic creator role" })],
  ["producer", msg("Producer", { $context: "bibliographic creator role" })],
  ["performer", msg("Performer", { $context: "bibliographic creator role" })],
  ["artist", msg("Artist", { $context: "bibliographic creator role" })],
  ["cartographer", msg("Cartographer", { $context: "bibliographic creator role" })],
  ["sponsor", msg("Sponsor", { $context: "bibliographic creator role" })],
];

/** A known role under its name; any other role as it was written. */
function creatorRoleLabel(token: string, translate: (label: string) => string): string {
  const lower = token.toLowerCase();
  const role = CREATOR_ROLES.find(([known]) => known.toLowerCase() === lower);
  return role ? translate(role[1]) : token;
}

/** What was typed or picked, as the role to store: a known name or token becomes its token. */
function creatorRoleFromText(text: string, translate: (label: string) => string): string {
  const lower = text.trim().toLowerCase();
  const known =
    CREATOR_ROLES.find(([token]) => token.toLowerCase() === lower) ??
    CREATOR_ROLES.find(([, label]) => translate(label).toLowerCase() === lower) ??
    CREATOR_ROLES.find(([, label]) => decodeMsg(label).toLowerCase() === lower);
  return known ? known[0] : text;
}

const INLINE_INPUT_CLASS =
  "block min-h-8 w-full cursor-text rounded-md px-2 py-1.5 text-sm leading-normal outline-none transition-colors placeholder:text-placeholder hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground";

function InlineInput({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(INLINE_INPUT_CLASS, className)} {...props} />;
}

function InlineTextarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "field-sizing-content min-h-16 max-h-64 w-full cursor-text resize-y rounded-md px-2 py-1.5 text-sm leading-normal outline-none transition-colors placeholder:text-placeholder hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

function metadataFromRecord(record: SourceRecord): Metadata {
  return {
    ...(record.citationKey ? { citationKey: record.citationKey } : {}),
    type: record.type,
    customType: record.customType ?? null,
    title: record.title,
    creators: record.creators,
    incompleteCreatorRoles: record.incompleteCreatorRoles ?? [],
    issuedRaw: record.issuedRaw,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    abstract: record.abstract,
    containerTitle: record.containerTitle,
    publisher: record.publisher,
    volume: record.volume,
    issue: record.issue,
    pages: record.pages,
    language: record.language,
    url: record.url,
    tags: record.tags,
    more: record.more ?? {},
  };
}

function emptyCreator(): Creator {
  return { creatorType: "author", givenName: null, familyName: null, literalName: null };
}

function emptyIdentifier(): Identifier {
  return { scheme: "doi", value: "" };
}

function metadataKey(metadata: Metadata): string {
  return JSON.stringify(metadata);
}

function tagsFromText(value: string): ReadonlyArray<string> {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const line of value.split("\n")) {
    const tag = line.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function FormSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium text-foreground">{props.title}</legend>
      {props.children}
    </fieldset>
  );
}

export function SourceEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly record: SourceRecord;
  readonly onCancel: () => void;
  readonly onRefreshed: (record: SourceRecord) => void;
  readonly onSaved: (record: SourceRecord) => void;
}) {
  const m = useMessages();
  const locale = useLocale();
  const creatorRoles = CREATOR_ROLES.map(([token, label]) => ({ token, label: m(label) }));
  const gt = useGT();
  const creatorRoleInSentence = (token: string) => {
    const label = creatorRoleLabel(token, m);
    return locale === "en" ? label.toLowerCase() : label;
  };
  const originalMetadata = metadataFromRecord(props.record);
  // An uncommon type the source already has is offered too, before Other source.
  const sourceTypeItems = (
    COMMON_SOURCE_TYPES.includes(props.record.type)
      ? COMMON_SOURCE_TYPES
      : [...COMMON_SOURCE_TYPES.slice(0, -1), props.record.type, "other" as const]
  ).map((type) => ({ value: type, label: m(SCIENT_SOURCE_TYPE_LABELS[type]) }));
  const [metadata, setMetadata] = useState<Metadata>(originalMetadata);
  const [yearText, setYearText] = useState(
    originalMetadata.issuedYear === null ? "" : String(originalMetadata.issuedYear),
  );
  const more = metadata.more ?? {};
  // A row left blank is a detail removed: it is not sent, so it cannot fail the save.
  const filledMore = Object.fromEntries(
    Object.entries(more).flatMap(([name, value]) => (value.trim() ? [[name, value.trim()]] : [])),
  );
  /** Sets one of the further details; null takes its row away. */
  const setMore = (name: string, value: string | null) =>
    setMetadata((current) => {
      const rest = Object.fromEntries(
        Object.entries(current.more ?? {}).filter(([key]) => key !== name),
      );
      return { ...current, more: value === null ? rest : { ...rest, [name]: value } };
    });
  const [tagsText, setTagsText] = useState(originalMetadata.tags.join("\n"));
  const [creatorKeys, setCreatorKeys] = useState(() =>
    originalMetadata.creators.map((_, index) => `creator-${props.record.sourceId}-${index}`),
  );
  const [identifierKeys, setIdentifierKeys] = useState(() =>
    originalMetadata.identifiers.map((_, index) => `identifier-${props.record.sourceId}-${index}`),
  );
  const nextRowId = useRef(0);
  const [discardOpen, setDiscardOpen] = useState(false);
  const editor = useSourceEditor({
    environmentId: props.environmentId,
    root: props.root,
    sourceId: props.record.sourceId,
  });
  const effectiveMetadata: Metadata = {
    ...metadata,
    issuedYear: yearText.trim() ? Number.parseInt(yearText, 10) : null,
    tags: tagsFromText(tagsText),
    more: filledMore,
  };
  const dirty = metadataKey(effectiveMetadata) !== metadataKey(originalMetadata);
  const invalidYear =
    yearText.trim().length > 0 &&
    (!/^\d{4}$/u.test(yearText.trim()) || Number.parseInt(yearText, 10) < 1000);
  const invalidIdentifiers = metadata.identifiers.some(
    (identifier) => !identifier.scheme.trim() || !identifier.value.trim(),
  );
  const invalidCreatorRoles = metadata.creators.some((creator) => !creator.creatorType.trim());
  const invalidCustomType = metadata.type === "other" && !metadata.customType?.trim();
  const invalidUrl = (() => {
    if (!metadata.url?.trim()) return false;
    try {
      const parsed = new URL(metadata.url);
      return parsed.protocol !== "http:" && parsed.protocol !== "https:";
    } catch {
      return true;
    }
  })();
  const invalidCitationKey =
    metadata.citationKey !== undefined && !isValidCitationKey(metadata.citationKey.trim());
  const invalid =
    invalidYear ||
    invalidCreatorRoles ||
    invalidIdentifiers ||
    invalidCustomType ||
    invalidUrl ||
    invalidCitationKey;
  // A newer record (a stale save's answer, or a change made elsewhere) takes the draft along: the
  // fields the person changed stay theirs, the rest show the newer record, and Save works again.
  // A project key renamed elsewhere changes no revision.
  const [base, setBase] = useState({ revision: props.record.revision, metadata: originalMetadata });
  const [rebased, setRebased] = useState(false);
  if (
    base.revision !== props.record.revision ||
    base.metadata.citationKey !== originalMetadata.citationKey
  ) {
    const changed = changedDraftFields(base.metadata, effectiveMetadata);
    const next = rebaseSourceDraft(base.metadata, effectiveMetadata, originalMetadata);
    setBase({ revision: props.record.revision, metadata: originalMetadata });
    setMetadata(changed.has("more") ? { ...next, more } : next);
    if (!changed.has("issuedYear")) {
      setYearText(next.issuedYear === null ? "" : String(next.issuedYear));
    }
    if (!changed.has("tags")) setTagsText(next.tags.join("\n"));
    if (!changed.has("creators")) {
      setCreatorKeys(next.creators.map((_, index) => `creator-${props.record.revision}-${index}`));
    }
    if (!changed.has("identifiers")) {
      setIdentifierKeys(
        next.identifiers.map((_, index) => `identifier-${props.record.revision}-${index}`),
      );
    }
    setRebased(changed.size > 0);
    editor.clearResult();
  }
  const stale = editor.result?.outcome === "stale";

  const save = async (allowPossibleMetadataMatch = false) => {
    if (invalid || !dirty || editor.saving || stale) return;
    // A key is sent only as a rename the person made: the server renames the pin to any key sent.
    const { citationKey, ...withoutKey } = effectiveMetadata;
    const result = await editor.save(
      props.record.revision,
      citationKey === base.metadata.citationKey ? withoutKey : effectiveMetadata,
      allowPossibleMetadataMatch,
    );
    if (result?.outcome === "updated" || result?.outcome === "unchanged") {
      const skipped = result.citationKeyRenameSkipped ?? [];
      if (skipped.length > 0) {
        toastManager.add({
          type: "warning",
          title: gt("Some documents still use the old key"),
          description: skipped
            .slice(0, 3)
            .map((entry) => `${entry.path}: ${entry.reason}`)
            .concat(
              skipped.length > 3 ? [gt("and {count} more", { count: skipped.length - 3 })] : [],
            )
            .join("\n"),
        });
      }
      props.onSaved(result.record);
    } else if (result?.outcome === "stale") {
      props.onRefreshed(result.record);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-3">
        <Popover
          open={discardOpen}
          onOpenChange={(open) => {
            if (open && !dirty) {
              props.onCancel();
              return;
            }
            setDiscardOpen(open);
          }}
        >
          <PopoverTrigger render={<Button variant="ghost" size="xs" disabled={editor.saving} />}>
            <ChevronLeft />
            <T>Cancel</T>
          </PopoverTrigger>
          <PopoverPopup side="bottom" align="start" className="w-64" padding="none">
            <div className="space-y-2 p-2">
              <div className="px-1 text-sm font-medium">
                <T>Save your changes?</T>
              </div>
              <div className="flex items-center justify-end gap-1">
                <Button size="xs" variant="ghost" onClick={() => setDiscardOpen(false)}>
                  <T>Keep editing</T>
                </Button>
                <Button size="xs" variant="ghost" onClick={props.onCancel}>
                  <T>Discard</T>
                </Button>
                <Button
                  size="xs"
                  disabled={invalid || editor.saving || stale}
                  onClick={() => {
                    setDiscardOpen(false);
                    void save();
                  }}
                >
                  <T>Save</T>
                </Button>
              </div>
            </div>
          </PopoverPopup>
        </Popover>
        <div className="min-w-0 flex-1" />
        <Button
          size="xs"
          disabled={!dirty || invalid || editor.saving || stale}
          onClick={() => void save()}
        >
          {editor.saving ? <LoaderCircle className="animate-spin" /> : null}
          <T>Save</T>
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <form
          // A form reads best narrower than the Library column.
          className="mx-auto w-full max-w-[42rem] space-y-6 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {editor.error ? (
            <div className="flex items-start gap-2 text-sm text-destructive" role="alert">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{editor.error}</span>
            </div>
          ) : null}

          {stale || rebased ? (
            <div className="space-y-1 text-sm" role="status">
              <div className="font-medium">
                <T>This source changed while you were editing it.</T>
              </div>
              <div className="text-muted-foreground">
                {stale ? (
                  <T>Loading the latest version…</T>
                ) : (
                  <T>
                    Your changes are kept; the other fields show the latest version. Review them,
                    then save.
                  </T>
                )}
              </div>
            </div>
          ) : null}

          {editor.result?.outcome === "duplicate" ? (
            <div className="space-y-2 text-sm" role="alert">
              <div className="font-medium">{editor.result.duplicate.reason}</div>
              {editor.result.duplicate.kind === "possible-metadata-match" ? (
                <Button type="button" size="xs" variant="outline" onClick={() => void save(true)}>
                  <T>Save as a separate source</T>
                </Button>
              ) : (
                <div className="text-muted-foreground">
                  <T>Use a different persistent identifier before saving.</T>
                </div>
              )}
            </div>
          ) : null}

          <FormSection title={gt("Source", { $context: "noun, a Library source" })}>
            <Field>
              <FieldLabel>
                <T context="a source's type">Type</T>
              </FieldLabel>
              <Select
                value={metadata.type}
                items={sourceTypeItems}
                onValueChange={(type) =>
                  type &&
                  setMetadata((current) => ({
                    ...current,
                    type,
                    customType: type === "other" ? (current.customType ?? null) : null,
                  }))
                }
              >
                <SelectTrigger size="sm" variant="ghost" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {sourceTypeItems.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {metadata.type === "other" ? (
              <Field invalid={invalidCustomType}>
                <FieldLabel>
                  <T>Source type</T>
                </FieldLabel>
                <InlineInput
                  autoFocus
                  aria-invalid={invalidCustomType || undefined}
                  placeholder={gt("e.g. Protocol or guideline")}
                  value={metadata.customType ?? ""}
                  onChange={(event) =>
                    setMetadata((current) => ({
                      ...current,
                      customType: event.target.value,
                    }))
                  }
                />
                {invalidCustomType ? (
                  <FieldError match={true}>
                    <T>Enter the source type.</T>
                  </FieldError>
                ) : null}
              </Field>
            ) : null}
            <Field>
              <FieldLabel>
                <T context="a source field">Title</T>
              </FieldLabel>
              <InlineInput
                value={metadata.title ?? ""}
                onChange={(event) =>
                  setMetadata((current) => ({ ...current, title: event.target.value }))
                }
              />
            </Field>
          </FormSection>

          <FormSection title={gt("Creators", { $context: "a source field, authors and editors" })}>
            {(metadata.incompleteCreatorRoles ?? []).map((role) => (
              <div key={role} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 text-muted-foreground">
                  <T>
                    The <Var>{creatorRoleInSentence(role)}</Var> list ends with “and others”, so
                    references end it with “et al.”.
                  </T>
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    setMetadata((current) => ({
                      ...current,
                      incompleteCreatorRoles: (current.incompleteCreatorRoles ?? []).filter(
                        (marked) => marked !== role,
                      ),
                    }))
                  }
                >
                  <T>
                    The <Var>{creatorRoleInSentence(role)}</Var> list is complete
                  </T>
                </Button>
              </div>
            ))}
            {metadata.creators.map((creator, index) => (
              <div
                key={creatorKeys[index]}
                className="space-y-2 border-b border-border pb-3 last:border-0 last:pb-0"
              >
                <div className="grid grid-cols-2 gap-2">
                  <Field invalid={!creator.creatorType.trim()}>
                    <FieldLabel>
                      <T context="a creator's role">Role</T>
                    </FieldLabel>
                    <Autocomplete
                      items={creatorRoles.map(({ label }) => label)}
                      mode="none"
                      openOnInputClick
                      value={creatorRoleLabel(creator.creatorType, m)}
                      onValueChange={(text) => {
                        const creators = [...metadata.creators];
                        creators[index] = { ...creator, creatorType: creatorRoleFromText(text, m) };
                        setMetadata((current) => ({ ...current, creators }));
                      }}
                    >
                      <AutocompleteInput
                        size="sm"
                        aria-label={gt("Role", { $context: "a creator's role" })}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={!creator.creatorType.trim() || undefined}
                      />
                      <AutocompletePopup>
                        <AutocompleteList className="max-h-60">
                          {creatorRoles.map(({ token, label }) => (
                            <AutocompleteItem key={token} value={label}>
                              {label}
                            </AutocompleteItem>
                          ))}
                        </AutocompleteList>
                      </AutocompletePopup>
                    </Autocomplete>
                    {!creator.creatorType.trim() ? (
                      <FieldError match={true}>
                        <T>Enter a creator role, such as author or editor.</T>
                      </FieldError>
                    ) : null}
                  </Field>
                  <div className="flex items-end justify-end">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={gt("Remove creator {value}", { value: index + 1 })}
                      onClick={() => {
                        setCreatorKeys((current) =>
                          current.filter((_, creatorIndex) => creatorIndex !== index),
                        );
                        setMetadata((current) => ({
                          ...current,
                          creators: current.creators.filter(
                            (_, creatorIndex) => creatorIndex !== index,
                          ),
                        }));
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field>
                    <FieldLabel>
                      <T>Given name</T>
                    </FieldLabel>
                    <InlineInput
                      value={creator.givenName ?? ""}
                      onChange={(event) => {
                        const creators = [...metadata.creators];
                        creators[index] = { ...creator, givenName: event.target.value };
                        setMetadata((current) => ({ ...current, creators }));
                      }}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>
                      <T>Family name</T>
                    </FieldLabel>
                    <InlineInput
                      value={creator.familyName ?? ""}
                      onChange={(event) => {
                        const creators = [...metadata.creators];
                        creators[index] = { ...creator, familyName: event.target.value };
                        setMetadata((current) => ({ ...current, creators }));
                      }}
                    />
                  </Field>
                </div>
                <Field>
                  <FieldLabel>
                    <T>Organization or group name</T>
                  </FieldLabel>
                  <InlineInput
                    value={creator.literalName ?? ""}
                    onChange={(event) => {
                      const creators = [...metadata.creators];
                      creators[index] = { ...creator, literalName: event.target.value };
                      setMetadata((current) => ({ ...current, creators }));
                    }}
                  />
                </Field>
              </div>
            ))}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                const rowId = `creator-new-${nextRowId.current++}`;
                setCreatorKeys((current) => [...current, rowId]);
                setMetadata((current) => ({
                  ...current,
                  creators: [...current.creators, emptyCreator()],
                }));
              }}
            >
              <Plus /> <T>Add creator</T>
            </Button>
          </FormSection>

          <FormSection title={gt("Abstract", { $context: "a source field" })}>
            <InlineTextarea
              value={metadata.abstract ?? ""}
              onChange={(event) =>
                setMetadata((current) => ({ ...current, abstract: event.target.value }))
              }
            />
          </FormSection>

          <FormSection title={gt("Publication details")}>
            <Field>
              <FieldLabel>
                <T>Journal or publication</T>
              </FieldLabel>
              <InlineInput
                value={metadata.containerTitle ?? ""}
                onChange={(event) =>
                  setMetadata((current) => ({ ...current, containerTitle: event.target.value }))
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field>
                <FieldLabel>
                  <T context="a source field">Date</T>
                </FieldLabel>
                <InlineInput
                  value={metadata.issuedRaw ?? ""}
                  onChange={(event) =>
                    setMetadata((current) => ({ ...current, issuedRaw: event.target.value }))
                  }
                />
              </Field>
              <Field invalid={invalidYear}>
                <FieldLabel>
                  <T context="a source field, publication year">Year</T>
                </FieldLabel>
                <InlineInput
                  inputMode="numeric"
                  aria-invalid={invalidYear || undefined}
                  value={yearText}
                  onChange={(event) => setYearText(event.target.value)}
                />
                {invalidYear ? (
                  <FieldError match={true}>
                    <T>Enter a four-digit year.</T>
                  </FieldError>
                ) : null}
              </Field>
            </div>
            <Field>
              <FieldLabel>
                <T context="a source field">Publisher</T>
              </FieldLabel>
              <InlineInput
                value={metadata.publisher ?? ""}
                onChange={(event) =>
                  setMetadata((current) => ({ ...current, publisher: event.target.value }))
                }
              />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              {(["volume", "issue", "pages"] as const).map((field) => (
                <Field key={field}>
                  <FieldLabel>
                    {field === "volume"
                      ? gt("Volume", { $context: "a source field, the journal volume" })
                      : field === "issue"
                        ? gt("Issue", { $context: "a source field, the journal issue" })
                        : gt("Pages", { $context: "a page range" })}
                  </FieldLabel>
                  <InlineInput
                    value={metadata[field] ?? ""}
                    onChange={(event) =>
                      setMetadata((current) => ({ ...current, [field]: event.target.value }))
                    }
                  />
                </Field>
              ))}
            </div>
            <Field>
              <FieldLabel>
                <T context="a source field">Language</T>
              </FieldLabel>
              <InlineInput
                value={metadata.language ?? ""}
                placeholder={gt("e.g. en")}
                onChange={(event) =>
                  setMetadata((current) => ({ ...current, language: event.target.value }))
                }
              />
            </Field>
          </FormSection>

          <FormSection title={gt("More details")}>
            {SCIENT_SOURCE_MORE_FIELDS.filter(({ name }) => name in more).map(({ name, label }) => (
              <Field key={name}>
                <FieldLabel>{label}</FieldLabel>
                <div className="flex items-start gap-1">
                  {name === "extra" ? (
                    <InlineTextarea
                      aria-label={label}
                      value={more[name] ?? ""}
                      onChange={(event) => setMore(name, event.target.value)}
                    />
                  ) : (
                    <InlineInput
                      aria-label={label}
                      value={more[name] ?? ""}
                      onChange={(event) => setMore(name, event.target.value)}
                    />
                  )}
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={gt("Remove {label}", { label })}
                    onClick={() => setMore(name, null)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </Field>
            ))}
            <Select
              value=""
              onValueChange={(name) => {
                if (typeof name === "string" && name) setMore(name, "");
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Add a detail")}>
                <SelectValue placeholder={gt("Add a detail…")} />
              </SelectTrigger>
              <SelectPopup>
                {SCIENT_SOURCE_MORE_FIELDS.filter(({ name }) => !(name in more)).map(
                  ({ name, label }) => (
                    <SelectItem key={name} value={name}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectPopup>
            </Select>
          </FormSection>

          <FormSection title={gt("Identifiers and links")}>
            {metadata.citationKey !== undefined ? (
              <Field invalid={invalidCitationKey}>
                <FieldLabel>
                  <T>Citation key</T>
                </FieldLabel>
                <InlineInput
                  value={metadata.citationKey}
                  spellCheck={false}
                  aria-invalid={invalidCitationKey || undefined}
                  onChange={(event) =>
                    setMetadata((current) => ({ ...current, citationKey: event.target.value }))
                  }
                />
                {invalidCitationKey ? (
                  <FieldError match={true}>{CITATION_KEY_SYNTAX_MESSAGE}</FieldError>
                ) : metadata.citationKey !== originalMetadata.citationKey ? (
                  <FieldDescription>
                    <T>Citations in this project's documents will use the new key.</T>
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}
            {metadata.identifiers.map((identifier, index) => (
              <div key={identifierKeys[index]} className="space-y-1">
                <div className="flex items-end gap-2">
                  <Field className="w-24 shrink-0" invalid={!identifier.scheme.trim()}>
                    <FieldLabel>
                      <T context="a source's type">Type</T>
                    </FieldLabel>
                    <InlineInput
                      value={identifier.scheme}
                      aria-invalid={!identifier.scheme.trim() || undefined}
                      onChange={(event) => {
                        const identifiers = [...metadata.identifiers];
                        identifiers[index] = { ...identifier, scheme: event.target.value };
                        setMetadata((current) => ({ ...current, identifiers }));
                      }}
                    />
                  </Field>
                  <Field
                    className="min-w-0 flex-1"
                    invalid={!identifier.scheme.trim() || !identifier.value.trim()}
                  >
                    <FieldLabel>
                      <T context="the value of a source field">Value</T>
                    </FieldLabel>
                    <InlineInput
                      value={identifier.value}
                      aria-invalid={!identifier.value.trim() || undefined}
                      onChange={(event) => {
                        const identifiers = [...metadata.identifiers];
                        identifiers[index] = { ...identifier, value: event.target.value };
                        setMetadata((current) => ({ ...current, identifiers }));
                      }}
                    />
                    {!identifier.scheme.trim() || !identifier.value.trim() ? (
                      <FieldError match={true}>
                        <T>Enter both an identifier type and value.</T>
                      </FieldError>
                    ) : null}
                  </Field>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={gt("Remove identifier {value}", { value: index + 1 })}
                    onClick={() => {
                      setIdentifierKeys((current) =>
                        current.filter((_, identifierIndex) => identifierIndex !== index),
                      );
                      setMetadata((current) => ({
                        ...current,
                        identifiers: current.identifiers.filter(
                          (_, identifierIndex) => identifierIndex !== index,
                        ),
                      }));
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                const rowId = `identifier-new-${nextRowId.current++}`;
                setIdentifierKeys((current) => [...current, rowId]);
                setMetadata((current) => ({
                  ...current,
                  identifiers: [...current.identifiers, emptyIdentifier()],
                }));
              }}
            >
              <Plus /> <T>Add identifier</T>
            </Button>
            <Field invalid={invalidUrl}>
              <FieldLabel>
                <T>Source URL</T>
              </FieldLabel>
              <InlineInput
                type="url"
                aria-invalid={invalidUrl || undefined}
                value={metadata.url ?? ""}
                onChange={(event) =>
                  setMetadata((current) => ({ ...current, url: event.target.value }))
                }
              />
              {invalidUrl ? (
                <FieldError match={true}>
                  <T>Enter an HTTP or HTTPS source URL.</T>
                </FieldError>
              ) : null}
            </Field>
          </FormSection>

          <FormSection title={gt("Tags", { $context: "noun" })}>
            <Field>
              <InlineTextarea
                value={tagsText}
                onChange={(event) => setTagsText(event.target.value)}
              />
              <FieldDescription>
                <T>One tag per line.</T>
              </FieldDescription>
            </Field>
          </FormSection>
        </form>
      </ScrollArea>
    </div>
  );
}
