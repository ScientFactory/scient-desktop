import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  deleteEnvironmentScientAnalyticsData,
  getEnvironmentScientAnalyticsStatus,
  recordEnvironmentScientAnalyticsEvent,
  updateEnvironmentScientAnalyticsPreference,
} from "@t3tools/client-runtime/state/scient-analytics";
import type {
  ScientAnalyticsConsent,
  ScientAnalyticsStatus,
  ScientAnalyticsUiEvent,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { runtime } from "../../lib/runtime";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readPreparedConnection } from "../../state/session";

const openedSurfaces = new Set<string>();

/** Analytics is never allowed to delay or fail the product action being measured. */
export function recordScientAnalytics(
  prepared: PreparedConnection | null,
  event: ScientAnalyticsUiEvent,
): void {
  if (prepared === null) return;
  if (event.name === "surface.opened") {
    const surface = event.properties.surface;
    if (typeof surface === "string") {
      if (openedSurfaces.has(surface)) return;
      openedSurfaces.add(surface);
    }
  }
  void runtime
    .runPromise(recordEnvironmentScientAnalyticsEvent({ prepared, event }))
    .catch(() => undefined);
}

export function useRecordScientAnalytics() {
  const environmentId = usePrimaryEnvironmentId();
  return useCallback(
    (event: ScientAnalyticsUiEvent) => {
      recordScientAnalytics(
        environmentId === null ? null : readPreparedConnection(environmentId),
        event,
      );
    },
    [environmentId],
  );
}

export function readScientAnalyticsStatus(
  prepared: PreparedConnection,
): Promise<ScientAnalyticsStatus> {
  return runtime.runPromise(getEnvironmentScientAnalyticsStatus(prepared));
}

export function setScientAnalyticsConsent(
  prepared: PreparedConnection,
  consent: ScientAnalyticsConsent,
): Promise<ScientAnalyticsStatus> {
  return runtime.runPromise(updateEnvironmentScientAnalyticsPreference({ prepared, consent }));
}

export async function deleteScientAnalyticsData(prepared: PreparedConnection): Promise<void> {
  await runtime.runPromise(deleteEnvironmentScientAnalyticsData(prepared));
}
