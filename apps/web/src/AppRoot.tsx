import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { subscribeComposerDraftModelReconciliation } from "./composerDraftStore";
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";

import { BrowserProfileReporter } from "./browser/BrowserProfileReporter";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { appAtomRegistry, AppAtomRegistryProvider } from "./rpc/atomRegistry";
// SCIENT-FORK:START — the document lifecycle uses its independent host rail.
import { HtmlPdfLifecycleHost } from "./scient/documentExport/HtmlPdfLifecycleHost";
// SCIENT-FORK:END
// SCIENT-FORK:START — one tooltip timing for the whole app. Base UI's provider is
// imported directly, which keeps this root module's imports as light as upstream's.
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
// SCIENT-FORK:END
import type { AppRouter } from "./router";

/**
 * The Electron browser host intentionally sits outside the router so its
 * webviews survive route transitions, but it must share the same atom registry
 * as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  useEffect(
    () =>
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
      }),
    [],
  );
  return (
    <AppAtomRegistryProvider>
      {/* SCIENT-FORK:START — tooltips open after 0.1s, and at once while moving between
          controls; a place that sets its own timing keeps it. Upstream's children are
          indented one level inside the provider. */}
      <TooltipPrimitive.Provider delay={100} closeDelay={0} timeout={400}>
        <RouterProvider router={router} />
        <HtmlPdfLifecycleHost />
        <ElectronBrowserHost />
        <BrowserProfileReporter />
        <QuitHoldOverlay />
      </TooltipPrimitive.Provider>
      {/* SCIENT-FORK:END */}
    </AppAtomRegistryProvider>
  );
}
