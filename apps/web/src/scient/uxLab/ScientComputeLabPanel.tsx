import { useEffect, useMemo, useState } from "react";

import { computeExperienceFixture } from "./computeExperienceFixtures";
import { ScientComputeSessionPanel } from "./ScientComputeSessionPanel";
import {
  COMPUTE_LAB_SCENARIO_EVENT,
  readComputeLabScenario,
  type ComputeLabScenarioName,
} from "./state";

/**
 * The one seam between lab state and the design.
 *
 * `ScientComputeSessionPanel` takes a fixture and nothing else, so Phase 4 can
 * adopt it by replacing this file with a hook over real session state. Keeping
 * the scenario subscription here rather than inside the panel is what makes that
 * swap a one-file change.
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

  const fixture = useMemo(() => computeExperienceFixture(scenario), [scenario]);

  return <ScientComputeSessionPanel fixture={fixture} />;
}
