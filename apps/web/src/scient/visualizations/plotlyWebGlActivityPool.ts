// Plotly may allocate multiple contexts for one graph. Two live figures leave
// headroom for Chromium's compositor and other scientific render surfaces.
export const MAX_ACTIVE_PLOTLY_WEBGL_FIGURES = 2;

interface PlotlyWebGlActivityLease {
  readonly activate: () => void;
  active: boolean;
  readonly deactivate: () => void;
  nearViewport: boolean;
  requestedAt: number;
}

export interface PlotlyWebGlActivityRegistration {
  readonly setNearViewport: (nearViewport: boolean) => void;
  readonly unregister: () => void;
}

export interface PlotlyWebGlActivityPool {
  readonly register: (callbacks: {
    readonly activate: () => void;
    readonly deactivate: () => void;
  }) => PlotlyWebGlActivityRegistration;
}

/**
 * Plotly WebGL figures can consume multiple browser contexts each. Keep a
 * small, most-recently-visible working set so long scientific conversations do
 * not exhaust Chromium's per-document context budget.
 */
export function createPlotlyWebGlActivityPool(
  capacity = MAX_ACTIVE_PLOTLY_WEBGL_FIGURES,
): PlotlyWebGlActivityPool {
  const leases = new Set<PlotlyWebGlActivityLease>();
  let requestClock = 0;

  const reconcile = () => {
    const desired = new Set(
      [...leases]
        .filter((lease) => lease.nearViewport)
        .sort((left, right) => right.requestedAt - left.requestedAt)
        .slice(0, capacity),
    );

    // Release first. React runs the corresponding Plotly cleanup before a new
    // card's delayed mount starts on the next animation frame.
    for (const lease of leases) {
      if (!lease.active || desired.has(lease)) continue;
      lease.active = false;
      lease.deactivate();
    }
    for (const lease of desired) {
      if (lease.active) continue;
      lease.active = true;
      lease.activate();
    }
  };

  return {
    register(callbacks) {
      const lease: PlotlyWebGlActivityLease = {
        activate: callbacks.activate,
        active: false,
        deactivate: callbacks.deactivate,
        nearViewport: false,
        requestedAt: 0,
      };
      leases.add(lease);

      return {
        setNearViewport(nearViewport) {
          if (lease.nearViewport === nearViewport) return;
          lease.nearViewport = nearViewport;
          if (nearViewport) lease.requestedAt = ++requestClock;
          reconcile();
        },
        unregister() {
          if (!leases.delete(lease)) return;
          if (lease.active) callbacks.deactivate();
          reconcile();
        },
      };
    },
  };
}

export const plotlyWebGlActivityPool = createPlotlyWebGlActivityPool();
