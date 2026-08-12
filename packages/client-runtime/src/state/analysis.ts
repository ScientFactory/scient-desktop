import { WS_METHODS } from "@t3tools/contracts";
import type { AnalysisRunSnapshot, AnalysisRunStreamEvent } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function applyAnalysisRunStreamEvent(
  runs: ReadonlyMap<string, AnalysisRunSnapshot>,
  event: AnalysisRunStreamEvent,
): ReadonlyMap<string, AnalysisRunSnapshot> {
  const next = new Map(runs);
  if (event._tag === "run-snapshot") {
    next.set(event.run.receipt.runId, event.run);
    return next;
  }
  if (event._tag === "run-updated") {
    const current = next.get(event.run.receipt.runId);
    next.set(event.run.receipt.runId, {
      ...event.run,
      receipt: {
        ...event.run.receipt,
        output: current?.receipt.output ?? [],
      },
    });
    return next;
  }
  const current = next.get(event.runId);
  if (!current) return next;
  const knownSequences = new Set(current.receipt.output.map((chunk) => chunk.sequence));
  next.set(event.runId, {
    ...current,
    receipt: {
      ...current.receipt,
      output: [
        ...current.receipt.output,
        ...event.chunks.filter((chunk) => !knownSequences.has(chunk.sequence)),
      ].toSorted((left, right) => left.sequence - right.sequence),
      outputTruncated: event.outputTruncated,
      outputByteLength: event.outputByteLength,
    },
  });
  return next;
}

export function createAnalysisEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const runScheduler = createAtomCommandScheduler();
  const runtimeScheduler = createAtomCommandScheduler();
  return {
    runtimes: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:analysis:runtimes",
      tag: WS_METHODS.analysisInspectRuntimes,
      staleTimeMs: 15_000,
    }),
    runs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:analysis:runs",
      tag: WS_METHODS.analysisListRuns,
      staleTimeMs: 5_000,
    }),
    run: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:analysis:run",
      tag: WS_METHODS.analysisGetRun,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    runEvents: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:analysis:run-events",
      tag: WS_METHODS.subscribeAnalysisRuns,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(new Map<string, AnalysisRunSnapshot>(), applyAnalysisRunStreamEvent),
          Stream.map((runs) =>
            [...runs.values()].toSorted((left, right) =>
              right.receipt.startedAt.localeCompare(left.receipt.startedAt),
            ),
          ),
        ),
    }),
    configureRuntime: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:analysis:configure-runtime",
      tag: WS_METHODS.analysisConfigureRuntime,
      scheduler: runtimeScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.runtimeKind]),
      },
    }),
    startRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:analysis:start-run",
      tag: WS_METHODS.analysisStartRun,
      scheduler: runScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
    cancelRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:analysis:cancel-run",
      tag: WS_METHODS.analysisCancelRun,
      scheduler: runScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.runId]),
      },
    }),
  };
}
