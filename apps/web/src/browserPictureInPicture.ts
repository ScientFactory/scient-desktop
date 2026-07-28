// FILE: browserPictureInPicture.ts
// Purpose: Pure identity, lifecycle, and layout rules for the in-chat browser mini-player.
// Layer: Web UI state helper
// Depends on: browser state metadata only; never owns or persists a browser runtime.
// Provenance: Scient-native reimplementation informed by third-party donor commits
// f4c39432 and 32af2f00 (MIT); full revisions are retained in Git/PR history.

import type { ProjectId, ThreadBrowserState, ThreadId } from "@synara/contracts";

export const BROWSER_PIP_EDGE_GAP = 12;
export const BROWSER_PIP_DEFAULT_SIZE = { width: 440, height: 300 } as const;
export const BROWSER_PIP_MIN_SIZE = { width: 280, height: 190 } as const;

export interface BrowserPictureInPicturePoint {
  readonly x: number;
  readonly y: number;
}

export interface BrowserPictureInPictureSize {
  readonly width: number;
  readonly height: number;
}

export interface BrowserPictureInPictureIdentity {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly paneId: string;
  readonly tabId: string;
  readonly generation: number;
}

export interface BrowserPictureInPictureState {
  readonly identity: BrowserPictureInPictureIdentity;
  readonly observedBrowserVersion: number;
  readonly position: BrowserPictureInPicturePoint | null;
  readonly size: BrowserPictureInPictureSize;
}

export interface BrowserPictureInPictureLayout {
  readonly position: BrowserPictureInPicturePoint;
  readonly size: BrowserPictureInPictureSize;
}

export function openBrowserPictureInPicture(input: {
  threadId: ThreadId;
  projectId: ProjectId | null;
  paneId: string;
  tabId: string;
  browserVersion: number;
  generation: number;
}): BrowserPictureInPictureState {
  return {
    identity: {
      threadId: input.threadId,
      projectId: input.projectId,
      paneId: input.paneId,
      tabId: input.tabId,
      generation: input.generation,
    },
    observedBrowserVersion: input.browserVersion,
    position: null,
    size: BROWSER_PIP_DEFAULT_SIZE,
  };
}

export function browserPictureInPictureIdentityMatches(
  state: BrowserPictureInPictureState,
  expected: BrowserPictureInPictureIdentity,
): boolean {
  return (
    state.identity.threadId === expected.threadId &&
    state.identity.projectId === expected.projectId &&
    state.identity.paneId === expected.paneId &&
    state.identity.tabId === expected.tabId &&
    state.identity.generation === expected.generation
  );
}

// A floating surface is intentionally ephemeral. It is closed rather than migrated when
// its route owner, project, or dock pane disappears. Browser updates are version-fenced so
// an older async snapshot cannot retarget the mini-player after a newer tab selection.
export function reconcileBrowserPictureInPicture(
  state: BrowserPictureInPictureState | null,
  input: {
    threadId: ThreadId;
    projectId: ProjectId | null;
    browserPaneId: string | null;
    browserState: ThreadBrowserState | null | undefined;
  },
): BrowserPictureInPictureState | null {
  if (!state) {
    return null;
  }
  if (
    state.identity.threadId !== input.threadId ||
    state.identity.projectId !== input.projectId ||
    state.identity.paneId !== input.browserPaneId
  ) {
    return null;
  }

  const browserState = input.browserState;
  if (!browserState || browserState.threadId !== state.identity.threadId) {
    return state;
  }
  if (browserState.version < state.observedBrowserVersion) {
    return state;
  }

  const activeTabId = browserState.activeTabId;
  if (!activeTabId || !browserState.tabs.some((tab) => tab.id === activeTabId)) {
    return null;
  }
  if (
    activeTabId === state.identity.tabId &&
    browserState.version === state.observedBrowserVersion
  ) {
    return state;
  }

  return {
    ...state,
    identity:
      activeTabId === state.identity.tabId
        ? state.identity
        : {
            ...state.identity,
            tabId: activeTabId,
            // Invalidates pointer callbacks that began against the previous tab surface.
            generation: state.identity.generation + 1,
          },
    observedBrowserVersion: browserState.version,
  };
}

