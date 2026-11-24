import type { ConnectorId, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useState, type KeyboardEvent } from "react";

import { InlineButton } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { extensionsInventory, startConnectorSignIn } from "./extensionsState";
import { callbackOriginOf } from "./extensionsView";
import { openAuthorizationPage } from "./openAuthorizationPage";

const stopRowToggle = (event: KeyboardEvent<HTMLElement>) => event.stopPropagation();

const CONNECTOR_LOOKUP_TOOL = /(?:^|[_.\s·/])scient_connector_check$/u;

/** The connector a Scient lookup or check named, under every provider's tool spelling. */
export function connectorRecoveryTarget(toolName: string | null, input: unknown): string | null {
  if (toolName === null || !CONNECTOR_LOOKUP_TOOL.test(toolName)) return null;
  if (typeof input !== "object" || input === null || !("connector" in input)) return null;
  const raw = (input as { readonly connector?: unknown }).connector;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Starts a Scient connector's own sign-in and opens its page; falls back to Settings when blocked. */
export function ConnectorSignInButton({
  environmentId,
  connectorId,
  displayName,
}: {
  readonly environmentId: EnvironmentId;
  readonly connectorId: ConnectorId;
  readonly displayName: string;
}) {
  const gt = useGT();
  const canSignIn = useAtomValue(startConnectorSignIn.permissionAtom(environmentId));
  const callbackOrigin = callbackOriginOf(useEnvironmentHttpBaseUrl(environmentId));
  const runSignIn = useAtomCommand(startConnectorSignIn, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  if (!canSignIn || callbackOrigin === null) return null;

  const signIn = async () => {
    setBusy(true);
    const opening = await openAuthorizationPage(async () => {
      const result = await runSignIn({ environmentId, input: { connectorId, callbackOrigin } });
      if (result._tag === "Success") return result.value.authorizationUrl;
      toastManager.add({
        type: "error",
        title: gt("Couldn't start sign-in"),
        description: formatEnvironmentQueryError(result.cause),
      });
      return null;
    }).finally(() => setBusy(false));
    if (opening.outcome === "blocked") {
      toastManager.add({
        type: "warning",
        title: gt("Open Settings → Extensions to finish signing in to {name}", {
          name: displayName,
        }),
      });
    }
  };

  return (
    <InlineButton
      aria-label={gt("Sign in to {name}", { name: displayName })}
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        void signIn();
      }}
      onKeyDown={stopRowToggle}
    >
      {busy ? <T>Opening…</T> : <T>Sign in</T>}
    </InlineButton>
  );
}

/** Opens the machine's installed connectors, where keys and availability are changed. */
export function ManageConnectorsLink({ environmentId }: { readonly environmentId: EnvironmentId }) {
  return (
    <Link
      to="/settings/extensions/installed"
      search={{ machine: environmentId }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={stopRowToggle}
      className="shrink-0 text-xs text-primary underline-offset-2 hover:underline"
    >
      <T>Manage</T>
    </Link>
  );
}

/**
 * Recovery for an attributable Scient connector lookup or check row, resolved against the
 * server's own inventory rather than the tool's output.
 */
export function ConnectorRecoveryAction({
  environmentId,
  connectorName,
}: {
  readonly environmentId: EnvironmentId;
  readonly connectorName: string;
}) {
  const inventory = useEnvironmentQuery(extensionsInventory({ environmentId, input: {} })).data;
  const needle = connectorName.toLowerCase();
  const connector =
    inventory?.connectors.find((item) => item.serverName.toLowerCase() === needle) ??
    inventory?.connectors.find((item) => item.displayName.toLowerCase() === needle);
  if (!connector) return null;
  if (connector.enabled && connector.status === "needs-auth" && connector.auth.type === "oauth") {
    return (
      <ConnectorSignInButton
        environmentId={environmentId}
        connectorId={connector.connectorId}
        displayName={connector.displayName}
      />
    );
  }
  if (!connector.enabled || connector.status === "needs-credential") {
    return <ManageConnectorsLink environmentId={environmentId} />;
  }
  return null;
}
