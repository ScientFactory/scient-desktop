export function matchesAccountOrigin(origin: string, sites: ReadonlyArray<string>): boolean {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return sites.some((site) =>
    site.startsWith("https://")
      ? URL.canParse(site) && new URL(site).origin === url.origin
      : url.port === "" && (url.hostname === site || url.hostname.endsWith(`.${site}`)),
  );
}
