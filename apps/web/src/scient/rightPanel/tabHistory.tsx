import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type ReactNode } from "react";
import { create } from "zustand";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import {
  type RightPanelSurface,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

/**
 * Where Back leads from a file tab: the file or folder this tab showed before
 * it changed in place, or the tab a file was opened from.
 */
type HistoryEntry =
  | { readonly kind: "replaced"; readonly surface: FileLikeSurface }
  | { readonly kind: "tab"; readonly surfaceId: string };

type FileLikeSurface = Extract<RightPanelSurface, { readonly kind: "files" | "file" }>;
type Stacks = Readonly<Record<string, readonly HistoryEntry[]>>;

interface ThreadHistory {
  readonly back: Stacks;
  readonly forward: Stacks;
}

/** Runs a panel move once pending file saves allow it, as ChatView's openers do. */
export type TabDepartureGuard = (targetSurfaceId: string | null, run: () => void) => void;

const EMPTY_HISTORY: ThreadHistory = { back: {}, forward: {} };
const MAX_ENTRIES = 50;
const runAtOnce: TabDepartureGuard = (_targetSurfaceId, run) => run();

const useTabHistoryStore = create<{ byThreadKey: Record<string, ThreadHistory> }>(() => ({
  byThreadKey: {},
}));
const departureGuards = new Map<string, TabDepartureGuard>();

// Set while Back, Forward or a rename changes the panel, so the change is not recorded.
let applying = false;

function isFileLike(surface: RightPanelSurface | undefined): surface is FileLikeSurface {
  return surface?.kind === "files" || surface?.kind === "file";
}

function updateThread(threadKey: string, update: (history: ThreadHistory) => ThreadHistory) {
  useTabHistoryStore.setState((state) => ({
    byThreadKey: {
      ...state.byThreadKey,
      [threadKey]: update(state.byThreadKey[threadKey] ?? EMPTY_HISTORY),
    },
  }));
}

function withEntries(stacks: Stacks, surfaceId: string, entries: readonly HistoryEntry[]) {
  const { [surfaceId]: _previous, ...rest } = stacks;
  return entries.length === 0 ? rest : { ...rest, [surfaceId]: entries.slice(-MAX_ENTRIES) };
}

function mapStacks(history: ThreadHistory, map: (stacks: Stacks) => Stacks): ThreadHistory {
  return { back: map(history.back), forward: map(history.forward) };
}

/** Forgets closed tabs: their own history, and every way back to them. */
function forgetTabs(history: ThreadHistory, closedIds: ReadonlySet<string>): ThreadHistory {
  if (closedIds.size === 0) return history;
  return mapStacks(history, (stacks) => {
    const kept: Record<string, readonly HistoryEntry[]> = {};
    for (const [surfaceId, entries] of Object.entries(stacks)) {
      if (closedIds.has(surfaceId)) continue;
      const live = entries.filter(
        (entry) => entry.kind !== "tab" || !closedIds.has(entry.surfaceId),
      );
      if (live.length > 0) kept[surfaceId] = live;
    }
    return kept;
  });
}

/**
 * Points ways back to a tab at its new id after it changed in place. A tab
 * never keeps a way back to itself.
 */
function retargetTab(history: ThreadHistory, fromId: string, toId: string): ThreadHistory {
  return mapStacks(history, (stacks) => {
    const retargeted: Record<string, readonly HistoryEntry[]> = {};
    for (const [surfaceId, entries] of Object.entries(stacks)) {
      const kept = entries
        .map((entry) =>
          entry.kind === "tab" && entry.surfaceId === fromId
            ? { ...entry, surfaceId: toId }
            : entry,
        )
        .filter((entry) => entry.kind !== "tab" || entry.surfaceId !== surfaceId);
      if (kept.length > 0) retargeted[surfaceId] = kept;
    }
    return retargeted;
  });
}

/**
 * Records one change of a thread's panel. A tab that changes in place and a
 * file opened from another tab become history; closing a tab is not a move,
 * and a closed tab leaves the history.
 */
function recordTabHistoryChange(
  threadKey: string,
  next: ThreadRightPanelState | undefined,
  previous: ThreadRightPanelState | undefined,
  closed: boolean,
) {
  if (applying || !previous) return;
  // A panel whose last tab closed leaves no state behind.
  const openIds = new Set(next?.surfaces.map((surface) => surface.id));
  const closedIds = new Set(
    previous.surfaces.map((surface) => surface.id).filter((surfaceId) => !openIds.has(surfaceId)),
  );
  const before = previous.surfaces.find((surface) => surface.id === previous.activeSurfaceId);
  const after = next?.surfaces.find((surface) => surface.id === next.activeSurfaceId);
  if (!closed && before && after && before.id !== after.id && isFileLike(after)) {
    if (!openIds.has(before.id) && isFileLike(before)) {
      // The tab changed in place, as when Files opens a file or a crumb opens a
      // folder, or gave way to the tab already showing what it opened.
      closedIds.delete(before.id);
      updateThread(threadKey, (history) =>
        forgetTabs(
          retargetTab(
            {
              back: withEntries(withEntries(history.back, before.id, []), after.id, [
                ...(history.back[before.id] ?? []),
                { kind: "replaced", surface: before },
              ]),
              forward: withEntries(withEntries(history.forward, before.id, []), after.id, []),
            },
            before.id,
            after.id,
          ),
          closedIds,
        ),
      );
      return;
    }
    const afterBefore = previous.surfaces.find((surface) => surface.id === after.id);
    if (openIds.has(before.id) && afterBefore !== after) {
      // A file opened from another tab, in a new tab or the one already showing
      // it. Picking a tab in the strip leaves the tab itself unchanged.
      updateThread(threadKey, (history) =>
        forgetTabs(
          {
            back: withEntries(history.back, after.id, [
              ...(afterBefore ? (history.back[after.id] ?? []) : []),
              { kind: "tab", surfaceId: before.id },
            ]),
            forward: withEntries(history.forward, after.id, []),
          },
          closedIds,
        ),
      );
      return;
    }
  }
  if (closedIds.size > 0) updateThread(threadKey, (history) => forgetTabs(history, closedIds));
}

/**
 * Keeps a thread's tab history while its panel is on screen; Back and Forward
 * wait on `guard` before they move the panel. Returns the cleanup.
 */
export function watchTabHistory(threadKey: string, guard: TabDepartureGuard = runAtOnce) {
  departureGuards.set(threadKey, guard);
  const unsubscribe = useRightPanelStore.subscribe((state, previousState) =>
    recordTabHistoryChange(
      threadKey,
      state.byThreadKey[threadKey],
      previousState.byThreadKey[threadKey],
      state.closeRevisionByThreadKey[threadKey] !==
        previousState.closeRevisionByThreadKey[threadKey],
    ),
  );
  return () => {
    unsubscribe();
    if (departureGuards.get(threadKey) === guard) departureGuards.delete(threadKey);
  };
}

/** Records how file tabs change, while this thread's panel is on screen. */
export function useRightPanelTabHistory(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly runAfterPendingFileSave: TabDepartureGuard;
}) {
  const { threadRef, runAfterPendingFileSave } = input;
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const guardRef = useRef(runAfterPendingFileSave);
  useLayoutEffect(() => {
    guardRef.current = runAfterPendingFileSave;
  }, [runAfterPendingFileSave]);

  useEffect(() => {
    if (!threadKey) return;
    return watchTabHistory(threadKey, (target, run) => guardRef.current(target, run));
  }, [threadKey]);

  // ⌘[ and ⌘] belong to a file tab's own history while the keyboard is in it,
  // even with nowhere to go, rather than moving between threads.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!threadRef || event.defaultPrevented) return;
    const command = resolveShortcutCommand(event, input.keybindings, { context: {} });
    if (command !== "navigation.back" && command !== "navigation.forward") return;
    const focused = document.activeElement;
    if (!focused?.closest("[data-right-panel-surface-content]")) return;
    const panel = useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)];
    const active = panel?.surfaces.find((surface) => surface.id === panel.activeSurfaceId);
    if (!isFileLike(active)) return;
    event.preventDefault();
    event.stopPropagation();
    if (command === "navigation.back") goBackInTab(threadRef, active.id);
    else goForwardInTab(threadRef, active.id);
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);
}

