import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { ProviderFullAppLabHost } from "./scient/providerConnection/lab/ProviderFullAppLabHost";
import { PROVIDER_LAB_ENABLED } from "./scient/providerConnection/lab/providerLabState";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  if (PROVIDER_LAB_ENABLED) {
    return (
      <AppAtomRegistryProvider>
        <ProviderFullAppLabHost>
          <RouterProvider router={router} />
          <PreviewAutomationHosts />
          <ElectronBrowserHost />
        </ProviderFullAppLabHost>
      </AppAtomRegistryProvider>
    );
  }

  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
    </AppAtomRegistryProvider>
  );
}
