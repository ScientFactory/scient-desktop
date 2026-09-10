import type { OrchestrationShellSnapshot } from "@t3tools/contracts";
import { create } from "zustand";
import { completedAnswer } from "./completion";

const STORAGE_KEY = "scient:answer-attention-baselines:v1";
function readBaselines(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && Number.isFinite(Date.parse(entry[1])),
        ),
      );
    }
  } catch {
    /* Restricted or corrupt storage falls back to this session. */
  }
  return {};
}

// Hydrate before live connection: cached offline answers still need their adoption boundary.
export const useAnswerBaselines = create<{ byEnvironment: Readonly<Record<string, string>> }>(
  () => ({ byEnvironment: readBaselines() }),
);

/** Server timestamps avoid client clock skew; the first live snapshot is the adoption boundary. */
export function snapshotBaseline(snapshot: OrchestrationShellSnapshot): string {
  return [
    snapshot.updatedAt,
    ...snapshot.threads.map((thread) => completedAnswer(thread)?.completedAt),
  ]
    .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)))
    .reduce(
      (latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest),
      "1970-01-01T00:00:00.000Z",
    );
}

export function getOrCreateBaseline(
  environmentId: string,
  snapshot: OrchestrationShellSnapshot,
): string {
  const cached = useAnswerBaselines.getState().byEnvironment[environmentId];
  if (typeof cached === "string") return cached;
  const baseline = snapshotBaseline(snapshot);
  useAnswerBaselines.setState((state) => ({
    byEnvironment: { ...state.byEnvironment, [environmentId]: baseline },
  }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useAnswerBaselines.getState().byEnvironment));
  } catch {
    /* Private/restricted storage must not break the conversation. */
  }
  return baseline;
}
