import { requiredServerKeys } from "./PluginRequiredKeys.ts";

export interface PluginKeyHttpServer {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly envNames: ReadonlyArray<string>;
}
const record = (input: unknown): Readonly<Record<string, unknown>> | undefined =>
  input !== null && typeof input === "object" && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : undefined;

export function pluginKeyHttpServer(name: string, input: unknown): PluginKeyHttpServer | undefined {
  if (!name.trim() || name.length > 200) return undefined;
  const server = record(input);
  if (
    !server ||
    server.command !== undefined ||
    (server.type !== undefined && server.type !== "http") ||
    typeof server.url !== "string" ||
    server.url.includes("${")
  )
    return undefined;
  const url = URL.parse(server.url);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.hash)
    return undefined;
  const configured = record(server.headers);
  if (!configured || Object.keys(configured).length > 50) return undefined;
  const headers: Record<string, string> = {};
  const envNames = new Set<string>();
  for (const [header, template] of Object.entries(configured)) {
    if (
      !/^[A-Za-z0-9-]{1,100}$/.test(header) ||
      /^(?:host|cookie|connection|content-length|transfer-encoding|proxy-authorization)$/i.test(
        header,
      ) ||
      typeof template !== "string" ||
      template.length > 4000 ||
      /[\r\n\0]/.test(template)
    )
      return undefined;
    const refs = [...template.matchAll(/\$\{(?:user_config\.)?([A-Za-z_][A-Za-z0-9_]{0,127})\}/g)];
    if (
      template.replace(/\$\{(?:user_config\.)?[A-Za-z_][A-Za-z0-9_]{0,127}\}/g, "").includes("${")
    )
      return undefined;
    for (const match of refs) envNames.add(match[1]!);
    headers[header] = template;
  }
  const required = requiredServerKeys(server);
  if (!envNames.size || required.some((key) => !envNames.has(key))) return undefined;
  return { name, url: url.href, headers, envNames: [...envNames].sort() };
}

export function pluginKeyHttpOrigins(servers: ReadonlyArray<PluginKeyHttpServer>) {
  const origins = new Map<string, string[]>();
  for (const server of servers)
    for (const envName of server.envNames) {
      origins.set(envName, [
        ...new Set([...(origins.get(envName) ?? []), new URL(server.url).origin]),
      ]);
    }
  return origins;
}
