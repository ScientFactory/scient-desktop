export interface PlotlyMountQueue {
  readonly enqueue: (mount: () => Promise<void>) => Promise<void>;
}

/**
 * Plotly mutates its graph div while mounting and purging. Keeping those
 * operations serial prevents a stale async mount from tearing down its
 * replacement during React Strict Mode remounts.
 */
export function createPlotlyMountQueue(): PlotlyMountQueue {
  let tail = Promise.resolve();

  return {
    enqueue(mount) {
      const operation = tail.then(mount);
      tail = operation.catch(() => undefined);
      return operation;
    },
  };
}

/** All Plotly graph divs share one mutation lane, especially mount/purge. */
export const plotlyMountQueue = createPlotlyMountQueue();
