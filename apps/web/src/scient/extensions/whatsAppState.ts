import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  WS_METHODS,
  type WhatsAppLinkState,
  type WhatsAppStatus,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentSubscription } from "../../state/query";

/** The environment's WhatsApp link: its current status first, then every change. */
const whatsAppStatus = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:whatsapp:status",
  tag: WS_METHODS.whatsappSubscribeStatus,
});

const perEnvironment = {
  mode: "serial",
  key: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    `whatsapp:${environmentId}`,
} as const;

export const startWhatsAppLink = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:whatsapp:start-link",
  tag: WS_METHODS.whatsappStartLink,
  concurrency: perEnvironment,
});

export const cancelWhatsAppLink = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:whatsapp:cancel-link",
  tag: WS_METHODS.whatsappCancelLink,
  concurrency: perEnvironment,
});

export const unlinkWhatsApp = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:whatsapp:unlink",
  tag: WS_METHODS.whatsappUnlink,
  concurrency: perEnvironment,
});

/** The live status, or null until the server's first answer, with why it cannot answer. */
export function useWhatsAppStatus(environmentId: EnvironmentId | null): {
  readonly status: WhatsAppStatus | null;
  readonly error: string | null;
} {
  const view = useEnvironmentSubscription(
    environmentId === null ? null : whatsAppStatus({ environmentId, input: {} }),
  );
  return { status: view.data, error: view.error };
}

export function isWhatsAppInstalled(state: WhatsAppLinkState | undefined): boolean {
  return (
    state?._tag === "Linked" ||
    state?._tag === "Restricted" ||
    state?._tag === "Installing" ||
    state?._tag === "AwaitingScan" ||
    state?._tag === "Syncing"
  );
}
