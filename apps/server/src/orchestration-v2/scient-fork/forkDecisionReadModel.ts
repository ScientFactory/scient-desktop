import type { OrchestrationReadModel, OrchestrationThread } from "@t3tools/contracts";

/** Replace a lightweight thread shell with the authoritative fork detail. */
export function withForkOriginDetail(
  readModel: OrchestrationReadModel,
  origin: OrchestrationThread,
): OrchestrationReadModel {
  const originIndex = readModel.threads.findIndex((thread) => thread.id === origin.id);
  if (originIndex < 0) {
    return { ...readModel, threads: [...readModel.threads, origin] };
  }
  return {
    ...readModel,
    threads: readModel.threads.map((thread, index) => (index === originIndex ? origin : thread)),
  };
}