function surfaceById(threadRef: ScopedThreadRef, surfaceId: string) {
  const panel = useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)];
  return panel?.surfaces.find((surface) => surface.id === surfaceId);
}

function withoutApplying(run: () => void) {
  applying = true;
  try {
    run();
  } finally {
    applying = false;
  }
}

/** Shows `target` in place of the file tab `current`, and returns its new id. */
function showInPlace(
  threadRef: ScopedThreadRef,
  current: FileLikeSurface,
  target: FileLikeSurface,
) {
  const path = target.kind === "files" ? "" : target.relativePath;
  withoutApplying(() =>
    useRightPanelStore
      .getState()
      .navigateFolder(threadRef, current.id, path, target.folderTrail ?? path),
  );
  return path === "" ? "files" : `file:${path}`;
}

/** The entry Back or Forward would take, after dropping ways to tabs since closed. */
function nextEntry(threadRef: ScopedThreadRef, surfaceId: string, direction: "back" | "forward") {
  const threadKey = scopedThreadKey(threadRef);
  const stacks = (useTabHistoryStore.getState().byThreadKey[threadKey] ?? EMPTY_HISTORY)[direction];
  const stack = [...(stacks[surfaceId] ?? [])];
  while (stack.length > 0) {
    const entry = stack.at(-1)!;
    if (entry.kind === "replaced" || surfaceById(threadRef, entry.surfaceId)) break;
    stack.pop();
  }
  if (stack.length !== (stacks[surfaceId] ?? []).length) {
    updateThread(threadKey, (history) => ({
      ...history,
      [direction]: withEntries(history[direction], surfaceId, stack),
    }));
  }
  return stack.at(-1) ?? null;
}

