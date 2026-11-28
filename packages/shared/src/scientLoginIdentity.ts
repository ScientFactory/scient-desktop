/**
 * One saved login, however many rows hold it: rows are grouped for display and for updates, never
 * merged. Only website rows with a password count; universities and session rows are not logins.
 */
export interface LoginRow {
  readonly accountId: string;
  readonly details: {
    readonly kind: string;
    readonly sites?: ReadonlyArray<string>;
    readonly username?: string | undefined;
    readonly loginUrl?: string | undefined;
    readonly institution?: unknown;
    readonly proxyUrl?: string | undefined;
    readonly origin?: string | undefined;
  };
  readonly secrets: { readonly password?: unknown };
}

/** A site's identity: its `https://` origin, a bare host read as that host's own origin. */
export function loginSiteKey(site: string): string | undefined {
  try {
    return new URL(site.includes("://") ? site : `https://${site}`).origin;
  } catch {
    return undefined;
  }
}

/**
 * Usernames compare exactly, except emails and Windows `DOMAIN\user` names, which compare without
 * case: `CC\corcosy` and `cc\corcosy` are one login.
 */
export function loginUserKey(username: string | undefined): string {
  const name = username ?? "";
  return name.includes("@") || name.includes("\\") ? name.toLowerCase() : name;
}

/**
 * The saved sign-in address's path tells tenants on one host apart, exactly as saved: `/login/acme`
 * and `/login/other` are two tenants, and a row with none is the host's own (`/`).
 */
export function loginTenant(loginUrl: string | undefined): string {
  if (!loginUrl) return "/";
  try {
    return new URL(loginUrl).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
}

export function isLoginRow(row: LoginRow): boolean {
  const { details } = row;
  return (
    details.kind === "website" &&
    row.secrets.password !== undefined &&
    details.institution === undefined &&
    details.proxyUrl === undefined &&
    details.origin !== "browser-session"
  );
}

/** A login's identity on one of its sites: what a removal remembers and an import is matched by. */
export interface LoginKey {
  readonly site: string;
  readonly tenant: string;
  readonly username: string;
}

export function loginKeysOf(details: LoginRow["details"]): LoginKey[] {
  const tenant = loginTenant(details.loginUrl);
  const username = loginUserKey(details.username);
  return (details.sites ?? []).flatMap((site) => {
    const key = loginSiteKey(site);
    return key ? [{ site: key, tenant, username }] : [];
  });
}

/** The same login on one site: site (port included), tenant and username all agree. */
export function sameLoginKey(a: LoginKey, b: LoginKey): boolean {
  return a.site === b.site && a.username === b.username && a.tenant === b.tenant;
}

/** Whether a login row is the login `details` names. */
export function isLogin(row: LoginRow, details: LoginRow["details"]): boolean {
  if (!isLoginRow(row)) return false;
  const wanted = loginKeysOf(details);
  return loginKeysOf(row.details).some((own) => wanted.some((key) => sameLoginKey(own, key)));
}

/**
 * The logins `details` could be, by site and username, whatever their tenant: an exact login
 * among them is that login; otherwise more than one is a choice for the person or the agent.
 */
export function loginCandidates<Row extends LoginRow>(
  rows: ReadonlyArray<Row>,
  details: LoginRow["details"],
): Row[] {
  const wanted = loginKeysOf(details);
  return rows.filter(
    (row) =>
      isLoginRow(row) &&
      loginKeysOf(row.details).some((own) =>
        wanted.some((key) => own.site === key.site && own.username === key.username),
      ),
  );
}

/** Login rows grouped: rows sharing a site, tenant and username are one login. */
export function loginGroups<Row extends LoginRow>(rows: ReadonlyArray<Row>): Row[][] {
  const parent = new Map<number, number>();
  const root = (index: number): number => {
    const up = parent.get(index) ?? index;
    if (up === index) return index;
    const top = root(up);
    parent.set(index, top);
    return top;
  };
  const byKey = new Map<string, number>();
  const logins = rows.filter(isLoginRow);
  logins.forEach((row, index) => {
    for (const { site, tenant, username } of loginKeysOf(row.details)) {
      const key = `${site}\u0000${tenant}\u0000${username}`;
      const seen = byKey.get(key);
      if (seen === undefined) byKey.set(key, index);
      else parent.set(root(index), root(seen));
    }
  });
  const groups = new Map<number, Row[]>();
  logins.forEach((row, index) => {
    const top = root(index);
    groups.set(top, [...(groups.get(top) ?? []), row]);
  });
  return [...groups.values()];
}

/** The other rows of the login `accountId` belongs to. */
export function loginCopies<Row extends LoginRow>(
  rows: ReadonlyArray<Row>,
  accountId: string,
): Row[] {
  const group = loginGroups(rows).find((rows) => rows.some((row) => row.accountId === accountId));
  return group?.filter((row) => row.accountId !== accountId) ?? [];
}
