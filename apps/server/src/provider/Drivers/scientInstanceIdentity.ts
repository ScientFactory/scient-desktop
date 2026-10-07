import type { ProviderConnectionMethod, ServerProvider } from "@t3tools/contracts";

import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

/**
 * Upstream's instance identity stamp plus Scient's connection state: the
 * assisted sign-in methods, offered only while the provider requires
 * authentication, and the resolved managed runtime summary.
 */
export const withConnectionInstanceIdentity = (
  input: Parameters<typeof withInstanceIdentity>[0] & {
    readonly runtime: NonNullable<NonNullable<ServerProvider["connection"]>["runtime"]>;
    readonly connectionMethods: ReadonlyArray<ProviderConnectionMethod>;
  },
) => {
  const stampIdentity = withInstanceIdentity(input);
  return (snapshot: ServerProviderDraft): ServerProvider => ({
    ...stampIdentity(snapshot),
    connection: {
      methods: snapshot.auth.required === false ? [] : input.connectionMethods,
      canDisconnect:
        snapshot.auth.required !== false &&
        input.connectionMethods.length > 0 &&
        snapshot.auth.status === "authenticated",
      operation: null,
      runtime: input.runtime,
    },
  });
};
