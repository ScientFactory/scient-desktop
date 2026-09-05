import type { AppRouter } from "../router";

/** Warm code only: no route loaders, draft creation, or environment requests. */
export function preloadProjectChat(
  router: Pick<AppRouter, "loadRouteChunk"> & {
    routesById: Record<
      "/_chat/draft/$draftId" | "/_chat/$environmentId/$threadId",
      Parameters<AppRouter["loadRouteChunk"]>[0]
    >;
  },
) {
  return Promise.all([
    router.loadRouteChunk(router.routesById["/_chat/draft/$draftId"]),
    router.loadRouteChunk(router.routesById["/_chat/$environmentId/$threadId"]),
  ]);
}
