import type { ScientAnalyticsStatus, ScientAnalyticsUiEvent } from "@t3tools/contracts";

const UNAVAILABLE: ScientAnalyticsStatus = { available: false, consent: "off" };
const MAX_IN_FLIGHT = 20;
const STATUS_MAX_AGE_MS = 60_000;

export type ScientUiOperationKind = "pdf-export" | "document-export" | "latex-visual-edit";
export type ScientUiOperationOutcome = "completed" | "failed" | "cancelled" | null;
export type FinishScientUiOperation = (outcome: ScientUiOperationOutcome) => void;
const ignoreOperation: FinishScientUiOperation = () => {};
type RecordVoiceAnalytics = (event: ScientAnalyticsUiEvent) => void;
const ignoreVoice: RecordVoiceAnalytics = () => {};

/** Best-effort UI signals: no replay before consent, no timer/polling, bounded work. */
export function createAnalyticsClientGate<Connection extends object>(transport: {
  readonly status: (connection: Connection) => Promise<ScientAnalyticsStatus>;
  readonly record: (connection: Connection, event: ScientAnalyticsUiEvent) => Promise<unknown>;
  readonly now?: () => number;
}) {
  type State = {
    status: ScientAnalyticsStatus | null;
    checkedAt: number;
    retryStatusAt: number | null;
    loading: boolean;
    generation: number;
    inFlight: number;
    surfaces: Set<string>;
    views: Set<() => void>;
  };
  const states = new WeakMap<Connection, State>();
  const now = transport.now ?? Date.now;
  const stateFor = (connection: Connection) => {
    let state = states.get(connection);
    if (!state) {
      state = {
        status: null,
        checkedAt: 0,
        retryStatusAt: null,
        loading: false,
        generation: 0,
        inFlight: 0,
        surfaces: new Set(),
        views: new Set(),
      };
      states.set(connection, state);
    }
    return state;
  };
  const acceptStatus = (state: State, status: ScientAnalyticsStatus) => {
    if (
      state.status?.consent !== status.consent ||
      state.status?.available !== status.available ||
      state.status?.collectionContext !== status.collectionContext
    ) {
      state.generation += 1;
      state.surfaces.clear();
    }
    state.status = status;
    state.checkedAt = now();
    state.retryStatusAt = null;
    for (const view of state.views) view();
  };
  const readStatus = async (connection: Connection) => {
    const state = stateFor(connection);
    const generation = state.generation;
    try {
      const status = await transport.status(connection);
      if (generation === state.generation) acceptStatus(state, status);
      return status;
    } catch (error) {
      if (generation === state.generation) {
        acceptStatus(state, UNAVAILABLE);
        // A transient discovery failure is not a durable Off preference. Retry
        // only on later activity, at most once a minute; never replay that work.
        state.retryStatusAt = now() + STATUS_MAX_AGE_MS;
      }
      throw error;
    }
  };
  const prime = (connection: Connection) => {
    const state = stateFor(connection);
    if (state.loading) return;
    state.loading = true;
    void readStatus(connection)
      .catch(() => undefined)
      .finally(() => {
        state.loading = false;
      });
  };
  const refreshIfNeeded = (connection: Connection, state: State) => {
    if (
      state.status === null ||
      (state.retryStatusAt !== null && now() >= state.retryStatusAt) ||
      (state.status.available &&
        state.status.consent !== "off" &&
        now() - state.checkedAt >= STATUS_MAX_AGE_MS)
    ) {
      prime(connection);
      return true;
    }
    return false;
  };
  const readyState = (connection: Connection) => {
    const state = stateFor(connection);
    // Discovery never buffers the triggering action or blocks product work.
    if (refreshIfNeeded(connection, state)) return null;
    return state.status?.available && state.status.consent !== "off" ? state : null;
  };
  const enqueue = (connection: Connection, state: State, event: ScientAnalyticsUiEvent) => {
    if (
      !state.status?.available ||
      state.status.consent === "off" ||
      state.inFlight >= MAX_IN_FLIGHT
    )
      return false;
    if (
      state.status.consent === "essential" &&
      event.name !== "project.add.failed" &&
      event.name !== "voice.transcription.failed" &&
      event.name !== "voice.recording.failed" &&
      event.name !== "scient.operation.failed"
    )
      return false;
    if (event.name === "surface.opened") {
      const surface = event.properties.surface;
      if (typeof surface !== "string" || state.surfaces.has(surface) || state.surfaces.size >= 64)
        return false;
      state.surfaces.add(surface);
    }
    state.inFlight += 1;
    const generation = state.generation;
    // Defer even a synchronously throwing transport off the product call stack.
    void Promise.resolve()
      .then(() => {
        if (generation === state.generation) return transport.record(connection, event);
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        state.inFlight -= 1;
      });
    return true;
  };
  return {
    observeView(connection: Connection, read: () => ScientAnalyticsUiEvent | null) {
      const state = stateFor(connection);
      let reportedContext: string | undefined;
      let disposed = false;
      const refresh = () => {
        if (disposed) return;
        const event = read();
        if (event === null) {
          reportedContext = undefined;
          return;
        }
        const ready = readyState(connection);
        const context = ready?.status?.collectionContext;
        if (
          ready &&
          context !== undefined &&
          reportedContext !== context &&
          enqueue(connection, ready, { ...event, collectionContext: context })
        )
          reportedContext = context;
      };
      // Only current visible state is read after discovery; never replay an
      // action or a screen the user has already left. Bound retained observers.
      if (state.views.size >= 16) return { refresh: () => {}, dispose: () => {} };
      state.views.add(refresh);
      void Promise.resolve().then(refresh);
      return {
        refresh,
        dispose: () => {
          disposed = true;
          state.views.delete(refresh);
        },
      };
    },
    readStatus,
    prime(connection: Connection) {
      if (stateFor(connection).status === null) prime(connection);
    },
    record(connection: Connection, event: ScientAnalyticsUiEvent) {
      if (event.name.startsWith("voice.recording.")) {
        const state = stateFor(connection);
        refreshIfNeeded(connection, state);
        if (
          state.status?.voiceLifecycleVersion === 2 &&
          state.status.collectionContext !== undefined
        )
          enqueue(connection, state, {
            ...event,
            collectionContext: state.status.collectionContext,
          });
        return;
      }
      const state = readyState(connection);
      if (state) enqueue(connection, state, event);
    },
    beginVoiceOperation(connection: Connection): RecordVoiceAnalytics {
      const state = stateFor(connection);
      // Refresh on new work so a restarted server does not leave voice using an
      // obsolete context forever. Keep a verified context usable during refresh.
      refreshIfNeeded(connection, state);
      const collectionContext = state.status?.collectionContext;
      // An already verified context is checked authoritatively by the server on every
      // event. Its cache age must not split a job. Unknown/Off work is never replayed.
      if (
        !state.status?.available ||
        state.status.consent === "off" ||
        state.status.voiceLifecycleVersion !== 2 ||
        collectionContext === undefined
      ) {
        return ignoreVoice;
      }
      const generation = state.generation;
      let started = false;
      let finished = false;
      return (event) => {
        if (
          finished ||
          generation !== state.generation ||
          !event.name.startsWith("voice.transcription.")
        )
          return;
        if (event.name === "voice.transcription.started") {
          if (started) return;
          started = enqueue(connection, state, { ...event, collectionContext });
          if (!started && state.status?.consent !== "essential") finished = true;
          return;
        }
        if (
          ![
            "voice.transcription.completed",
            "voice.transcription.failed",
            "voice.transcription.cancelled",
          ].includes(event.name)
        )
          return;
        if (!started && state.status?.consent !== "essential") return;
        finished = true;
        enqueue(connection, state, { ...event, collectionContext });
      };
    },
    beginOperation(
      connection: Connection,
      operationKind: ScientUiOperationKind,
      trigger: "user" | "agent" | "other" = "user",
    ): FinishScientUiOperation {
      const state = readyState(connection);
      const collectionContext = state?.status?.collectionContext;
      // Older servers cannot fence an in-flight operation across consent changes.
      if (!state || collectionContext === undefined) return ignoreOperation;
      const generation = state.generation;
      const startedAt = now();
      const started = enqueue(connection, state, {
        name: "scient.operation.started",
        properties: { operationKind, trigger },
        collectionContext,
      });
      if (!started && state.status?.consent !== "essential") return ignoreOperation;
      let finished = false;
      return (outcome) => {
        if (finished) return;
        finished = true;
        if (outcome === null || generation !== state.generation) return;
        // No refresh at completion: long operations must not lose their outcome
        // merely because 60 seconds elapsed. The server validates the context.
        enqueue(connection, state, {
          name: `scient.operation.${outcome}`,
          properties: {
            operationKind,
            trigger,
            durationMs: now() - startedAt,
            failureClass: "unknown",
          },
          collectionContext,
        });
      };
    },
  };
}
