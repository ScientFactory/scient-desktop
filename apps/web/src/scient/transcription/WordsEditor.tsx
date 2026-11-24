import type { TranscriptionWord } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

export function WordsScopes({
  yours,
  project,
  recording,
  initialScope = "yours",
}: {
  readonly yours: ReactNode;
  readonly project?: ReactNode;
  readonly recording?: ReactNode;
  readonly initialScope?: "yours" | "project" | "recording";
}) {
  const gt = useGT();
  const [selection, setSelection] = useState<string>(initialScope);
  const scopes = [
    { id: "yours", label: gt("Yours"), content: yours },
    { id: "project", label: gt("Project"), content: project },
    { id: "recording", label: gt("Recording"), content: recording },
  ].filter(({ content }) => content != null);
  const active = scopes.find(({ id }) => id === selection) ?? scopes[0];
  return (
    <>
      {scopes.length > 1 && (
        <ToggleGroup
          aria-label={gt("Words scope")}
          variant="segmented"
          value={active ? [active.id] : []}
          onValueChange={([next]) => {
            if (next) setSelection(next);
          }}
        >
          {scopes.map(({ id, label }) => (
            <Toggle key={id} value={id}>
              {label}
            </Toggle>
          ))}
        </ToggleGroup>
      )}
      {active && <Fragment key={active.id}>{active.content}</Fragment>}
    </>
  );
}

const normalizeTerm = (value: string) => value.replace(/\s+/g, " ").trim().normalize("NFC");
const keyOf = (term: string, language: string) =>
  JSON.stringify([language.toLowerCase(), normalizeTerm(term).toLowerCase()]);

export function WordsEditor(props: {
  /** Shown before the add field, on the same line. */
  readonly leading?: ReactNode;
  readonly label: string;
  readonly words: readonly TranscriptionWord[];
  readonly disabled?: boolean;
  readonly onSave: (word: TranscriptionWord) => void;
  readonly onRemove: (word: TranscriptionWord) => void;
}) {
  const gt = useGT();
  const { words, label, disabled = false, onSave, onRemove } = props;
  const [termDraft, setTermDraft] = useState("");
  const [aliasDraft, setAliasDraft] = useState<{ key: string; value: string } | null>(null);
  const term = normalizeTerm(termDraft);
  const canAddTerm =
    !disabled &&
    term.length > 0 &&
    [...term].length <= 80 &&
    !words.some((word) => keyOf(word.term, word.language) === keyOf(term, "und"));
  const addTerm = () => {
    if (!canAddTerm) return;
    onSave({ term, language: "und", source: "user" });
    setTermDraft("");
  };
  const addAlias = (word: TranscriptionWord) => {
    if (!aliasDraft || disabled) return;
    const alias = normalizeTerm(aliasDraft.value);
    if (
      !alias ||
      [...alias].length > 80 ||
      [word.term, word.preferred, ...(word.variants ?? [])].some(
        (value) => value && keyOf(value, word.language) === keyOf(alias, word.language),
      )
    )
      return;
    onSave({ ...word, variants: [...(word.variants ?? []), alias] });
    setAliasDraft(null);
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {props.leading}
        <Input
          size="sm"
          className="min-w-48 flex-1"
          value={termDraft}
          maxLength={160}
          disabled={disabled}
          placeholder={gt("Add a word or phrase")}
          aria-label={gt("Add a word or phrase to the {label}", { label })}
          onChange={(event) => setTermDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key !== "Enter") return;
            event.preventDefault();
            addTerm();
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={!canAddTerm} onClick={addTerm}>
          <PlusIcon />
          <T>Add</T>
        </Button>
      </div>
      {words.length > 0 ? (
        <ul
          aria-label={`${label} entries`}
          className="mt-2.5 flex flex-col gap-1.5 @min-[32rem]/settings-row:flex-row @min-[32rem]/settings-row:flex-wrap"
        >
          {words.map((word) => {
            const { term, preferred, language, variants = [] } = word;
            const key = keyOf(term, language);
            return (
              <li
                key={key}
                dir="auto"
                className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 py-0.5 pl-2 pr-0.5 text-xs"
              >
                <span className="font-medium">{preferred ?? term}</span>
                {language !== "und" && (
                  <span className="text-muted-foreground" lang={language}>
                    {language}
                  </span>
                )}
                {variants.length > 0 ? (
                  <span className="text-muted-foreground">← {variants.join(", ")}</span>
                ) : null}
                {aliasDraft?.key === key ? (
                  <Input
                    autoFocus
                    value={aliasDraft.value}
                    maxLength={160}
                    aria-label={gt("Alias for {term}", { term })}
                    placeholder={gt("Misspelling")}
                    className="ms-auto w-32"
                    onChange={(event) => setAliasDraft({ key, value: event.target.value })}
                    onBlur={() => setAliasDraft(null)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        event.currentTarget.closest<HTMLElement>("[data-app-modal]")?.focus();
                        setAliasDraft(null);
                      }
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addAlias(word);
                    }}
                  />
                ) : (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    className="ms-auto"
                    disabled={disabled}
                    aria-label={gt("Add an alias for {term}", { term })}
                    onClick={() => setAliasDraft({ key, value: "" })}
                  >
                    <T>Alias</T>
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={disabled}
                  aria-label={
                    language === "und"
                      ? gt("Remove {term}", { term })
                      : gt("Remove {term} ({language})", { term, language })
                  }
                  onClick={() => onRemove(word)}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
