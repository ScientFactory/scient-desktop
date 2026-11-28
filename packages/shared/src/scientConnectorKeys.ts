import { type AccountSummary, keyServesUse, sameAuthStyle } from "@t3tools/contracts";

import { siteMatchesUrl } from "./scientSiteMatch.ts";

/**
 * Whether a saved key can serve this connector: one it may serve, for the connector's address,
 * in the header style it sends, not Off, and for every project, since a connector serves all of
 * its own. A key kept for this connector alone fits though saved Off, as the server reads it.
 */
export function connectorKeyFits(
  account: AccountSummary,
  connector: {
    readonly connectorId: string;
    readonly url: string;
    readonly strategy: "bearer" | "header" | "basic";
    readonly headerName?: string | undefined;
  },
): boolean {
  const { details } = account;
  if (
    details.kind !== "api-key" ||
    account.secrets.token === undefined ||
    account.controls.scope.type !== "all-projects" ||
    (account.controls.access === "off" && details.privateTo === undefined) ||
    !keyServesUse(account, { kind: "connector", id: connector.connectorId }) ||
    !details.sites.some((site) => siteMatchesUrl(site, connector.url))
  )
    return false;
  return sameAuthStyle(
    details.auth,
    connector.strategy === "header"
      ? { type: "header", name: connector.headerName ?? "Authorization" }
      : connector.strategy === "basic"
        ? { type: "basic", username: "" }
        : { type: "bearer" },
  );
}
