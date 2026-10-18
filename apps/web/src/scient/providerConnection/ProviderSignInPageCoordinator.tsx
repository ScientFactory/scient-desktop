import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { serverEnvironment } from "../../state/server";
import {
  observeProviderSignInSnapshots,
  usePendingProviderSignInKeys,
} from "./providerSignInBrowser";

/**
 * Mounted once for the app. Watches the provider snapshots of each environment
 * in which this client is starting a sign-in, so its page opens even when the
 * start reply is lost or the view that started it is gone. Nothing is observed
 * while no sign-in started here is pending.
 */
export function ProviderSignInPageCoordinator() {
  const keys = usePendingProviderSignInKeys();
  const environmentIds = [...new Set(keys.map((key) => key.environmentId))];
  return (
    <>
      {environmentIds.map((environmentId) => (
        <EnvironmentSignInObserver environmentId={environmentId} key={environmentId} />
      ))}
    </>
  );
}

function EnvironmentSignInObserver(props: { readonly environmentId: EnvironmentId }) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  useEffect(() => {
    if (providers) observeProviderSignInSnapshots(props.environmentId, providers);
  }, [props.environmentId, providers]);
  return null;
}
