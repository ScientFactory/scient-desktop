import { useEffect, useMemo, useState } from "react";

import { ScientComputeSessionPanel } from "./ScientComputeSessionPanel";
import { computeLabFixture } from "./computeFixtures";
import {
  COMPUTE_LAB_SCENARIO_EVENT,
  readComputeLabScenario,
  type ComputeLabScenarioName,
} from "./state";

/**
 * The lab's compute panel as a real right-panel surface.
 *
 * The panel itself takes a fixture and knows nothing about the lab; this is the
 * only piece that reads lab state, so the design component stays the thing that
 * Phase 4 can adopt unchanged.
 */
export function ScientComputeLabPanel() {
  const [scenario, setScenario] = useState<ComputeLabScenarioName>(readComputeLabScenario);

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<ComputeLabScenarioName>).detail;
      if (typeof next === "string") setScenario(next);
    };
    window.addEventListener(COMPUTE_LAB_SCENARIO_EVENT, onChange);
    return () => window.removeEventListener(COMPUTE_LAB_SCENARIO_EVENT, onChange);
  }, []);

  const fixture = useMemo(() => computeLabFixture(scenario), [scenario]);
  return <ScientComputeSessionPanel fixture={fixture} />;
}