export function closeBrowserPictureInPicture(
  state: BrowserPictureInPictureState | null,
  expected: BrowserPictureInPictureIdentity,
): BrowserPictureInPictureState | null {
  return state && browserPictureInPictureIdentityMatches(state, expected) ? null : state;
}

export function browserPictureInPictureOwnerPaneIdToClose(
  state: BrowserPictureInPictureState | null,
  expected: BrowserPictureInPictureIdentity,
): string | null {
  return state && browserPictureInPictureIdentityMatches(state, expected)
    ? state.identity.paneId
    : null;
}

export function commitBrowserPictureInPictureLayout(
  state: BrowserPictureInPictureState | null,
  expected: BrowserPictureInPictureIdentity,
  layout: BrowserPictureInPictureLayout,
): BrowserPictureInPictureState | null {
  if (!state || !browserPictureInPictureIdentityMatches(state, expected)) {
    return state;
  }
  if (
    state.position?.x === layout.position.x &&
    state.position.y === layout.position.y &&
    state.size.width === layout.size.width &&
    state.size.height === layout.size.height
  ) {
    return state;
  }
  return { ...state, position: layout.position, size: layout.size };
}

function finiteDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function clampBrowserPictureInPictureSize(
  size: BrowserPictureInPictureSize,
  container: BrowserPictureInPictureSize,
): BrowserPictureInPictureSize {
  const availableWidth = Math.max(1, finiteDimension(container.width) - BROWSER_PIP_EDGE_GAP * 2);
  const availableHeight = Math.max(1, finiteDimension(container.height) - BROWSER_PIP_EDGE_GAP * 2);
  return {
    width: Math.round(
      Math.min(availableWidth, Math.max(BROWSER_PIP_MIN_SIZE.width, finiteDimension(size.width))),
    ),
    height: Math.round(
      Math.min(
        availableHeight,
        Math.max(BROWSER_PIP_MIN_SIZE.height, finiteDimension(size.height)),
      ),
    ),
  };
}

function clampCoordinate(value: number, extent: number): number {
  const safeExtent = finiteDimension(extent);
  const inset = safeExtent >= BROWSER_PIP_EDGE_GAP * 2 ? BROWSER_PIP_EDGE_GAP : 0;
  return Math.round(Math.min(Math.max(finiteDimension(value), inset), Math.max(inset, safeExtent)));
}

export function clampBrowserPictureInPicturePosition(
  position: BrowserPictureInPicturePoint,
  container: BrowserPictureInPictureSize,
  player: BrowserPictureInPictureSize,
): BrowserPictureInPicturePoint {
  return {
    x: clampCoordinate(
      position.x,
      finiteDimension(container.width) - finiteDimension(player.width),
    ),
    y: clampCoordinate(
      position.y,
      finiteDimension(container.height) - finiteDimension(player.height),
    ),
  };
}

export function resolveBrowserPictureInPictureKeyboardLayout(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly position: BrowserPictureInPicturePoint;
  readonly size: BrowserPictureInPictureSize;
  readonly container: BrowserPictureInPictureSize;
}): BrowserPictureInPictureLayout | null {
  const direction =
    input.key === "ArrowLeft"
      ? { x: -1, y: 0 }
      : input.key === "ArrowRight"
        ? { x: 1, y: 0 }
        : input.key === "ArrowUp"
          ? { x: 0, y: -1 }
          : input.key === "ArrowDown"
            ? { x: 0, y: 1 }
            : null;
  if (!direction) return null;
  const step = input.shiftKey ? 32 : 8;
  if (input.altKey) {
    const size = clampBrowserPictureInPictureSize(
      {
        width: input.size.width + direction.x * step,
        height: input.size.height + direction.y * step,
      },
      input.container,
    );
    return {
      position: clampBrowserPictureInPicturePosition(input.position, input.container, size),
      size,
    };
  }
  return {
    position: clampBrowserPictureInPicturePosition(
      {
        x: input.position.x + direction.x * step,
        y: input.position.y + direction.y * step,
      },
      input.container,
      input.size,
    ),
    size: input.size,
  };
}
