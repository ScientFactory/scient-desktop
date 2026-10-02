import { OMP_MINIMUM_VERSION, OMP_SUPPORTED_MAJOR } from "@scientfactory/provider-runtime";
import { ProviderDriverKind } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";

/** What a target's identity probe learned from an executable. */
export interface OmpExecutableIdentity {
  /** The product's own version, shown to the user. */
  readonly version: string;
  /**
   * The Oh My Pi release the executable runs. RPC behavior and session
   * resume follow it, whatever the product's own version is.
   */
  readonly runtimeVersion: string;
}

/**
 * One product that speaks Oh My Pi's RPC protocol. Oh My Pi and Scient Agent
 * share the wire protocol, the session behavior and this server's adapter
 * code; a target holds what each product owns separately, so the two never
 * share a name, an executable identity, or state.
 */
export interface OmpTarget {
  readonly driverKind: ProviderDriverKind;
  /** The provider's name in pickers and settings. */
  readonly displayName: string;
  /** The product's name in messages shown to the user. */
  readonly name: string;
  /** The name after its indefinite article, as in "Ignored an Oh My Pi request". */
  readonly nameWithArticle: string;
  /**
   * Names this product's folders under Scient's state directory:
   * `<stateDir>/<stateNamespace>/extensions` and
   * `<stateDir>/<stateNamespace>-sessions`.
   */
  readonly stateNamespace: string;
  /** The variables the executable reads to locate its own state. */
  readonly environment: {
    readonly agentDir: string;
    readonly profile: string;
    /** Consulted by the executable only when `profile` is unset. */
    readonly profileFallback: string;
    readonly sessionDir: string;
  };
  /** Arguments that make the executable print its identity and exit. */
  readonly identityArgs: ReadonlyArray<string>;
  /**
   * Reads that output. `undefined` when the executable is another product or
   * a release this server is not qualified against.
   */
  readonly identify: (stdout: string) => OmpExecutableIdentity | undefined;
  /** Shown when `identify` rejects the executable. */
  readonly unsupportedDetail: string;
  /** The oldest release of the product this server supports, for messages. */
  readonly minimumVersion: string;
}

/** True for an Oh My Pi release whose RPC surface this server is qualified against. */
export const isSupportedOmpRuntimeVersion = (version: string): boolean =>
  compareSemverVersions(version, OMP_MINIMUM_VERSION) >= 0 &&
  Number(version.split(".")[0] ?? "0") === OMP_SUPPORTED_MAJOR;

const parseOmpVersion = (output: string): string | undefined =>
  output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u)?.[0];

/** The official Oh My Pi executable, installed by the user or managed by Scient. */
export const ompTarget: OmpTarget = {
  driverKind: ProviderDriverKind.make("omp"),
  displayName: "Oh My Pi",
  name: "Oh My Pi",
  nameWithArticle: "an Oh My Pi",
  stateNamespace: "omp",
  environment: {
    agentDir: "PI_CODING_AGENT_DIR",
    profile: "OMP_PROFILE",
    profileFallback: "PI_PROFILE",
    sessionDir: "PI_CODING_AGENT_SESSION_DIR",
  },
  identityArgs: ["--version"],
  identify: (stdout) => {
    const version = parseOmpVersion(stdout);
    return version !== undefined && isSupportedOmpRuntimeVersion(version)
      ? { version, runtimeVersion: version }
      : undefined;
  },
  unsupportedDetail: `Scient supports Oh My Pi ${OMP_MINIMUM_VERSION} and later ${OMP_SUPPORTED_MAJOR}.x releases. Check the configured executable.`,
  minimumVersion: OMP_MINIMUM_VERSION,
};
