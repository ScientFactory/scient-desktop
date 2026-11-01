import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
// SCIENT-FORK:START — the document lifecycle uses its independent host rail.
import { HtmlPdfLifecycleHost } from "./scient/documentExport/HtmlPdfLifecycleHost";
// SCIENT-FORK:END
// SCIENT-FORK:START — every window answers the server's editor flush requests.
import { EditorFlushHosts } from "./scient/editorFlush/EditorFlushHosts";
// SCIENT-FORK:END
import type { AppRouter } from "./router";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <HtmlPdfLifecycleHost />
      {/* SCIENT-FORK:START — every window answers the server's editor flush requests. */}
      <EditorFlushHosts />
      {/* SCIENT-FORK:END */}
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