function step(threadRef: ScopedThreadRef, surfaceId: string, direction: "back" | "forward") {
  const entry = nextEntry(threadRef, surfaceId, direction);
  if (!entry || !isFileLike(surfaceById(threadRef, surfaceId))) return false;
  const threadKey = scopedThreadKey(threadRef);
  const guard = departureGuards.get(threadKey) ?? runAtOnce;
  guard(entry.kind === "tab" ? entry.surfaceId : entry.surface.id, () =>
    applyStep(threadRef, surfaceId, direction, entry),
  );
  return true;
}

/** Moves once any pending save allows it, if the history still leads there. */
function applyStep(
  threadRef: ScopedThreadRef,
  surfaceId: string,
  direction: "back" | "forward",
  entry: HistoryEntry,
) {
  const threadKey = scopedThreadKey(threadRef);
  const history = useTabHistoryStore.getState().byThreadKey[threadKey] ?? EMPTY_HISTORY;
  const from = history[direction];
  const to = direction === "back" ? history.forward : history.back;
  const stack = from[surfaceId] ?? [];
  const current = surfaceById(threadRef, surfaceId);
  if (stack.at(-1) !== entry || !isFileLike(current)) return;
  const rest = stack.slice(0, -1);
  const store = (nextFrom: Stacks, nextTo: Stacks): ThreadHistory =>
    direction === "back"
      ? { back: nextFrom, forward: nextTo }
      : { back: nextTo, forward: nextFrom };

  if (entry.kind === "tab") {
    const target = surfaceById(threadRef, entry.surfaceId);
    if (!target) return;
    withoutApplying(() => useRightPanelStore.getState().activateSurface(threadRef, target.id));
    // Only a file tab has Back and Forward of its own to return with. Going back
    // to any other tab keeps this way back, so it stays one click away.
    if (!isFileLike(target)) return;
    updateThread(threadKey, () =>
      store(
        withEntries(from, surfaceId, rest),
        withEntries(to, target.id, [...(to[target.id] ?? []), { kind: "tab", surfaceId }]),
      ),
    );
    return;
  }
  const newId = showInPlace(threadRef, current, entry.surface);
  updateThread(threadKey, () =>
    retargetTab(
      store(
        withEntries(withEntries(from, surfaceId, []), newId, rest),
        withEntries(withEntries(to, surfaceId, []), newId, [
          ...(to[surfaceId] ?? []),
          { kind: "replaced", surface: current },
        ]),
      ),
      surfaceId,
      newId,
    ),
  );
}

