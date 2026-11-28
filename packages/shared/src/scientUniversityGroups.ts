import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountSummary,
} from "@t3tools/contracts";
import {
  libraryLink,
  openAthensUniversity,
  universitiesOf,
  universityDetails,
} from "./scientPaperLinks.ts";
import { siteMatchesUrl, siteOf } from "./scientSiteMatch.ts";
import { parseUrl } from "./url.ts";

/** Hosts many universities sign in through: they never tie two rows together. */
const SHARED_HOST =
  /(?:^|\.)(?:google\.com|microsoftonline\.com|microsoft\.com|live\.com|openathens\.net|oclc\.org)$/u;

/** A host a stored site names, when it is a real public host name. */
const hostOf = (site: string) => {
  const host = (
    site.includes("://") ? parseUrl(site)?.hostname : site.split("/")[0]
  )?.toLowerCase();
  return host && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(host) ? host : undefined;
};

const under = (host: string, domain: string) => siteMatchesUrl(domain, `https://${host}`);

/** One username at one university: its rows are copies and routes, each with its own sessions. */
export interface UniversityMembership {
  readonly username: string | undefined;
  readonly rows: ReadonlyArray<AccountSummary>;
}

/** One university as the person sees it. A view over stored rows, which never change for it. */
export interface UniversityGroup {
  /** The first row's id: stable while that row exists. */
  readonly key: string;
  readonly name: string;
  readonly domain: string | undefined;
  readonly rows: ReadonlyArray<AccountSummary>;
  readonly memberships: ReadonlyArray<UniversityMembership>;
}

/** What ties a row to its university: its directory entity, its domain and its library's host. */
function ties(account: AccountSummary) {
  const details = universityDetails(account.details);
  if (!details) return { entity: undefined, domains: [], host: undefined };
  const link = details.proxyUrl ? libraryLink(details.proxyUrl) : undefined;
  const domains = [
    details.institution && hostOf(details.institution.domain),
    link?.kind === "openathens" ? link.domain : undefined,
  ].filter((domain): domain is string => domain !== undefined && !SHARED_HOST.test(domain));
  const host = link?.kind === "proxy" && !SHARED_HOST.test(link.host) ? link.host : undefined;
  return { entity: details.institution?.entityId, domains, host };
}

/**
 * Rows for the same university, grouped: the same directory entity, the same domain (a library
 * host under it included) or the same library host. Directory rows lead, as `universitiesOf` orders.
 */
export function universityGroups(
  accounts: ReadonlyArray<AccountSummary>,
): ReadonlyArray<UniversityGroup> {
  const rows = universitiesOf(accounts);
  const tied = rows.map(ties);
  const allDomains = tied.flatMap(({ domains }) => domains);
  const keysOf = (index: number) => {
    const { entity, domains, host } = tied[index]!;
    return [
      ...(entity ? [`entity:${entity}`] : []),
      ...domains.map((domain) => `domain:${domain}`),
      ...(host ? [`host:${host}`] : []),
      ...(host ? allDomains.filter((domain) => under(host, domain)) : []).map(
        (domain) => `domain:${domain}`,
      ),
    ];
  };
  const parent = rows.map((_, index) => index);
  const root = (index: number): number =>
    parent[index] === index ? index : (parent[index] = root(parent[index]!));
  const owner = new Map<string, number>();
  rows.forEach((_, index) => {
    for (const key of keysOf(index)) {
      const seen = owner.get(key);
      if (seen === undefined) owner.set(key, index);
      else parent[Math.max(root(seen), root(index))] = Math.min(root(seen), root(index));
    }
  });
  const byRoot = new Map<number, AccountSummary[]>();
  rows.forEach((row, index) => byRoot.set(root(index), [...(byRoot.get(root(index)) ?? []), row]));
  return [...byRoot.entries()].map(([index, members]) => {
    const lead = members[0]!;
    const institution = members
      .map((row) => universityDetails(row.details)?.institution)
      .find(Boolean);
    return {
      key: lead.accountId,
      name: lead.name,
      domain: institution?.domain ?? tied[index]!.domains[0] ?? tied[index]!.host,
      rows: members,
      memberships: membershipsOf(members),
    };
  });
}

const usernameOf = (row: AccountSummary) =>
  row.details.kind === "website" ? row.details.username?.toLowerCase() : undefined;

