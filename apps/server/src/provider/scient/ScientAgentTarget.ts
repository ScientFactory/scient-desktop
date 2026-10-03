import { ProviderDriverKind, type ProviderInstanceEnvironment } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";
import { OMP_RPC_PROTOCOL_V2 } from "effect-omp-rpc/schema";

import { agentProcessEnvironment } from "../agentProcessEnvironment.ts";
import { isSupportedOmpRuntimeVersion, type OmpTarget } from "../omp/OmpTarget.ts";

/** The oldest Scient Agent release this server drives. */
const SCIENT_AGENT_MINIMUM_VERSION = "0.1.0";
/** The Scient Agent major this server is qualified against. */
const SCIENT_AGENT_SUPPORTED_MAJOR = 0;

const SCIENT_AGENT_PRODUCT = "scient-agent";

/** What `scient-agent --runtime-info` prints: one JSON object. */
const ScientAgentRuntimeInfo = Schema.Struct({
  product: Schema.String,
  version: Schema.String,
  upstream: Schema.Struct({ name: Schema.String, version: Schema.String }),
  rpcProtocolVersions: Schema.Array(Schema.Finite),
});
const decodeRuntimeInfo = Schema.decodeUnknownOption(Schema.fromJsonString(ScientAgentRuntimeInfo));

const SCIENT_AGENT_UPSTREAM = "oh-my-pi";
/**
 * A release version: three numbers without leading zeros, and an optional
 * prerelease whose identifiers start with a letter or digit. The shared
 * comparator reads the prerelease after the first hyphen, so one that starts
 * with a hyphen would compare as the stable release.
 */
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

const isSupportedScientAgentVersion = (version: string): boolean =>
  SEMVER.test(version) &&
  compareSemverVersions(version, SCIENT_AGENT_MINIMUM_VERSION) >= 0 &&
  Number(version.split(".")[0]) === SCIENT_AGENT_SUPPORTED_MAJOR;

/**
 * Scient Agent: ScientFactory's agent, built from Oh My Pi. It speaks the same
 * RPC protocol, and is a separate product with its own executable, state and
 * updates. Nothing here is shared with an Oh My Pi installation.
 */
export const scientAgentTarget: OmpTarget = {
  driverKind: ProviderDriverKind.make("scient"),
  displayName: "Scient",
  name: "Scient Agent",
  nameWithArticle: "a Scient Agent",
  stateNamespace: "scient-agent",
  environment: {
    agentDir: "SCIENT_AGENT_DIR",
    profile: "SCIENT_AGENT_PROFILE",
    profileFallback: "SCIENT_AGENT_PROFILE_FALLBACK",
    sessionDir: "SCIENT_AGENT_SESSION_DIR",
  },
  identityArgs: ["--runtime-info"],
  // The product must name itself: an `omp` executable prints usage for this
  // flag, so it can never pass as Scient Agent.
  identify: (stdout) => {
    const info = decodeRuntimeInfo(stdout.trim());
    if (info._tag === "None") return undefined;
    const { product, version, upstream, rpcProtocolVersions } = info.value;
    return product === SCIENT_AGENT_PRODUCT &&
      isSupportedScientAgentVersion(version) &&
      upstream.name === SCIENT_AGENT_UPSTREAM &&
      SEMVER.test(upstream.version) &&
      isSupportedOmpRuntimeVersion(upstream.version) &&
      rpcProtocolVersions.includes(OMP_RPC_PROTOCOL_V2)
      ? { version, runtimeVersion: upstream.version }
      : undefined;
  },
  unsupportedDetail: `This is not a Scient Agent release this version of Scient supports (${SCIENT_AGENT_MINIMUM_VERSION} or newer ${SCIENT_AGENT_SUPPORTED_MAJOR}.x). Check the configured executable.`,
  minimumVersion: SCIENT_AGENT_MINIMUM_VERSION,
  noModelsHint:
    "Sign in to a model account, add a custom model in Settings, or start a local model server such as Ollama.",
};

/** The directory Scient Agent keeps all of its own files in, assigned by this server. */
const SCIENT_AGENT_ROOT_ENV = "SCIENT_AGENT_ROOT";
/** The agent's own variables: where its state, sessions, caches and settings overlays live. */
const SCIENT_AGENT_ENV_PREFIX = "SCIENT_AGENT_";

/**
 * The environment of every Scient Agent child process: the provider-neutral
 * agent environment, with the agent's whole config root assigned to `root`.
 * This server owns the agent's own variables, so only the root is set: an
 * inherited `SCIENT_*` name never reaches an agent (`agentProcessEnvironment`),
 * and a `SCIENT_AGENT_*` variable set on the instance is dropped here. The
 * agent applies the same rule to `.env` files outside the root. Oh My Pi's own
 * variables pass through untouched: Scient Agent ignores them, and a stock
 * `omp` started from the agent's shell keeps the user's own setup.
 */
export const scientAgentProcessEnvironment = (input: {
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly instanceEnvironment?: ProviderInstanceEnvironment | undefined;
  readonly root: string;
  readonly platform: NodeJS.Platform;
}): NodeJS.ProcessEnv => {
  const env = agentProcessEnvironment({
    baseEnv: input.baseEnv,
    instanceEnvironment: input.instanceEnvironment,
    platform: input.platform,
  });
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith(SCIENT_AGENT_ENV_PREFIX)) delete env[name];
  }
  env[SCIENT_AGENT_ROOT_ENV] = input.root;
  return env;
};
