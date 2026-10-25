import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  observeProviderSignInSnapshots,
  setProviderSignInPageClaimer,
  useProviderSignInPageClaimerReady,
} from "./providerSignInFlow";
import { usePendingProviderSignInKeys } from "./providerSignInRequests";
import { claimProviderSignInPage } from "./providerSignInCommands";

/**
 * Watch pending sign-ins at app scope so lost replies or unmounted setup views cannot lose their
 * page. Observe only environments with starts owned by this window and a registered claim command.
 */
export function ProviderSignInPageCoordinator() {
  const claim = useAtomCommand(claimProviderSignInPage, {
    reportFailure: false,
  });
  useEffect(() => {
    setProviderSignInPageClaimer(async (environmentId, input) => {
      const result = await claim({ environmentId, input });
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    });
    return () => setProviderSignInPageClaimer(null);
  }, [claim]);
  const keys = usePendingProviderSignInKeys();
  // Observers mount after the command is registered, so their first snapshot can claim.
  const ready = useProviderSignInPageClaimerReady();
  const environmentIds = ready ? [...new Set(keys.map((key) => key.environmentId))] : [];
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
