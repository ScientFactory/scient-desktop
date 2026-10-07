import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronRightIcon } from "lucide-react";
import { type RefObject, useCallback, useState } from "react";
import { cn } from "~/lib/utils";
import { shortcutLabelForCommand } from "../keybindings";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteRow,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  CommandGroup,
  CommandGroupLabel,
  CommandList,
  CommandItem,
  CommandListHeading,
  CommandListVirtualized,
  CommandShortcut,
} from "./ui/command";
import { getVirtualizedScrollFadeClassName } from "./ui/scroll-area";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}

function CommandPaletteEmptyState(props: { emptyStateMessage?: string; isActionsOnly: boolean }) {
  return (
    <div className="py-10 text-center text-sm text-muted-foreground">
      {props.emptyStateMessage ??
        (props.isActionsOnly
          ? "No matching actions."
          : "No matching commands, projects, or threads.")}
    </div>
  );
}

/** Bounded file and favicon pickers share the same result row with the main palette. */
export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (!props.groups.some((group) => group.items.length > 0))
    return <CommandPaletteEmptyState {...props} />;
  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup key={group.value}>
          {group.label ? <CommandGroupLabel>{group.label}</CommandGroupLabel> : null}
          {group.items.map((item) =>
            item.disabled ? (
              <DisabledCommandPaletteResultRow key={item.value} item={item} />
            ) : (
              <CommandPaletteResultRow
                key={item.value}
                item={item}
                keybindings={props.keybindings}
                isActive={props.highlightedItemValue === item.value}
                onExecuteItem={props.onExecuteItem}
              />
            ),
          )}
        </CommandGroup>
      ))}
    </CommandList>
  );
}

/**
 * Scrolls a keyboard highlight into view the way the unvirtualized list did:
 * nearest edge, clear of the scroll fade. Rows outside the rendered window
 * fall back to the list's own scrolling.
 */
export function scrollCommandPaletteRowIntoView(list: LegendListRef | null, rowIndex: number) {
  if (rowIndex < 0) return;
  const element = list?.getState?.().elementAtIndex(rowIndex);
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "nearest" });
    return;
  }
  void list?.scrollIndexIntoView?.({ index: rowIndex, animated: false });
}

interface CommandPaletteVirtualizedResultsProps extends Omit<CommandPaletteResultsProps, "groups"> {
  rows: ReadonlyArray<CommandPaletteRow>;
  listRef: RefObject<LegendListRef | null>;
}

/**
 * Renders only the visible rows. The parent passes the flat item order to the
 * Command root as `items` with `virtualized`, scrolls keyboard highlights into
 * view through `listRef`, and runs Enter itself since the row may be unmounted.
 */
export function CommandPaletteVirtualizedResults(props: CommandPaletteVirtualizedResultsProps) {
  const { listRef } = props;
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });
  const updateScrollFade = useCallback(() => {
    const scrollElement = listRef.current?.getScrollableNode?.();
    if (!(scrollElement instanceof HTMLElement)) return;
    const top = scrollElement.scrollTop > 1;
    const bottom =
      scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop > 1;
    setScrollFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  }, [listRef]);

  if (props.rows.length === 0) {
    return <CommandPaletteEmptyState {...props} />;
  }

  const scrollingRows = props.rows.filter((row) => !row.pinned);
  const pinnedRows = props.rows.filter((row) => row.pinned);
  const renderRow = (row: CommandPaletteRow) =>
    row.kind === "label" ? (
      <div className={row.first ? undefined : "pt-1.5"}>
        <CommandListHeading>{row.label}</CommandListHeading>
      </div>
    ) : row.itemIndex === null ? (
      <DisabledCommandPaletteResultRow item={row.item} />
    ) : (
      <CommandPaletteResultRow
        index={row.itemIndex}
        item={row.item}
        keybindings={props.keybindings}
        isActive={props.highlightedItemValue === row.item.value}
        onExecuteItem={props.onExecuteItem}
      />
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CommandListVirtualized>
        <LegendList<CommandPaletteRow>
          ref={listRef}
          data={scrollingRows}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.kind}
          extraData={props.highlightedItemValue}
          renderItem={({ item: row }) => renderRow(row)}
          estimatedItemSize={40}
          drawDistance={400}
          onLayout={updateScrollFade}
          onScroll={updateScrollFade}
          contentContainerClassName="px-2"
          className={cn(
            "min-h-0 scroll-py-6 overflow-x-hidden overscroll-y-contain py-2",
            getVirtualizedScrollFadeClassName(scrollFade),
          )}
        />
      </CommandListVirtualized>
      {pinnedRows.length > 0 ? (
        <div className="shrink-0 border-t px-2 py-2">
          {pinnedRows.map((row) => (
            <div key={row.key}>{renderRow(row)}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DisabledCommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  return (
    <div className="flex min-h-8 select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm">
      {props.item.icon}
      {props.item.description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <span className="truncate">{props.item.title}</span>
          </span>
          {props.item.threadContentMatch ? (
            <ThreadSearchMatchExcerpt match={props.item.threadContentMatch} />
          ) : null}
          {props.item.description ? (
            <span className="min-w-0 text-muted-foreground/70 text-xs">
              {props.item.description}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <span className="truncate">{props.item.title}</span>
        </span>
      )}
      {props.item.titleTrailingContent}
    </div>
  );
}

function CommandPaletteResultRow(props: {
  index?: number;
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      {...(props.index === undefined ? {} : { index: props.index })}
      value={props.item.value}
      active={props.isActive}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      {props.item.icon}
      {props.item.description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <span className="truncate">{props.item.title}</span>
          </span>
          {props.item.threadContentMatch ? (
            <ThreadSearchMatchExcerpt match={props.item.threadContentMatch} />
          ) : null}
          {props.item.description ? (
            <span className="min-w-0 text-muted-foreground/70 text-xs">
              {props.item.description}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <span className="truncate">{props.item.title}</span>
        </span>
      )}
      {props.item.titleTrailingContent}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
      ) : null}
    </CommandItem>
  );
}
