import { compareSemverVersions } from "@t3tools/shared/semver";

import type { OmpExecutableIdentity, OmpTarget } from "../omp/OmpTarget.ts";

export const SCIENT_CONNECTOR_LOAD_MODE_ENV = "SCIENT_AGENT_CONNECTOR_LOAD_MODE";

/** 0.1.4 / OMP 18.18.0 preserves mounted tools across cold subagent revival. */
export const scientConnectorLoadMode = (target: OmpTarget, identity: OmpExecutableIdentity) =>
  target.driverKind === "scient" &&
  compareSemverVersions(identity.version, "0.1.4") >= 0 &&
  compareSemverVersions(identity.runtimeVersion, "18.18.0") >= 0
    ? "discoverable"
    : "essential";
