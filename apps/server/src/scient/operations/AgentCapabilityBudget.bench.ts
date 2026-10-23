import { expect, it } from "vite-plus/test";

import { prepareScientSkillTurn } from "../skills/ScientSkillInvocation.ts";
import { capabilityBudgetFixture } from "./AgentCapabilityBudget.testkit.ts";

it.for([28, 100, 500])("measures orientation of %i skill entries", async (count, { bench }) => {
  const fixture = capabilityBudgetFixture(count);
  const ordinary = prepareScientSkillTurn(
    "Explain this function.",
    fixture.skills,
    fixture.releases,
  );
  const rareName = fixture.skills.at(-1)!.name;
  prepareScientSkillTurn(
    `Use $${rareName} for this task.`,
    fixture.skills.map((skill) =>
      skill.name === rareName ? { ...skill, invocationPolicy: "explicit" as const } : skill,
    ),
    fixture.releases,
    undefined,
    [rareName],
  );
  let invocations = 0;
  const prepare = () => {
    invocations++;
    return prepareScientSkillTurn("Explain this function.", fixture.skills, fixture.releases);
  };
  const initial = await bench("initial ordinary skill turn", { async: false }, prepare).run({
    time: 0,
    iterations: 1,
    warmup: false,
    retainSamples: true,
  });
  const measured = await bench("prepare ordinary skill turn", { async: false }, prepare).run({
    time: 0,
    iterations: 100,
    warmup: false,
    retainSamples: true,
  });
  const samples = measured.latency.samples!.slice();
  expect(invocations).toBe(101);
  expect(initial.latency.samples).toHaveLength(1);
  expect(samples).toHaveLength(100);
  const initialMeasuredMs = initial.latency.samples![0]!;
  samples.sort((a, b) => a - b);
  process.stdout.write(
    `${JSON.stringify({
      fixture: "skill-orientation",
      count,
      providerInputBytes: Buffer.byteLength(ordinary.input!),
      automaticOrientationBytes: 0,
      initialMeasuredMs,
      p50Ms: samples[49],
      p95Ms: samples[94],
    })}\n`,
  );
});
