const BUILTIN_VARIABLES = new Set([
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_SESSION_ID",
  "CODEX_PLUGIN_ROOT",
  "CODEX_HOME",
  "OMP_PLUGIN_ROOT",
  "PI_PACKAGE_ROOT",
  "HOME",
  "USERPROFILE",
  "PATH",
  "PWD",
  "OLDPWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
]);
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

export function declaredPluginKeys(manifest: unknown): ReadonlyArray<string> {
  return Object.entries(record(record(manifest).userConfig))
    .filter(([name, setting]) => KEY_NAME.test(name) && record(setting).sensitive === true)
    .map(([name]) => name);
}

/** Projects names only; literal credentials and user-config values never leave the reader. */
export function requiredServerKeys(server: unknown): ReadonlyArray<string> {
  const names = new Set<string>();
  const add = (name: string) => {
    if (KEY_NAME.test(name) && !BUILTIN_VARIABLES.has(name)) names.add(name);
  };
  const scan = (value: unknown) => {
    if (typeof value !== "string") return;
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g)) add(match[1]!);
  };
  const settings = record(server);
  for (const value of Object.values(record(settings.headers))) scan(value);
  for (const value of Array.isArray(settings.args) ? settings.args : []) scan(value);
  scan(settings.url);
  for (const [name, value] of Object.entries(record(settings.env))) {
    scan(value);
    if (typeof value === "string" && /^(?:\s*|<[^<>]+>|YOUR_[A-Z0-9_]+)$/i.test(value)) add(name);
  }
  return [...names].sort();
}
