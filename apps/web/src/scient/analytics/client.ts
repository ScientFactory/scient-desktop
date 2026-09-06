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
  EnvironmentId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useEffectEvent } from "react";
import * as Option from "effect/Option";

import { runtime } from "../../lib/runtime";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readPreparedConnection, usePreparedConnection } from "../../state/session";
import {
  createAnalyticsClientGate,
  type FinishScientUiOperation,
  type ScientUiOperationKind,
} from "./clientGate";

const gate = createAnalyticsClientGate<PreparedConnection>({
  status: (prepared) => runtime.runPromise(getEnvironmentScientAnalyticsStatus(prepared)),
  record: (prepared, event) =>
    runtime.runPromise(recordEnvironmentScientAnalyticsEvent({ prepared, event })),
});

/** Observe current view after consent discovery, not historical clicks. */
export function useScientAnalyticsView(
  event: ScientAnalyticsUiEvent | null,
  explicitEnvironmentId?: EnvironmentId | null,
) {
  const primary = usePrimaryEnvironmentId();
  const environmentId = explicitEnvironmentId === undefined ? primary : explicitEnvironmentId;
  const prepared = usePreparedConnection(environmentId);
  const key = JSON.stringify(event);
  const read = useEffectEvent(() => (document.visibilityState === "hidden" ? null : event));
  useEffect(() => {
    if (Option.isNone(prepared)) return;
    const observation = gate.observeView(prepared.value, () => read());
    document.addEventListener("visibilitychange", observation.refresh);
    return () => {
      observation.dispose();
      document.removeEventListener("visibilitychange", observation.refresh);
    };
  }, [prepared, key]);
}

export function beginScientUiOperation(
  environmentId: EnvironmentId,
  kind: ScientUiOperationKind,
  trigger: "user" | "agent" | "other" = "user",
): FinishScientUiOperation {
  try {
    const prepared = readPreparedConnection(environmentId);
    return prepared === null ? () => {} : gate.beginOperation(prepared, kind, trigger);
  } catch {
    return () => {};
  }
}

/** Analytics is never allowed to delay or fail the product action being measured. */
export function recordScientAnalytics(
  prepared: PreparedConnection | null,
  event: ScientAnalyticsUiEvent,
): void {
  if (prepared === null) return;
  gate.record(prepared, event);
}

export function useRecordScientAnalytics() {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  useEffect(() => {
    if (Option.isSome(prepared)) gate.prime(prepared.value);
  }, [prepared]);
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
  return gate.readStatus(prepared);
}

export async function setScientAnalyticsConsent(
  prepared: PreparedConnection,
  consent: ScientAnalyticsConsent,
): Promise<ScientAnalyticsStatus> {
  gate.beginControl(prepared);
  try {
    const status = await runtime.runPromise(
      updateEnvironmentScientAnalyticsPreference({ prepared, consent }),
    );
    gate.endControl(prepared, status);
    return status;
  } catch (error) {
    gate.endControl(prepared);
    throw error;
  }
}

export async function deleteScientAnalyticsData(prepared: PreparedConnection): Promise<void> {
  gate.beginControl(prepared);
  try {
    await runtime.runPromise(deleteEnvironmentScientAnalyticsData(prepared));
  } catch (error) {
    gate.endControl(prepared);
    throw error;
  }
  gate.endControl(prepared);
  // A refresh failure must not report that a successful deletion did not happen.
  await gate.readStatus(prepared).catch(() => undefined);
}
