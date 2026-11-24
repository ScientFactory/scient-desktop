import { T, useGT, useLocale } from "gt-react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { languageLabel } from "../../lib/languageLabel";

const PRIMARY_LANGUAGES: ReadonlyArray<string> = ["fr", "en", "he", "ar"];

export function VoiceLanguagePicker<Language extends string>({
  label,
  value,
  languages,
  special,
  onChange,
}: {
  label: string;
  value: Language;
  languages: readonly Language[];
  special: { value: Language; label: string; recommended?: boolean; clearOnly?: boolean };
  onChange: (language: Language) => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const term = query.trim().toLocaleLowerCase();
  const options = [...new Set(languages)]
    .map((code) => ({ code, name: languageLabel(code, locale) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  const primary = PRIMARY_LANGUAGES.flatMap((code) =>
    options.filter((option) => option.code === code),
  );
  const more = options.filter(({ code }) => !PRIMARY_LANGUAGES.includes(code));
  const results = term
    ? [...primary, ...more].filter(({ code, name }) =>
        [code, name, languageLabel(code), languageLabel(code, code)].some((text) =>
          text.toLocaleLowerCase().includes(term),
        ),
      )
    : [];

  function select(code: Language) {
    onChange(code);
    setOpen(false);
    setQuery("");
  }

  const row = (code: Language, name: string, recommended?: boolean) => (
    <Button
      key={code}
      aria-pressed={value === code}
      className="w-full justify-start"
      onClick={() => select(code)}
      size="sm-multiline"
      variant={value === code ? "selected" : "ghost-muted"}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 text-start">
        <span>{name}</span>
        {recommended ? (
          <Badge size="sm" variant="info">
            <T>Recommended</T>
          </Badge>
        ) : null}
      </span>
      {value === code ? <CheckIcon className="stroke-[2.5]" /> : null}
    </Button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setExpanded(more.some(({ code }) => code === value));
        else setQuery("");
      }}
    >
      <PopoverTrigger render={<Button aria-label={label} size="sm" variant="outline" />}>
        {value === special.value
          ? special.clearOnly
            ? label
            : special.label
          : languageLabel(value, locale)}
        <ChevronDownIcon className="size-3.5 stroke-[2.5] opacity-70" />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        aria-label={label}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        className="group/languages w-56 max-w-[calc(100vw-1rem)]"
        initialFocus={search}
        padding="none"
        sideOffset={4}
      >
        <div className="flex max-h-[min(22rem,var(--available-height))] flex-col gap-1 p-1">
          <div className="shrink-0 group-data-[side=top]/languages:order-last">
            <Input
              ref={search}
              size="sm"
              type="search"
              aria-label={gt("Search languages")}
              placeholder={gt("Search languages")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && results.length === 1 && results[0]) {
                  event.preventDefault();
                  select(results[0].code);
                }
              }}
            />
          </div>
          <div className="min-h-0 space-y-0.5 overflow-y-auto overscroll-contain">
            {term ? (
              results.length ? (
                results.map(({ code, name }) => row(code, name))
              ) : (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  <T>No languages found</T>
                </p>
              )
            ) : (
              <>
                {!special.clearOnly || value !== special.value
                  ? row(special.value, special.label, special.recommended)
                  : null}
                {primary.map(({ code, name }) => row(code, name))}
                {more.length ? (
                  <div className="mt-1 space-y-0.5 border-t border-border/60 pt-1">
                    <Button
                      aria-expanded={expanded}
                      className="w-full justify-start"
                      onClick={() => setExpanded((previous) => !previous)}
                      size="sm-multiline"
                      variant="ghost-muted"
                    >
                      <span className="flex-1 text-start">
                        <T>More languages</T>
                      </span>
                      <ChevronRightIcon className={expanded ? "rotate-90" : undefined} />
                    </Button>
                    {expanded ? more.map(({ code, name }) => row(code, name)) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