export const goBackInTab = (threadRef: ScopedThreadRef, surfaceId: string) =>
  step(threadRef, surfaceId, "back");
export const goForwardInTab = (threadRef: ScopedThreadRef, surfaceId: string) =>
  step(threadRef, surfaceId, "forward");

/**
 * Renames a file tab without recording a move: its history, and every way back
 * to it, follow the new path.
 */
export function renameInTabHistory(
  threadRef: ScopedThreadRef,
  fromPath: string,
  toPath: string,
  rename: () => void,
) {
  withoutApplying(rename);
  const fromId = `file:${fromPath}` as const;
  const toId = `file:${toPath}` as const;
  const follow = (entry: HistoryEntry): HistoryEntry =>
    entry.kind === "replaced" && entry.surface.kind === "file" && entry.surface.id === fromId
      ? { kind: "replaced", surface: { ...entry.surface, id: toId, relativePath: toPath } }
      : entry;
  updateThread(scopedThreadKey(threadRef), (history) =>
    retargetTab(
      mapStacks(history, (stacks) => {
        const moved: Record<string, readonly HistoryEntry[]> = {};
        for (const [surfaceId, entries] of Object.entries(stacks)) {
          if (surfaceId !== fromId) moved[surfaceId] = entries.map(follow);
        }
        // The renamed tab's history goes to the new path. A tab already open
        // there keeps its own, under the renamed tab's: that is where you were.
        const renamed = (stacks[fromId] ?? []).map(follow);
        if (renamed.length > 0) {
          moved[toId] = [...(moved[toId] ?? []), ...renamed].slice(-MAX_ENTRIES);
        }
        return moved;
      }),
      fromId,
      toId,
    ),
  );
}

/** How many steps Back and Forward hold for a tab. */
export function tabHistoryDepth(threadRef: ScopedThreadRef, surfaceId: string) {
  const history =
    useTabHistoryStore.getState().byThreadKey[scopedThreadKey(threadRef)] ?? EMPTY_HISTORY;
  return {
    back: history.back[surfaceId]?.length ?? 0,
    forward: history.forward[surfaceId]?.length ?? 0,
  };
}

/** ← and → for a file tab, always shown as in a browser, greyed out with nowhere to go. */
export function TabHistoryButtons(props: {
  readonly className?: string;
  readonly threadRef: ScopedThreadRef;
  readonly surfaceId: string | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const threadKey = scopedThreadKey(props.threadRef);
  const canGoBack = useTabHistoryStore(
    (state) => (state.byThreadKey[threadKey]?.back[props.surfaceId ?? ""]?.length ?? 0) > 0,
  );
  const canGoForward = useTabHistoryStore(
    (state) => (state.byThreadKey[threadKey]?.forward[props.surfaceId ?? ""]?.length ?? 0) > 0,
  );
  if (!props.surfaceId) return null;
  const surfaceId = props.surfaceId;
  const backKey = shortcutLabelForCommand(props.keybindings, "navigation.back");
  const forwardKey = shortcutLabelForCommand(props.keybindings, "navigation.forward");
  const button = (
    label: string,
    shortcut: string | null,
    enabled: boolean,
    onPress: () => void,
    icon: ReactNode,
  ) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={!enabled}
            size="icon-xs"
            variant="ghost-muted"
            onClick={onPress}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup>
        {label}
        {shortcut ? <span className="ms-2 text-muted-foreground">{shortcut}</span> : null}
      </TooltipPopup>
    </Tooltip>
  );
  return (
    <div className={cn("flex shrink-0 items-center", props.className)}>
      {button(
        "Back",
        backKey,
        canGoBack,
        () => goBackInTab(props.threadRef, surfaceId),
        <ArrowLeft aria-hidden className="scient-quiet-icon size-4" />,
      )}
      {button(
        "Forward",
        forwardKey,
        canGoForward,
        () => goForwardInTab(props.threadRef, surfaceId),
        <ArrowRight aria-hidden className="scient-quiet-icon size-4" />,
      )}
    </div>
  );
}
