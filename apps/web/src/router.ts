import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import { StoreProvider } from "./store";
import {
  coordinateExternalRouteNavigation,
  draftNavigationSlotKey,
} from "./lib/stagedDraftNavigation";

type RouterHistory = NonNullable<Parameters<typeof createRouter>[0]["history"]>;

export function getRouter(history: RouterHistory) {
  const queryClient = new QueryClient();

  history.block({
    enableBeforeUnload: false,
    blockerFn: async ({ nextLocation }) => {
      const ownedRouteToken = (
        nextLocation.state as unknown as { readonly __scientDraftNavigationToken?: unknown }
      ).__scientDraftNavigationToken;
      const mayCommit = await coordinateExternalRouteNavigation(
        draftNavigationSlotKey(),
        typeof ownedRouteToken === "string" ? ownedRouteToken : undefined,
      );
      return !mayCommit;
    },
  });

  const router = createRouter({
    routeTree,
    history,
    // Routes are auto-code-split and have no loaders, so intent preloading only
    // fetches the route chunk on link hover/touch — first navigation skips the
    // chunk download/parse wait.
    defaultPreload: "intent",
    context: {
      queryClient,
    },
    Wrap: ({ children }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(StoreProvider, null, children),
      ),
  });
  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
