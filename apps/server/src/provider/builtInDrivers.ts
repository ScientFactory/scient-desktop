import { AntigravityDriver, type AntigravityDriverEnv } from "./Drivers/AntigravityDriver.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import type { CursorDriverEnv } from "@t3tools/provider-cursor/server";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import { compareProviderDriverKinds } from "@t3tools/contracts";
import { DroidDriver, type DroidDriverEnv } from "./Drivers/DroidDriver.ts";
import { OmpDriver, type OmpDriverEnv } from "./Drivers/OmpDriver.ts";
import { ScientAgentDriver, type ScientAgentDriverEnv } from "./Drivers/ScientAgentDriver.ts";
import {
  CursorDriver,
  type CursorDriverCompositionEnv,
} from "./Drivers/CursorDriverComposition.ts";
import {
  AcpRegistryDriver,
  GrokDriver,
  type AcpRegistryCompositionEnv,
  type GrokCompositionRequirements,
} from "./AppProviderDriverComposition.ts";
import { OpenCodeDriver, type OpenCodeCompositionEnv } from "./OpenCodeDriverComposition.ts";
import { PiDriver, type PiCompositionRequirements } from "./PiDriverComposition.ts";
// SCIENT-FORK:START Scient Muse application composition
import { MuseDriver, type MuseCompositionEnv } from "./MuseDriverComposition.ts";
// SCIENT-FORK:END Scient Muse application composition
import type { ProviderUsageReaderEnv } from "@t3tools/provider-core/server/driver";

export type BuiltInDriversEnv =
  | AcpRegistryCompositionEnv
  | AntigravityDriverEnv
  | ClaudeDriverEnv
  | CodexDriverEnv
  | CursorDriverEnv
  | CursorDriverCompositionEnv
  | DroidDriverEnv
  | GrokCompositionRequirements
  | OpenCodeCompositionEnv
  | OmpDriverEnv
  | PiCompositionRequirements
  // SCIENT-FORK:START Scient Muse application composition
  | MuseCompositionEnv
  // SCIENT-FORK:END Scient Muse application composition
  | ScientAgentDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  AcpRegistryDriver,
  AntigravityDriver,
  CodexDriver,
  ClaudeDriver,
  CursorDriver,
  DroidDriver,
  GrokDriver,
  OpenCodeDriver,
  OmpDriver,
  PiDriver,
  ScientAgentDriver,
  MuseDriver,
].toSorted((left, right) => compareProviderDriverKinds(left.driverKind, right.driverKind));

export type BuiltInUsageReadersEnv =
  | ProviderUsageReaderEnv<typeof ClaudeDriver>
  | ProviderUsageReaderEnv<typeof CodexDriver>
  | ProviderUsageReaderEnv<typeof GrokDriver>
  | ProviderUsageReaderEnv<typeof OpenCodeDriver>
  | ProviderUsageReaderEnv<typeof AntigravityDriver>
  | ProviderUsageReaderEnv<typeof CursorDriver>
  | ProviderUsageReaderEnv<typeof PiDriver>
  | ProviderUsageReaderEnv<typeof MuseDriver>;

/** Transcript readers precede scan readers; first duplicates win aggregation. */
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>
> = [
  ClaudeDriver,
  CodexDriver,
  GrokDriver,
  PiDriver,
  OpenCodeDriver,
  MuseDriver,
  AntigravityDriver,
  CursorDriver,
];