/** One membership per username; rows that name no one join the only named one there is. */
function membershipsOf(rows: ReadonlyArray<AccountSummary>): ReadonlyArray<UniversityMembership> {
  const named = [...new Set(rows.map(usernameOf).filter((name) => name !== undefined))];
  const sole = named.length === 1 ? named[0] : undefined;
  const memberships = new Map<string | undefined, AccountSummary[]>();
  for (const row of rows) {
    const username = usernameOf(row) ?? sole;
    memberships.set(username, [...(memberships.get(username) ?? []), row]);
  }
  return [...memberships].map(([username, members]) => ({ username, rows: members }));
}

/**
 * Each university row's membership as one key, for one attempt at a time and one fallback a day:
 * its university (the group's domain, else its first row) and the membership's username, compared
 * as memberships compare them. Every route and copy of one membership shares it.
 */
export function membershipKeys(accounts: ReadonlyArray<AccountSummary>) {
  const keys = new Map<string, string>();
  for (const group of universityGroups(accounts)) {
    const university = group.domain ? siteOf(group.domain) : group.key;
    for (const { username, rows } of group.memberships)
      for (const row of rows) keys.set(row.accountId, `university|${university}|${username ?? ""}`);
  }
  return keys;
}

/** The group that holds a row. */
export const groupOf = (groups: ReadonlyArray<UniversityGroup>, accountId: string) =>
  groups.find((group) => group.rows.some((row) => row.accountId === accountId));

/**
 * What a university's Sign out clears in one profile: a host on one of its own sites clears that
 * site, any other host only itself (`inSignOutTarget`). Never Google, Microsoft or OCLC; OpenAthens
 * only for an OpenAthens university no other membership in the profile (`others`) shares.
 */
export function signOutHosts(
  rows: ReadonlyArray<AccountSummary>,
  others: ReadonlyArray<AccountSummary> = [],
): ReadonlyArray<string> {
  const universities = rows.flatMap((row) => {
    const details = universityDetails(row.details);
    return details ? [{ details, ...ties(row) }] : [];
  });
  const own = new Set(
    universities.flatMap(({ details, domains }) => [
      ...domains.map(siteOf),
      // A site a row names as itself, as old library rows name the university's domain.
      ...details.sites.flatMap((site) => {
        const host = !site.includes("://") ? hostOf(site) : undefined;
        return host && siteOf(host) === host ? [host] : [];
      }),
    ]),
  );
  const targets = new Set<string>();
  for (const { details, domains, host } of universities)
    for (const named of [...domains, host, ...details.sites.map(hostOf)]) {
      if (!named || SHARED_HOST.test(siteOf(named))) continue;
      targets.add(own.has(siteOf(named)) ? siteOf(named) : named);
    }
  const openAthens = (row: AccountSummary) => {
    const details = universityDetails(row.details);
    return details !== undefined && openAthensUniversity(details);
  };
  if (rows.some(openAthens) && !others.some(openAthens)) targets.add("openathens.net");
  return [...targets];
}

/** The membership a row belongs to: its university's rows for one person. */
export const universityMembership = (accounts: ReadonlyArray<AccountSummary>, accountId: string) =>
  groupOf(universityGroups(accounts), accountId)?.memberships.find(({ rows }) =>
    rows.some((row) => row.accountId === accountId),
  );

const profileOf = (row: AccountSummary) =>
  BrowserProfileId.make(
    ("profileId" in row.details ? row.details.profileId : undefined) ?? DEFAULT_BROWSER_PROFILE_ID,
  );

/**
 * What signing these rows out clears in each of their profiles, from that profile's own rows:
 * another's library host isn't its own, and another membership's OpenAthens session stays. Sign
 * out and the cleanup after a late sign-in both clear this.
 */
export const signOutTargets = (
  rows: ReadonlyArray<AccountSummary>,
  all: ReadonlyArray<AccountSummary>,
) =>
  [...new Set(rows.map(profileOf))].flatMap((profileId) => {
    const inProfile = (row: AccountSummary) => profileOf(row) === profileId;
    const others = all.filter(
      (row) => inProfile(row) && !rows.some((own) => own.accountId === row.accountId),
    );
    return signOutHosts(rows.filter(inProfile), others).map((site) => ({ profileId, site }));
  });

/**
 * The quiet check's cache entry: one membership, one route, one profile. Rows sharing all three
 * show the same session, so one look answers for them all.
 */
export function glanceKey(account: AccountSummary) {
  const details = universityDetails(account.details);
  const route = details
    ? openAthensUniversity(details)
      ? "openathens"
      : (details.institution?.entityId ?? details.proxyUrl ?? "")
    : "";
  const profile = details?.profileId ?? DEFAULT_BROWSER_PROFILE_ID;
  return `${membershipKeys([account]).get(account.accountId)}|${route}|${profile}`;
}
