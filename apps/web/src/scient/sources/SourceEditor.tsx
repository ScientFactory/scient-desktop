import type {
  EnvironmentId,
  ScientSourceMetadataUpdateRequest,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import { AlertCircle, ChevronLeft, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { Input, type InputProps } from "../../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea, type TextareaProps } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { useSourceEditor } from "./useSourceEditor";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
type Metadata = ScientSourceMetadataUpdateRequest["metadata"];
type Creator = Metadata["creators"][number];
type Identifier = Metadata["identifiers"][number];

const COMMON_SOURCE_TYPES: ReadonlyArray<readonly [Metadata["type"], string]> = [
  ["article", "Article"],
  ["preprint", "Preprint"],
  ["book", "Book"],
  ["thesis", "Thesis"],
  ["report", "Report"],
  ["other", "Other source"],
];

const SOURCE_TYPE_LABELS: Readonly<Record<Metadata["type"], string>> = {
  article: "Article",
  preprint: "Preprint",
  book: "Book",
  "book-chapter": "Book chapter",
  "conference-paper": "Conference paper",
  thesis: "Thesis",
  report: "Report",
  dataset: "Dataset",
  web: "Web source",
  other: "Other source",
};

const INLINE_INPUT_CLASS =
  "flex min-h-8 w-full cursor-text items-center rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal";

function InlineInput({ className, ...props }: InputProps) {
  return <Input nativeInput unstyled className={cn(INLINE_INPUT_CLASS, className)} {...props} />;
}

function InlineTextarea({ className, ...props }: TextareaProps) {
  return (
    <Textarea
      unstyled
      className={cn(
        "flex w-full cursor-text rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground [&_[data-slot=textarea]]:min-h-16 [&_[data-slot=textarea]]:p-0",
        className,
      )}
      {...props}
    />
  );
}

function metadataFromRecord(record: SourceRecord): Metadata {
  return {
    type: record.type,
    customType: record.customType ?? null,
    title: record.title,
    creators: record.creators,
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
  const initialMetadata = useMemo(() => metadataFromRecord(props.record), [props.record]);
  const sourceTypeOptions = useMemo(() => {
    if (COMMON_SOURCE_TYPES.some(([type]) => type === props.record.type)) {
      return COMMON_SOURCE_TYPES;
    }
    return [
      ...COMMON_SOURCE_TYPES.slice(0, -1),
      [props.record.type, SOURCE_TYPE_LABELS[props.record.type]] as const,
      COMMON_SOURCE_TYPES.at(-1)!,
    ];
  }, [props.record.type]);
  const [metadata, setMetadata] = useState<Metadata>(initialMetadata);
  const [yearText, setYearText] = useState(
    props.record.issuedYear === null ? "" : String(props.record.issuedYear),
  );
  const [tagsText, setTagsText] = useState(props.record.tags.join("\n"));
  const [creatorKeys, setCreatorKeys] = useState(() =>
    props.record.creators.map((_, index) => `creator-${props.record.sourceId}-${index}`),
  );
  const [identifierKeys, setIdentifierKeys] = useState(() =>
    props.record.identifiers.map((_, index) => `identifier-${props.record.sourceId}-${index}`),
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
  };
  const dirty = metadataKey(effectiveMetadata) !== metadataKey(initialMetadata);
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
  const invalid =
    invalidYear || invalidCreatorRoles || invalidIdentifiers || invalidCustomType || invalidUrl;
  const stale = editor.result?.outcome === "stale";

  const save = async (allowPossibleMetadataMatch = false) => {
    if (invalid || !dirty || editor.saving || stale) return;
    const result = await editor.save(
      props.record.revision,
      effectiveMetadata,
      allowPossibleMetadataMatch,
    );
    if (result?.outcome === "updated" || result?.outcome === "unchanged") {
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
            Cancel
          </PopoverTrigger>
          <PopoverPopup
            side="bottom"
            align="start"
            className="w-64"
            viewportClassName="space-y-2 p-2"
          >
            <div className="px-1 text-sm font-medium">Save your changes?</div>
            <div className="flex items-center justify-end gap-1">
              <Button size="xs" variant="ghost" onClick={() => setDiscardOpen(false)}>
                Keep editing
              </Button>
              <Button size="xs" variant="ghost" onClick={props.onCancel}>
                Discard
              </Button>
              <Button
                size="xs"
                disabled={invalid || editor.saving || stale}
                onClick={() => {
                  setDiscardOpen(false);
                  void save();
                }}
              >
                Save
              </Button>
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
          Save
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <form
          className="space-y-6 p-4"
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

          {editor.result?.outcome === "stale" ? (
            <div className="space-y-1 text-sm" role="alert">
              <div className="font-medium">This source changed while you were editing it.</div>
              <div className="text-muted-foreground">
                Cancel and reopen the editor to review the latest metadata. Your draft remains here.
              </div>
            </div>
          ) : null}

          {editor.result?.outcome === "duplicate" ? (
            <div className="space-y-2 text-sm" role="alert">
              <div className="font-medium">{editor.result.duplicate.reason}</div>
              {editor.result.duplicate.kind === "possible-metadata-match" ? (
                <Button type="button" size="xs" variant="outline" onClick={() => void save(true)}>
                  Save as a separate source
                </Button>
              ) : (
                <div className="text-muted-foreground">
                  Use a different persistent identifier before saving.
                </div>
              )}
            </div>
          ) : null}

          <FormSection title="Source">
            <Field>
              <FieldLabel>Type</FieldLabel>
              <Select
                value={metadata.type}
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
                  {sourceTypeOptions.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {metadata.type === "other" ? (
              <Field>
                <FieldLabel>Source type</FieldLabel>
                <InlineInput
                  autoFocus
                  aria-invalid={invalidCustomType || undefined}
                  placeholder="e.g. Protocol or guideline"
                  value={metadata.customType ?? ""}
                  onChange={(event) =>
                    setMetadata((current) => ({
                      ...current,
                      customType: event.target.value,
                    }))
                  }
                />
                {invalidCustomType ? (
                  <FieldDescription className="text-destructive">
                    Enter the source type.
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}
            <Field>
              <FieldLabel>Title</FieldLabel>
              <InlineInput
                value={metadata.title ?? ""}
                onChange={(event) =>
                  setMetadata((current) => ({ ...current, title: event.target.value }))
                }
              />
            </Field>
          </FormSection>

          <FormSection title="Creators">
            {metadata.creators.map((creator, index) => (
              <div
                key={creatorKeys[index]}
                className="space-y-2 border-b border-border pb-3 last:border-0 last:pb-0"
              >
                <div className="grid grid-cols-2 gap-2">
                  <Field>
                    <FieldLabel>Role</FieldLabel>
                    <InlineInput
                      size="sm"
                      value={creator.creatorType}
                      aria-invalid={!creator.creatorType.trim() || undefined}
                      onChange={(event) => {
                        const creators = [...metadata.creators];
                        creators[index] = { ...creator, creatorType: event.target.value };
                        setMetadata((current) => ({ ...current, creators }));
                      }}
                    />
                  </Field>
                  <div className="flex items-end justify-end">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove creator ${index + 1}`}
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
                {!creator.creatorType.trim() ? (
                  <FieldDescription className="text-destructive">
                    Enter a creator role, such as author or editor.
                  </FieldDescription>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <Field>
                    <FieldLabel>Given name</FieldLabel>
                    <InlineInput
                      size="sm"
                      value={creator.givenName ?? ""}
                      onChange={(event) => {
                        const creators = [...metadata.creators];
                        creators[index] = { ...creator, givenName: event.target.value };
                        setMetadata((current) => ({ ...current, creators }));
                      }}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Family name</FieldLabel>
                    <InlineInput
                      size="sm"
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
                  <FieldLabel>Organization or group name</FieldLabel>
                  <InlineInput
                    size="sm"
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
              <Plus /> Add creator
            </Button>
          </FormSection>

          <FormSection title="Abstract">
            <InlineTextarea
              value={metadata.abstract ?? ""}
              onChange={(event) =>
                setMetadata((current) => ({ ...current, abstract: event.target.value }))
              }
            />
          </FormSection>

          <FormSection title="Publication details">
            <Field>
              <FieldLabel>Journal or publication</FieldLabel>
              <InlineInput
                value={metadata.containerTitle ?? ""}
                onChange={(event) =>
                  setMetadata((current) => ({ ...current, containerTitle: event.target.value }))
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field>
                <FieldLabel>Date</FieldLabel>
                <InlineInput
                  value={metadata.issuedRaw ?? ""}
                  onChange={(event) =>
                    setMetadata((current) => ({ ...current, issuedRaw: event.target.value }))
                  }
                />
              </Field>
              <Field invalid={invalidYear}>
                <FieldLabel>Year</FieldLabel>
                <InlineInput
                  inputMode="numeric"
                  aria-invalid={invalidYear || undefined}
                  value={yearText}
                  onChange={(event) => setYearText(event.target.value)}
                />
                {invalidYear ? (
                  <FieldDescription className="text-destructive">
                    Enter a four-digit year.
                  </FieldDescription>
                ) : null}
              </Field>
            </div>
            <Field>
              <FieldLabel>Publisher</FieldLabel>
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
                  <FieldLabel className="capitalize">{field}</FieldLabel>
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
              <FieldLabel>Language</FieldLabel>
              <InlineInput
                value={metadata.language ?? ""}
                placeholder="e.g. en"
                onChange={(event) =>
                  setMetadata((current) => ({ ...current, language: event.target.value }))
                }
              />
            </Field>
          </FormSection>

          <FormSection title="Identifiers and links">
            {metadata.identifiers.map((identifier, index) => (
              <div key={identifierKeys[index]} className="space-y-1">
                <div className="flex items-end gap-2">
                  <Field className="w-24 shrink-0">
                    <FieldLabel>Type</FieldLabel>
                    <InlineInput
                      size="sm"
                      value={identifier.scheme}
                      aria-invalid={!identifier.scheme.trim() || undefined}
                      onChange={(event) => {
                        const identifiers = [...metadata.identifiers];
                        identifiers[index] = { ...identifier, scheme: event.target.value };
                        setMetadata((current) => ({ ...current, identifiers }));
                      }}
                    />
                  </Field>
                  <Field className="min-w-0 flex-1">
                    <FieldLabel>Value</FieldLabel>
                    <InlineInput
                      size="sm"
                      value={identifier.value}
                      aria-invalid={!identifier.value.trim() || undefined}
                      onChange={(event) => {
                        const identifiers = [...metadata.identifiers];
                        identifiers[index] = { ...identifier, value: event.target.value };
                        setMetadata((current) => ({ ...current, identifiers }));
                      }}
                    />
                  </Field>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove identifier ${index + 1}`}
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
                {!identifier.scheme.trim() || !identifier.value.trim() ? (
                  <FieldDescription className="text-destructive">
                    Enter both an identifier type and value.
                  </FieldDescription>
                ) : null}
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
              <Plus /> Add identifier
            </Button>
            <Field>
              <FieldLabel>Source URL</FieldLabel>
              <InlineInput
                type="url"
                aria-invalid={invalidUrl || undefined}
                value={metadata.url ?? ""}
                onChange={(event) =>
                  setMetadata((current) => ({ ...current, url: event.target.value }))
                }
              />
              {invalidUrl ? (
                <FieldDescription className="text-destructive">
                  Enter an HTTP or HTTPS source URL.
                </FieldDescription>
              ) : null}
            </Field>
          </FormSection>

          <FormSection title="Tags">
            <Field>
              <InlineTextarea
                value={tagsText}
                onChange={(event) => setTagsText(event.target.value)}
              />
              <FieldDescription>One tag per line.</FieldDescription>
            </Field>
          </FormSection>
        </form>
      </ScrollArea>
    </div>
  );
}
