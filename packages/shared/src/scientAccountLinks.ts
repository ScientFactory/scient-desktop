/**
 * A link to one Accounts row on one computer, which Scient's chat opens in Accounts & secrets.
 * Agents return it after a save, so the person can open what was kept.
 */
const ACCOUNT_LINK_PREFIX = "scient-account://";
const ACCOUNT_ID = /^acc_[A-Za-z0-9_-]{8,64}$/;

export const accountLinkHref = (environmentId: string, accountId: string) =>
  `${ACCOUNT_LINK_PREFIX}${encodeURIComponent(environmentId)}/${accountId}`;

/** A Markdown link named after the row; brackets in the name can't end the label. */
export const formatAccountLink = (environmentId: string, accountId: string, name: string) =>
  `[${name.replace(/[[\]\\]/g, "").trim() || "Open in Accounts"}](${accountLinkHref(environmentId, accountId)})`;

export const parseAccountLinkHref = (
  href: string,
): { readonly environmentId: string; readonly accountId: string } | null => {
  if (!href.startsWith(ACCOUNT_LINK_PREFIX)) return null;
  const [environment, accountId, ...rest] = href.slice(ACCOUNT_LINK_PREFIX.length).split("/");
  if (rest.length || !environment || !accountId || !ACCOUNT_ID.test(accountId)) return null;
  try {
    return { environmentId: decodeURIComponent(environment), accountId };
  } catch {
    return null;
  }
};
