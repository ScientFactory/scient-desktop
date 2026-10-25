import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { agentProcessEnvironment } from "../agentProcessEnvironment.ts";
import { ompTarget } from "./OmpTarget.ts";

/** Agent directory override, from oh-my-pi `packages/utils/src/dirs.ts`. */
const OMP_AGENT_DIR_ENV = ompTarget.environment.agentDir;
/** Named profile. `OMP_PROFILE` wins over `PI_PROFILE`, and a named profile over the agent directory. */
const OMP_PROFILE_ENV = ompTarget.environment.profile;
const OMP_LEGACY_PROFILE_ENV = ompTarget.environment.profileFallback;
/** Scient passes its own per-conversation session directory to every process. */
const OMP_SESSION_DIR_ENV = ompTarget.environment.sessionDir;

const hasName = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  Object.keys(env).find((key) => key.toUpperCase() === name);

const remove = (env: NodeJS.ProcessEnv, name: string): void => {
  for (let key = hasName(env, name); key !== undefined; key = hasName(env, name)) delete env[key];
};

/**
 * Never merge host env back after sanitization. Use bootstrap files for secrets; expand instance
 * homes against host HOME. Instance home/profile must replace inherited counterparts so OMP's
 * profile precedence cannot override the configured instance.
 */
export const ompProcessEnvironment = (input: {
  readonly homeDirectory: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly instanceEnvironment?: ProviderInstanceEnvironment | undefined;
  readonly homePath?: string | undefined;
  readonly profile?: string | undefined;
  readonly platform: NodeJS.Platform;
}): NodeJS.ProcessEnv => {
  const env = agentProcessEnvironment({
    baseEnv: input.baseEnv,
    instanceEnvironment: input.instanceEnvironment,
    platform: input.platform,
  });
  remove(env, OMP_SESSION_DIR_ENV);
  const home = input.homePath?.trim();
  const profile = input.profile?.trim();
  if (home) {
    remove(env, OMP_PROFILE_ENV);
    remove(env, OMP_LEGACY_PROFILE_ENV);
    remove(env, OMP_AGENT_DIR_ENV);
    env[OMP_AGENT_DIR_ENV] = expandHomePath(home, input.homeDirectory);
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
  return env;
};
