import { makeMuseDriver, type MuseDriverEnv } from "@t3tools/provider-muse/server";
import { buildScientRuntimeInstructions } from "./ScientRuntimeInstructions.ts";

export type MuseCompositionEnv = MuseDriverEnv;

/** The production Muse driver keeps Scient identity in the app-owned prompt composer. */
export const MuseDriver = makeMuseDriver({
  runtimeInstructions: buildScientRuntimeInstructions,
});
