import { useEffect, useMemo, useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { computeExperienceFixture } from "./computeExperienceFixtures";
import { ScientComputeEditorDock } from "./ScientComputeEditorDock";
import {
  COMPUTE_LAB_SCENARIO_EVENT,
  readComputeLabScenario,
  type ComputeLabScenarioName,
} from "./state";

/**
 * Lab seam for the editor strip.
 *
 * The dock's one piece of real app state is whether the right panel is showing
 * the compute surface, because the design turns on that: the dock exists to
 * replace the panel when the panel is not there, not to duplicate it. Reading it
 * from the real store rather than a fixture flag is the point -- open and close
 * the panel and the strip has to react.
 */
export function ScientComputeEditorLabDock() {
  const [scenario, setScenario] = useState<ComputeLabScenarioName>(readComputeLabScenario);

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<ComputeLabScenarioName>).detail;
      if (typeof next === "string") setScenario(next);
    };
    window.addEventListener(COMPUTE_LAB_SCENARIO_EVENT, onChange);
    return () => window.removeEventListener(COMPUTE_LAB_SCENARIO_EVENT, onChange);
  }, []);

  const panelVisible = useRightPanelStore((store) =>
    Object.values(store.byThreadKey).some(
      (entry) => entry.isOpen && entry.activeSurfaceId === "scient:compute",
    ),
  );

  const fixture = useMemo(() => computeExperienceFixture(scenario), [scenario]);

  return <ScientComputeEditorDock fixture={fixture} panelVisible={panelVisible} />;
}
