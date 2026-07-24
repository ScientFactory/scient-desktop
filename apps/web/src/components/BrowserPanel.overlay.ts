// FILE: BrowserPanel.overlay.ts
// Purpose: Keeps Electron's native browser surface behind app-owned menus and dialogs.
// Layer: Browser panel DOM/native-surface coordination

// Electron guest surfaces are composited above ordinary renderer DOM. App-owned overlays
// therefore need the native surface hidden while they intersect the browser viewport.
const NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR = [
  "[data-native-browser-overlay='true']",
  "[data-slot='menu-positioner']",
  "[data-slot='menu-popup']",
  "[data-slot='menu-sub-content']",
  "[data-slot='select-positioner']",
  "[data-slot='select-popup']",
  "[data-slot='combobox-positioner']",
  "[data-slot='combobox-popup']",
  "[data-slot='popover-positioner']",
  "[data-slot='popover-popup']",
  "[data-slot='dialog-backdrop']",
  "[data-slot='dialog-popup']",
  "[data-slot='dialog-viewport']",
  "[data-slot='alert-dialog-backdrop']",
  "[data-slot='alert-dialog-popup']",
  "[data-slot='alert-dialog-viewport']",
  "[data-slot='command-dialog-backdrop']",
  "[data-slot='command-dialog-popup']",
  "[data-slot='command-dialog-viewport']",
  "[data-slot='toast-popup']",
  "[role='dialog'][aria-modal='true']",
].join(", ");

// The browser itself lives inside a sheet, and toast portals/positioners are just
// layout containers. Treating either as blockers hides the native surface unnecessarily.
const NATIVE_BROWSER_NON_OBSCURING_OVERLAY_SELECTOR = [
  "[data-panel-resize-overlay='true']",
  "[data-slot='sheet-backdrop']",
  "[data-slot='sheet-popup']",
  "[data-slot='toast-portal']",
  "[data-slot='toast-portal-anchored']",
  "[data-slot='toast-viewport']",
  "[data-slot='toast-viewport-anchored']",
  "[data-slot='toast-positioner']",
].join(", ");

const NATIVE_BROWSER_OVERLAY_SAMPLE_POINTS = [
  [0.5, 0.5],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.2, 0.8],
  [0.8, 0.8],
] as const;

export interface BrowserWebviewElement extends HTMLElement {
  getWebContentsId?: () => number;
}

export function setBrowserWebviewOverlayOcclusion(
  webview: BrowserWebviewElement | null,
  occluded: boolean,
): void {
  if (!webview) {
    return;
  }
  webview.style.visibility = occluded ? "hidden" : "visible";
  webview.style.pointerEvents = occluded ? "none" : "auto";
}

function isVisibleOverlayElement(element: HTMLElement): boolean {
  const styles = window.getComputedStyle(element);
  if (styles.display === "none" || styles.visibility === "hidden" || styles.opacity === "0") {
    return false;
  }
  return element.getClientRects().length > 0;
}

function isNativeBrowserNonObscuringOverlayElement(element: HTMLElement): boolean {
  return (
    element.closest("[data-slot='toast-popup']") === null &&
    element.closest(NATIVE_BROWSER_NON_OBSCURING_OVERLAY_SELECTOR) !== null
  );
}

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function candidateObscuresNativeBrowser(candidate: HTMLElement, element: HTMLElement): boolean {
  if (candidate === element || candidate.contains(element) || element.contains(candidate)) {
    return false;
  }
  if (!isVisibleOverlayElement(candidate)) {
    return false;
  }

  const elementRect = element.getBoundingClientRect();
  for (const candidateRect of candidate.getClientRects()) {
    if (rectsIntersect(elementRect, candidateRect)) {
      return true;
    }
  }

  return false;
}

function hasTopLayerDomObstruction(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  for (const [xRatio, yRatio] of NATIVE_BROWSER_OVERLAY_SAMPLE_POINTS) {
    const x = rect.left + rect.width * xRatio;
    const y = rect.top + rect.height * yRatio;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      continue;
    }

    for (const hitElement of document.elementsFromPoint(x, y)) {
      if (!(hitElement instanceof HTMLElement)) {
        continue;
      }
      if (hitElement === element || element.contains(hitElement) || hitElement.contains(element)) {
        continue;
      }
      if (isNativeBrowserNonObscuringOverlayElement(hitElement)) {
        continue;
      }
      if (!isVisibleOverlayElement(hitElement)) {
        continue;
      }
      return true;
    }
  }

  return false;
}

export function hasNativeBrowserObscuringOverlay(element: HTMLElement): boolean {
  const candidates = document.querySelectorAll<HTMLElement>(
    NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR,
  );
  for (const candidate of candidates) {
    if (candidateObscuresNativeBrowser(candidate, element)) {
      return true;
    }
  }

  return hasTopLayerDomObstruction(element);
}

function nodeContainsNativeBrowserOverlay(node: Node): boolean {
  return (
    node instanceof Element &&
    (node.matches(NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR) ||
      node.querySelector(NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR) !== null)
  );
}

// React portals do not resize the browser viewport, so their mount/unmount lifecycle must
// explicitly trigger a bounds sync. Filter aggressively to avoid syncing on streamed chat DOM.
export function nativeBrowserOverlayMutationsRequireSync(
  mutations: readonly MutationRecord[],
): boolean {
  return mutations.some((mutation) => {
    if (
      mutation.target instanceof Element &&
      (mutation.target.matches(NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR) ||
        mutation.target.closest(NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR) !== null)
    ) {
      return true;
    }
    if (mutation.type !== "childList") {
      return false;
    }
    return [...mutation.addedNodes, ...mutation.removedNodes].some(
      nodeContainsNativeBrowserOverlay,
    );
  });
}

export function isNativeBrowserTransitionSignalTarget(
  target: EventTarget | null,
  viewportElement: HTMLElement,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (viewportElement.contains(target) || target.contains(viewportElement)) {
    return true;
  }

  return (
    target.closest(NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR) !== null ||
    target.closest("[data-slot='sidebar-container']") !== null ||
    target.closest("[data-slot='sheet-popup']") !== null
  );
}
