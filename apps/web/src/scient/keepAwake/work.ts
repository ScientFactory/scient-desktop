import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";
import {
  ORCHESTRATION_V2_WS_METHODS,
  KEEP_AWAKE_LEASE_MS,
  keepAwakeThreadKey,
  type ThreadId,
  type KeepAwakeObservation,
} from "@t3tools/contracts";
import {
  deriveKeepAwakeWork,
  hasKeepAwakeShellWork,
  keepAwakeProgressToken,
} from "@t3tools/shared/scientKeepAwake";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentThreadShells } from "../../state/threads";
import { keepAwakeStateAtom } from "./state";

const workQuery = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "desktop:keep-awake-work",
  refreshIntervalMs: 15_000,
  staleTimeMs: 0,
  idleTtlMs: 0,
  execute: (input: { threadId: ThreadId }) =>
    request(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
      ...input,
      includeKeepAwakeHealth: true,
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.map((projection) => ({
        ...deriveKeepAwakeWork(projection),
        health: projection.keepAwakeHealth ?? "unknown",
        progressToken: keepAwakeProgressToken(projection),
        threadId: projection.thread.id,
        observedAt: Date.now(),
        title: projection.thread.title,
      })),
    ),
  refreshTrigger: ({ environmentId, input }) =>
    Atom.make((get) => {
      const shell = get(environmentThreadShells.environmentThreadsAtom(environmentId)).find(
        (thread) => thread.id === input.threadId,
      );
      return JSON.stringify([
        shell?.status,
        shell?.activeRunId,
        shell?.latestRunId,
        shell?.pendingRuntimeRequest,
        shell?.pendingBackgroundTasks,
      ]);
    }),
});

export const keepAwakeObservationsAtom = Atom.make((get): readonly KeepAwakeObservation[] => {
  const previous = Option.getOrUndefined(get.self<readonly KeepAwakeObservation[]>());
  const settings = get(keepAwakeStateAtom);
  if (!settings) return [];
  const observations: KeepAwakeObservation[] = [];
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const shells = get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const byId = new Map(shells.map((shell) => [shell.id, shell]));
    const saved = new Map(settings.threads.map((thread) => [thread.key, thread]));
    const candidates = shells.filter((shell) => {
      const record = saved.get(keepAwakeThreadKey(environmentId, shell.id));
      return (
        record?.once ||
        record?.startedAt != null ||
        (hasKeepAwakeShellWork(shell) && settings.settings.mode === "running")
      );
    });
    const candidateIds = new Set(candidates.map((shell) => shell.id));
    const roots = candidates.filter((shell) => {
      const record = saved.get(keepAwakeThreadKey(environmentId, shell.id));
      if (record?.once || record?.startedAt != null) return true;
      let current = shell;
      const visited = new Set<ThreadId>([shell.id]);
      while (
        current.lineage.relationshipToParent === "subagent" &&
        current.lineage.parentThreadId !== null
      ) {
        const parent = byId.get(current.lineage.parentThreadId);
        if (!parent || visited.has(parent.id)) break;
        if (candidateIds.has(parent.id)) return false;
        visited.add(parent.id);
        current = parent;
      }
      return true;
    });
    for (const root of roots) {
      const members = shells.filter((shell) => {
        if (shell.id !== root.id && !hasKeepAwakeShellWork(shell)) return false;
        let current = shell;
        const visited = new Set<ThreadId>();
        while (!visited.has(current.id)) {
          if (current.id === root.id) return true;
          visited.add(current.id);
          if (
            current.lineage.relationshipToParent !== "subagent" ||
            current.lineage.parentThreadId === null
          )
            return false;
          const parent = byId.get(current.lineage.parentThreadId);
          if (!parent) return false;
          current = parent;
        }
        return false;
      });
      const states = members.map((shell) =>
        Option.getOrNull(
          AsyncResult.value(
            get(
              workQuery({
                environmentId,
                input: { threadId: shell.id },
              }),
            ),
          ),
        ),
      );
      const now = Date.now();
      const known = states
        .filter((state) => state !== null)
        .filter((state) => state.observedAt + KEEP_AWAKE_LEASE_MS > now);
      const unknown = known.length !== states.length;
      // An unavailable child cannot prove completion or invalidate fresh evidence
      // that its parent is still doing work.
      if (unknown && !known.some((state) => state.needsAwakeWithoutChildren)) continue;
      const knownIds = new Set(known.map((state) => state.threadId));
      const unfinished = unknown || known.some((state) => state.unfinished);
      const needsAwake = known.some(
        (state) =>
          state.needsAwakeWithoutChildren || state.childThreadIds.some((id) => !knownIds.has(id)),
      );
      observations.push({
        key: keepAwakeThreadKey(environmentId, root.id),
        title: root.title,
        observedAt: Math.min(...known.map((state) => state.observedAt)),
        latestRunId: known.find((state) => state.threadId === root.id)?.latestRunId,
        unfinished,
        needsAwake,
        execution: known.flatMap((state) => [
          {
            key: keepAwakeThreadKey(environmentId, state.threadId),
            progressToken: state.progressToken,
            health: state.health,
            needsAwake: state.needsAwakeWithoutChildren,
          },
          ...state.childThreadIds
            .filter((id) => !knownIds.has(id))
            .map((id) => ({
              key: keepAwakeThreadKey(environmentId, id),
              progressToken: "unresolved-child",
              health: "unknown" as const,
              needsAwake: true,
            })),
        ]),
        reason:
          known.find((state) => state.needsAwake)?.reason ??
          known.find((state) => state.unfinished)?.reason ??
          "Work finished",
      });
    }
    // A confirmed removal from the shell is not enough to clear a saved session:
    // reconnecting and paging can temporarily hide threads. Its lease still expires.
  }
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(observations)
    ? previous
    : observations;
}).pipe(Atom.withLabel("desktop:keep-awake-observations"));
