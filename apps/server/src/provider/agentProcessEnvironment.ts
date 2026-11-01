import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

/**
 * Filter bootstrap, auth, ports, telemetry, Vite, and Electron-as-Node internals case-insensitively
 * because Windows environment names are case-insensitive.
 */
const SCIENT_INTERNAL_ENVIRONMENT_PREFIXES = ["T3CODE_", "T3_", "SCIENT_", "VITE_"] as const;
const SCIENT_INTERNAL_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RENDERER_PORT",
  "PORT",
]);

const isScientInternalEnvironmentName = (name: string): boolean => {
  const normalized = name.toUpperCase();
  return (
    SCIENT_INTERNAL_ENVIRONMENT_NAMES.has(normalized) ||
    SCIENT_INTERNAL_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
};

/**
 * Scient serves agents over loopback (Droid's key broker, OMP's extensions).
 * Agents on Bun or Node honor the proxy variables, so an inherited corporate
 * proxy must never see those requests.
 */
const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"] as const;

const noProxyEntries = (value: string | undefined): ReadonlyArray<string> =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * Both spellings end up with the same list: every entry either spelling had,
 * then loopback. Tools disagree on which spelling wins (Bun reads the
 * lowercase one first), so neither may lose the user's exclusions. On Windows
 * the names are one case-insensitive variable.
 */
const exemptLoopbackFromProxy = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void => {
  const keys =
    platform === "win32"
      ? Object.keys(env).filter((key) => key.toUpperCase() === "NO_PROXY")
      : ["NO_PROXY", "no_proxy"].filter((key) => env[key] !== undefined);
  const entries: Array<string> = [];
  for (const key of keys)
    for (const entry of noProxyEntries(env[key])) if (!entries.includes(entry)) entries.push(entry);
  for (const host of LOOPBACK_NO_PROXY) if (!entries.includes(host)) entries.push(host);
  const value = entries.join(",");
  if (platform === "win32") {
    for (const key of keys) delete env[key];
    env[keys[0] ?? "NO_PROXY"] = value;
    return;
  }
  env.NO_PROXY = value;
  env.no_proxy = value;
};

/**
 * Filter only inherited server internals, then apply the instance environment exactly as configured
 * and exempt loopback from proxies. Agents need the user's login toolchains; explicit instance
 * variables remain valid even with internal-looking names. Add no secrets here.
 */
export const agentProcessEnvironment = (input: {
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly instanceEnvironment?: ProviderInstanceEnvironment | undefined;
  readonly platform: NodeJS.Platform;
}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(input.baseEnv ?? process.env)) {
    if (value !== undefined && !isScientInternalEnvironmentName(name)) env[name] = value;
  }
  for (const variable of input.instanceEnvironment ?? []) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value === "string") env[variable.name] = variable.value;
  }
  exemptLoopbackFromProxy(env, input.platform);
  return env;
};

/**
 * For spawners that always merge the server's own environment into the child's
 * (`extendEnv`, SDK transports): names present in `inherited` but absent from
 * `env` are set to `undefined`, which Node omits from the child, so the merge
 * cannot reintroduce what the environment rule removed.
 */
export const withoutInheritedEnvironment = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const normalize = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
  const kept = new Set(
    Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [normalize(name)])),
  );
  const masked: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(inherited))
    if (!kept.has(normalize(name))) masked[name] = undefined;
  return { ...masked, ...env };
};
