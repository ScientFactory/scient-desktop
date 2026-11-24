import { useAtomValue } from "@effect/atom-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState, type ReactNode } from "react";

import type { MessageResolver } from "~/i18n/messages";

import { useActiveProjectTarget, type ActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useTheme } from "~/hooks/useTheme";
import { useRightPanelStore } from "~/rightPanelStore";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { type CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import {
  getProjectFilePickerMatches,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "./ProjectFilePicker.logic";
import { useProjectFilePickerQuery } from "./projectFilesQueryState";

interface ProjectFilePickerProps {
  readonly setOpen: (open: boolean) => void;
  // SCIENT-FORK:START — allow callers to select a file for their own action.
  readonly onSelectFile?: (relativePath: string) => void;
  readonly actionLabel?: string;
  readonly compactPaths?: boolean;
  // SCIENT-FORK:END
}

function HighlightedFuzzyText(props: {
  readonly active: boolean;
  readonly indices: ReadonlyArray<number>;
  readonly value: string;
}) {
  if (!props.active) return props.value;

  const parts: ReactNode[] = [];
  let start = 0;
  for (const index of props.indices) {
    if (start < index) parts.push(props.value.slice(start, index));
    parts.push(
      <strong className="font-semibold text-foreground" key={index}>
        {props.value[index]}
      </strong>,
    );
    start = index + 1;
  }
  if (start < props.value.length) parts.push(props.value.slice(start));

  return <span className="text-muted-foreground">{parts}</span>;
}

function getEmptyStateMessage(
  query: string,
  error: string | null,
  isPending: boolean,
  resolve: MessageResolver,
): string {
  if (error) return error;
  const isSearching = query.trim().length > 0;
  if (isPending)
    return isSearching
      ? resolve(msg("Searching workspace files…"))
      : resolve(msg("Indexing workspace files…"));
  return isSearching ? resolve(msg("No matching files.")) : resolve(msg("No files found."));
}

function EmptyProjectFilePicker() {
  const gt = useGT();
  return (
    <CommandPaletteContent
      aria-label={gt("File picker")}
      escapeLabel={gt("Back", { $context: "button, leaves the file picker" })}
      footerActionLabel={gt("Open file")}
      inputProps={{ disabled: true, placeholder: gt("Search files…") }}
      mode="none"
      testId="project-file-picker"
      value=""
    >
      <div className="py-10 text-center text-sm text-muted-foreground">
        <T>Open a project to search its files.</T>
      </div>
    </CommandPaletteContent>
  );
}

// SCIENT-FORK:START — support explicit file selection without a conversation.
export function ProjectFilePickerForTarget(
  props: ProjectFilePickerProps &
    (
      | { target: ActiveProjectTarget }
      | { target: Omit<ActiveProjectTarget, "threadRef">; onSelectFile: (path: string) => void }
    ),
) {
  // SCIENT-FORK:END
  const { target } = props;
  const gt = useGT();
  const messages = useMessages();
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const result = useProjectFilePickerQuery(
    target.environmentId,
    target.cwd,
    query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
    undefined,
    messages,
  );
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const matches = getProjectFilePickerMatches(result.entries, result.matchedQuery);
  const hasMatchedQuery = /\S/.test(result.matchedQuery);
  // SCIENT-FORK:START — show parent folders only for file names that need disambiguation.
  const duplicateNames = new Set<string>();
  if (props.compactPaths) {
    const seen = new Set<string>();
    for (const { name } of matches) {
      if (seen.has(name)) duplicateNames.add(name);
      seen.add(name);
    }
  }
  // SCIENT-FORK:END
  const items: CommandPaletteActionItem[] = matches.map((match) => ({
    kind: "action",
    value: `file:${match.path}`,
    searchTerms: [match.name, match.path],
    title: (
      <HighlightedFuzzyText
        active={hasMatchedQuery}
        value={match.name}
        indices={match.nameMatchIndices}
      />
    ),
    // SCIENT-FORK:START — compact pickers name a parent folder only to tell same-named files apart.
    description: props.compactPaths ? (
      duplicateNames.has(match.name) ? (
        match.path.slice(0, match.path.lastIndexOf("/")) || gt("Project root")
      ) : undefined
    ) : (
      <HighlightedFuzzyText
        active={hasMatchedQuery}
        value={match.path}
        indices={match.pathMatchIndices}
      />
    ),
    // SCIENT-FORK:END
    icon: <PierreEntryIcon pathValue={match.path} kind="file" theme={resolvedTheme} />,
    run: async () => {
      // SCIENT-FORK:START — return an input to the caller or open the file in the conversation.
      if (props.onSelectFile) props.onSelectFile(match.path);
      else if ("threadRef" in target)
        useRightPanelStore.getState().openFile(target.threadRef, match.path);
      // SCIENT-FORK:END
    },
  }));

  const emptyStateMessage = getEmptyStateMessage(query, result.error, result.isPending, messages);

  return (
    <CommandPaletteContent
      aria-label={gt("File picker")}
      autoHighlight="always"
      escapeLabel={gt("Back", { $context: "button, leaves the file picker" })}
      // SCIENT-FORK:START — use the caller's action label when selecting a file.
      footerActionLabel={props.actionLabel ?? gt("Open file")}
      // SCIENT-FORK:END
      inputProps={{ placeholder: gt("Search files…") }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      panelSize="tall-list"
      testId="project-file-picker"
      value={query}
    >
      <CommandPaletteResults
        groups={
          items.length > 0 ? [{ value: "project-files", label: target.projectName, items }] : []
        }
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={(item) => {
          if (item.kind !== "action") return;
          props.setOpen(false);
          void item.run();
        }}
        emptyStateMessage={emptyStateMessage}
      />
    </CommandPaletteContent>
  );
}

export function ProjectFilePicker(props: ProjectFilePickerProps) {
  const target = useActiveProjectTarget();

  if (!target) {
    return <EmptyProjectFilePicker />;
  }

  // SCIENT-FORK:START — forward the caller's file selection action.
  return <ProjectFilePickerForTarget {...props} target={target} />;
  // SCIENT-FORK:END
}
