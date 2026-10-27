import { requiredServerKeys } from "./PluginRequiredKeys.ts";

export interface PluginKeyStdioServer {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly envNames: ReadonlyArray<string>;
}

/** Secret-bearing arguments are withheld: substituting them would expose a key in OS argv. */
export function pluginKeyStdioServer(
  name: string,
  input: unknown,
  root: string,
): PluginKeyStdioServer | undefined {
  if (!name.trim() || name.length > 200 || !input || typeof input !== "object") return;
  const value = input as Record<string, unknown>;
  if (value.type !== undefined && value.type !== "stdio") return;
  if (typeof value.command !== "string" || !value.command || value.url !== undefined) return;
  const args = value.args ?? [];
  const env = value.env ?? {};
  if (!Array.isArray(args) || args.length > 200 || args.some((arg) => typeof arg !== "string"))
    return;
  if (!env || typeof env !== "object" || Array.isArray(env)) return;
  const roots = /\$\{(?:CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|OMP_PLUGIN_ROOT|PI_PACKAGE_ROOT)\}/g;
  const expandRoot = (text: string) => text.replace(roots, () => root);
  const command = expandRoot(value.command);
  const expandedArgs = (args as string[]).map(expandRoot);
  // Neither a shell nor a secret substitution is used for command/arguments.
  if ([command, ...expandedArgs].some((arg) => arg.includes("${") || arg.includes("\0"))) return;
  const entries = Object.entries(env);
  if (
    entries.length > 200 ||
    entries.some(
      ([key, text]) =>
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
        typeof text !== "string" ||
        text.includes("\0"),
    )
  )
    return;
  const configured = Object.fromEntries(
    entries.map(([key, text]) => [key, expandRoot(text as string)]),
  );
  const envNames = requiredServerKeys(value);
  if (!envNames.length || referencesKey([command, ...expandedArgs], envNames)) return;
  // Only known secret placeholders and plugin-root builtins can be expanded.
  for (const text of Object.values(configured)) {
    if (
      text
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g, (match, key: string) =>
          envNames.includes(key) ? "" : match,
        )
        .includes("${")
    )
      return;
  }
  return { name, command, args: expandedArgs, env: configured, envNames };
}

/** `$NAME`, `$env:NAME` or `%NAME%` lets a shell put the key into the server's argv. */
function referencesKey(texts: ReadonlyArray<string>, names: ReadonlyArray<string>) {
  return texts.some((text) =>
    names.some((name) =>
      new RegExp(`\\$(?:env:)?${name}(?![A-Za-z0-9_])|%${name}%`, "i").test(text),
    ),
  );
}

export function pluginKeyHasSecretArgs(input: unknown) {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  if (typeof value.command !== "string") return false;
  const texts = [value.command, ...(Array.isArray(value.args) ? value.args : [])].filter(
    (text): text is string => typeof text === "string",
  );
  return (
    referencesKey(texts, requiredServerKeys(value)) ||
    requiredServerKeys({
      args: Array.isArray(value.args)
        ? value.args.map((arg) =>
            typeof arg === "string" ? arg.replaceAll("${user_config.", "${") : arg,
          )
        : [],
    }).length > 0
  );
}
