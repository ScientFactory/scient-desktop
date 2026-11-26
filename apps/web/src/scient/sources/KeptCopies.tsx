import type { ScientSourceDetailResult } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { Check, Copy } from "lucide-react";

import { Button } from "../../components/ui/button";
import { namedClipboardTarget, useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { dayLabel } from "./dayLabel";
import { SOURCE_FIELD_LABELS } from "./sourceLabels";

type KeptCopy = NonNullable<ScientSourceDetailResult["keptCopies"]>[number];

const isCreator = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A kept value as a person would copy it; null when there was none. */
function valueText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (
    Array.isArray(value) &&
    value.every(isCreator) &&
    value.some((entry) => "familyName" in entry)
  ) {
    return value
      .map((creator) =>
        typeof creator.literalName === "string"
          ? creator.literalName
          : [creator.familyName, creator.givenName].filter(Boolean).join(", "),
      )
      .join("; ");
  }
  return JSON.stringify(value, null, 2);
}

function KeptValue(props: { readonly label: string; readonly value: unknown }) {
  const gt = useGT();
  const text = valueText(props.value);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget(props.label),
  });
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{props.label}</span>
        {text !== null ? (
          <ScientTooltip
            content={isCopied ? gt("Copied", { $context: "state, after copying" }) : gt("Copy")}
          >
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={gt("Copy {value}", { value: props.label })}
              onClick={() => copyToClipboard(text)}
            >
              {isCopied ? <Check /> : <Copy />}
            </Button>
          </ScientTooltip>
        ) : null}
      </div>
      <p className="text-sm whitespace-pre-wrap wrap-break-word">
        {text ?? (
          <span className="text-muted-foreground">{gt("None", { $context: "no value" })}</span>
        )}
      </p>
    </div>
  );
}

/**
 * What this project's saved details held before a merge Undo replaced them with this source's
 * own record, beside the record's value now, so a person can copy back what they need.
 */
export function KeptCopies(props: { readonly copies: ReadonlyArray<KeptCopy> }) {
  const gt = useGT();
  const m = useMessages();
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        <T>Kept from before a merge was undone. Copy what you need.</T>
      </p>
      {props.copies.map((copy) => {
        const holder =
          copy.holder === "review"
            ? copy.holderName
              ? gt("In the review “{name}”", { name: copy.holderName })
              : gt("In a review")
            : gt("Cited as {key}", { key: copy.heldBy });
        const when = dayLabel(copy.undoneAt);
        return (
          <section
            key={`${copy.holder}:${copy.heldBy}:${copy.undoneAt}`}
            className="@container/kept space-y-2"
          >
            <h4 className="text-sm font-medium">
              {holder}
              <span className="font-normal text-muted-foreground">
                {copy.holderPresent
                  ? ` · ${gt("merge undone on {date}", { date: when })}`
                  : ` · ${gt("merge undone on {date}; no longer in this project", { date: when })}`}
              </span>
            </h4>
            {copy.fields.map((field) => {
              const name = SOURCE_FIELD_LABELS[field.field];
              const label = name ? m(name) : field.field;
              return (
                <div
                  key={field.field}
                  className="grid gap-x-4 gap-y-2 border-t border-border pt-2 @[28rem]/kept:grid-cols-2"
                >
                  <KeptValue label={gt("{field} before", { field: label })} value={field.earlier} />
                  <KeptValue label={gt("{field} now", { field: label })} value={field.current} />
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
