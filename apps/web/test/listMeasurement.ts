import type { LegendListRef } from "@legendapp/list/react";
import { waitForTestReceipt } from "./receipt";

/**
 * Resolves once the list holds `rowId` at its rendered height. Legend learns a
 * row's new size from a ResizeObserver, which runs in the browser's rendering
 * steps; the fake clock does not drive those, so playing frames alone can
 * outrun it on a busy machine.
 */
export async function waitForMeasuredRow(list: LegendListRef, rowId: string, signal: AbortSignal) {
  const measured = Promise.withResolvers<void>();
  const check = () => {
    const state = list.getState();
    const index = state.indexByKey(rowId);
    if (index === undefined) return;
    const element = state.elementAtIndex(index);
    const size = state.sizeAtIndex(index);
    if (
      element instanceof HTMLElement &&
      size !== undefined &&
      Math.abs(size - element.getBoundingClientRect().height) <= 0.5
    )
      measured.resolve();
  };
  const stopSize = list.getState().listen("totalSize", check);
  const stopPosition = list.getState().listen("lastPositionUpdate", check);
  try {
    check();
    await waitForTestReceipt(signal, measured.promise);
  } finally {
    stopSize();
    stopPosition();
  }
}
