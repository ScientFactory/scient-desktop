import type { ConnectorToolSummary, EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, WrenchIcon } from "lucide-react";
import { useState } from "react";
import ChatMarkdown from "../../components/ChatMarkdown";
import { ExtensionContentDialog } from "./ExtensionContentDialog";
import { ExtensionIcon } from "./ExtensionRow";
import { SECTION_HEADING_CLASS } from "./ExtensionsPage";
import {
  toolDescription,
  toolDisplayName,
  toolMakesChanges,
  toolSummary,
} from "./toolPresentation";

export function ConnectorToolsList({
  tools,
  environmentId,
  embedded = false,
}: {
  readonly tools: ReadonlyArray<ConnectorToolSummary>;
  readonly environmentId: EnvironmentId;
  /** A plain list inside an already-labelled group: no heading, frame, icons or change badges. */
  readonly embedded?: boolean | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<ConnectorToolSummary | null>(null);
  const ordered = [
    ...tools.filter((tool) => !toolMakesChanges(tool)),
    ...tools.filter(toolMakesChanges),
  ];
  const hidden = ordered.slice(6);
  const names = hidden.slice(0, 2).map(toolDisplayName);
  const more =
    hidden.length > 2
      ? `See ${names.join(", ")}, and ${hidden.length - 2} more`
      : `See ${names.join(" and ")}`;
  return (
    <section className={embedded ? undefined : "grid gap-3"} aria-label="Tools">
      {embedded ? null : (
        <h2 className={SECTION_HEADING_CLASS}>
          Tools <span className="font-normal text-muted-foreground">{tools.length}</span>
        </h2>
      )}
      <div
        className={
          embedded ? "pb-1" : "divide-y divide-border overflow-hidden rounded-xl border bg-card"
        }
      >
        {tools.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No tools reported.</p>
        ) : null}
        {(expanded ? ordered : ordered.slice(0, 6)).map((tool) => (
          <button
            key={tool.name}
            type="button"
            onClick={() => setSelected(tool)}
            className={
              embedded
                ? "flex w-full items-center gap-3 px-4 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                : "flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            }
          >
            {embedded ? null : <ExtensionIcon name={tool.name} glyph={WrenchIcon} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{toolDisplayName(tool)}</span>
              <span className="block truncate text-sm text-muted-foreground">
                {toolSummary(tool.description)}
              </span>
            </span>
            {!embedded && toolMakesChanges(tool) ? (
              <span className="shrink-0 text-xs text-muted-foreground">Makes changes</span>
            ) : null}
          </button>
        ))}
        {hidden.length > 0 && !expanded ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(true)}
            className={`flex w-full items-center gap-3 px-4 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${embedded ? "py-2" : "py-3"}`}
          >
            {embedded ? (
              <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center">
                <ChevronDownIcon aria-hidden className="size-4" />
              </span>
            )}
            <span>{more}</span>
          </button>
        ) : null}
      </div>
      {selected ? (
        <ExtensionContentDialog
          name={toolDisplayName(selected)}
          kind="Tool"
          glyph={WrenchIcon}
          description={toolSummary(selected.description)}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-6 py-3 text-xs text-muted-foreground">
            <code className="break-all">{selected.name}</code>
            {toolMakesChanges(selected) ? (
              <span>Makes changes</span>
            ) : selected.readOnly === true ? (
              <span>Read-only</span>
            ) : null}
          </div>
          {toolDescription(selected) ? (
            <ChatMarkdown
              text={toolDescription(selected)}
              cwd={undefined}
              environmentId={environmentId}
              contentDirection="auto"
              className="p-6"
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">No description provided.</p>
          )}
        </ExtensionContentDialog>
      ) : null}
    </section>
  );
}
