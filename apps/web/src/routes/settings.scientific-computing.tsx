import { createFileRoute } from "@tanstack/react-router";

import { ScientComputeSettingsPanel } from "../scient/uxLab/ScientComputeSettingsPanel";

/**
 * Settings → Scientific Computing.
 *
 * A UX Lab design proposition. The route is registered unconditionally because
 * the settings path union is exhaustive, but the sidebar only lists it when the
 * lab flag is on, so it is unreachable in a normal build.
 */
export const Route = createFileRoute("/settings/scientific-computing")({
  component: ScientComputeSettingsPanel,
});
