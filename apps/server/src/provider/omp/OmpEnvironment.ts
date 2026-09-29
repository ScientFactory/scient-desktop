import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../../pathExpansion.ts";

/** Agent directory override, from oh-my-pi `packages/utils/src/dirs.ts`. */
const OMP_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** Named profile. `OMP_PROFILE` wins over `PI_PROFILE`, and a named profile over the agent directory. */
const OMP_PROFILE_ENV = "OMP_PROFILE";
const OMP_LEGACY_PROFILE_ENV = "PI_PROFILE";
/** Scient passes its own per-conversation session directory to every process. */
export const OMP_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

const hasName = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  Object.keys(env).find((key) => key.toUpperCase() === name);

const remove = (env: NodeJS.ProcessEnv, name: string): void => {
  for (let key = hasName(env, name); key !== undefined; key = hasName(env, name)) delete env[key];
};

/**
 * Scient and T3 server internals: the desktop-to-server bootstrap, ports,
 * homes, auth and MCP bearer tokens, analytics, OTLP and dev-runner settings
 * (`T3CODE_*`, `T3_*`, `SCIENT_*`), Vite dev-server wiring (`VITE_*`), the
 * Electron-as-Node switch the desktop sets for its backend, and the dev
 * runner's web and renderer ports. The OMP child inherits the full login
 * environment, but not these. Case-insensitive, because Windows names are.
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
 * Scient's extensions reach Scient over loopback (custom models, Scient
 * tools). OMP runs on Bun, whose fetch honors the proxy variables, so an
 * inherited corporate proxy must never see those requests.
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
 * lowercase one first), so neither may lose the user's exclusions.
 */
const exemptLoopbackFromProxy = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void => {
  // On Windows the names are case-insensitive: one variable, whatever its spelling.
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
 * The environment of every Oh My Pi child process: the server's full login
 * environment minus Scient's own internals, then the instance environment on
 * top, as configured, then without the session directory Scient sets per
 * process. An agent that runs git, cloud CLIs and toolchains needs what the
 * user's shell has, like every other provider; only what the server itself
 * inherited is filtered, so a variable the user configured on the instance
 * is passed even when its name looks internal. Scient adds nothing back: its
 * generated extensions receive their secrets in bootstrap files
 * (`OmpExtensionBootstrap`), never here. An instance home or profile
 * replaces its inherited counterparts, so OMP's own precedence (a named
 * profile beats the agent directory) cannot silently override the instance
 * setting. Loopback is always exempt from an inherited proxy.
 */
export const ompProcessEnvironment = (input: {
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly instanceEnvironment?: ProviderInstanceEnvironment | undefined;
  readonly homePath?: string | undefined;
  readonly profile?: string | undefined;
  readonly platform: NodeJS.Platform;
}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(input.baseEnv ?? process.env)) {
    if (value !== undefined && !isScientInternalEnvironmentName(name)) env[name] = value;
  }
  for (const variable of input.instanceEnvironment ?? []) env[variable.name] = variable.value;
  remove(env, OMP_SESSION_DIR_ENV);
  const home = input.homePath?.trim();
  const profile = input.profile?.trim();
  if (home) {
    remove(env, OMP_PROFILE_ENV);
    remove(env, OMP_LEGACY_PROFILE_ENV);
    remove(env, OMP_AGENT_DIR_ENV);
    env[OMP_AGENT_DIR_ENV] = expandHomePath(home);
  } else if (profile) {
    remove(env, OMP_LEGACY_PROFILE_ENV);
    remove(env, OMP_AGENT_DIR_ENV);
    remove(env, OMP_PROFILE_ENV);
    env[OMP_PROFILE_ENV] = profile;
  } else if (hasName(env, OMP_PROFILE_ENV) !== undefined) {
    // OMP ignores PI_PROFILE whenever OMP_PROFILE is set, even when it is
    // empty; dropping it keeps Scient's resume identity on OMP's precedence.
    remove(env, OMP_LEGACY_PROFILE_ENV);
  }
  exemptLoopbackFromProxy(env, input.platform);
  return env;
};
