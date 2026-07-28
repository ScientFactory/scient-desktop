// FILE: browserPictureInPicture.ts
// Purpose: Pure identity, lifecycle, and frame rules for the floating in-chat browser.
// Layer: Web UI state helper
// Depends on: browser state metadata only; never owns or persists a browser runtime.

import type { ProjectId, ThreadBrowserState, ThreadId } from "@synara/contracts";

export const FLOATING_BROWSER_FRAME_MARGIN = 12;
export const FLOATING_BROWSER_INITIAL_SIZE = { width: 440, height: 300 } as const;
export const FLOATING_BROWSER_MINIMUM_SIZE = { width: 280, height: 190 } as const;

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
    size: FLOATING_BROWSER_INITIAL_SIZE,
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

function nonnegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function between(value: number, lower: number, upper: number): number {
  const numericValue = Number.isFinite(value) ? value : lower;
  return Math.round(Math.max(lower, Math.min(numericValue, upper)));
}

function fitLength(requested: number, available: number, preferredMinimum: number): number {
  const maximum = Math.max(1, nonnegative(available) - FLOATING_BROWSER_FRAME_MARGIN * 2);
  const minimum = Math.min(preferredMinimum, maximum);
  return between(requested, minimum, maximum);
}

function fitOrigin(requested: number, available: number, length: number): number {
  const areaLength = nonnegative(available);
  const nearEdge =
    areaLength >= FLOATING_BROWSER_FRAME_MARGIN * 2 ? FLOATING_BROWSER_FRAME_MARGIN : 0;
  const farEdge = Math.max(nearEdge, areaLength - length);
  return between(requested, nearEdge, farEdge);
}

export function fitFloatingBrowserLayout(
  requested: BrowserPictureInPictureLayout,
  available: BrowserPictureInPictureSize,
): BrowserPictureInPictureLayout {
  const size = {
    width: fitLength(requested.size.width, available.width, FLOATING_BROWSER_MINIMUM_SIZE.width),
    height: fitLength(
      requested.size.height,
      available.height,
      FLOATING_BROWSER_MINIMUM_SIZE.height,
    ),
  };
  return {
    position: {
      x: fitOrigin(requested.position.x, available.width, size.width),
      y: fitOrigin(requested.position.y, available.height, size.height),
    },
    size,
  };
}

export function updateFloatingBrowserLayoutFromKey(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly position: BrowserPictureInPicturePoint;
  readonly size: BrowserPictureInPictureSize;
  readonly container: BrowserPictureInPictureSize;
}): BrowserPictureInPictureLayout | null {
  if (!input.key.startsWith("Arrow")) return null;
  const amount = input.shiftKey ? 32 : 8;
  const requested = {
    position: { ...input.position },
    size: { ...input.size },
  };

  switch (input.key) {
    case "ArrowLeft":
      if (input.altKey) requested.size.width -= amount;
      else requested.position.x -= amount;
      break;
    case "ArrowRight":
      if (input.altKey) requested.size.width += amount;
      else requested.position.x += amount;
      break;
    case "ArrowUp":
      if (input.altKey) requested.size.height -= amount;
      else requested.position.y -= amount;
      break;
    case "ArrowDown":
      if (input.altKey) requested.size.height += amount;
      else requested.position.y += amount;
      break;
    default:
      return null;
  }

  return fitFloatingBrowserLayout(requested, input.container);
}
