// @effect-diagnostics nodeBuiltinImport:off -- workflow contract tests read checked-in YAML only.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "@effect/vitest";
import * as YAML from "yaml";

import { PROOFS, summarize } from "../.github/scripts/compute-roles.mjs";

const workflow = (name: string): unknown =>
  YAML.parse(NodeFS.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));

describe("Compute CI suite selection", () => {
  it("keeps both suites enabled by default for release callers and manual runs", () => {
    expect(workflow("scient-compute-python-kernel.yml")).toMatchObject({
      on: {
        workflow_call: {
          inputs: {
            real_kernel: { type: "boolean", default: true },
            managed_python: { type: "boolean", default: true },
            python_product: { type: "boolean", default: false },
            platforms: { type: "string", default: "all" },
          },
        },
        workflow_dispatch: {
          inputs: {
            real_kernel: { type: "boolean", default: true },
            managed_python: { type: "boolean", default: true },
          },
        },
      },
      jobs: {
        real_kernel: { if: "${{ inputs.real_kernel || inputs.python_product }}" },
        managed_python: { if: "${{ inputs.managed_python }}" },
      },
    });
  });

  it("wires each suite independently and skips it only on an explicit false", () => {
    expect(workflow("ci.yml")).toMatchObject({
      jobs: {
        changes: {
          outputs: {
            compute_changed:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'true' || steps.compute.outputs.changed }}",
            real_kernel:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'true' || steps.compute.outputs.real_kernel }}",
            managed_python:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'true' || steps.compute.outputs.managed_python }}",
            python_product:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'true' || steps.compute.outputs.python_product }}",
            compute_platforms:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'all' || steps.compute.outputs.platforms }}",
          },
        },
        compute_native: {
          needs: ["queue_ci", "changes"],
          if: "${{ !cancelled() && needs.queue_ci.outputs.reused != 'true' && needs.changes.outputs.compute_changed != 'false' }}",
          uses: "./.github/workflows/scient-compute-python-kernel.yml",
          with: {
            real_kernel: "${{ needs.changes.outputs.real_kernel != 'false' }}",
            managed_python: "${{ needs.changes.outputs.managed_python != 'false' }}",
            python_product: "${{ needs.changes.outputs.python_product != 'false' }}",
            platforms:
              "${{ needs.changes.outputs.compute_platforms == 'linux' && 'linux' || 'all' }}",
          },
        },
        check: {
          name: "Check",
          needs: expect.arrayContaining(["test", "changes", "compute_native"]),
          if: "${{ always() }}",
        },
      },
    });
  });

  type Step = {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
    "working-directory"?: string;
  };
  type Job = {
    if?: string;
    strategy: { matrix: { runner?: string; include?: string | Array<Record<string, unknown>> } };
    steps: Array<Step>;
  };
  const jobs = (workflow("scient-compute-python-kernel.yml") as { jobs: Record<string, Job> }).jobs;
  // Each value is one `${{ ... }}` expression; these use only ==, &&, ||, !, fromJSON, format and
  // cancelled() (false: these are runs nobody cancelled).
  const evaluate = (expression: string, context: object) =>
    NodeVM.runInNewContext(expression.slice(3, -2), {
      fromJSON: JSON.parse,
      format: (template: string, ...args: Array<string>) =>
        template.replace(/\{(\d+)\}/g, (_, i: string) => args[Number(i)]!),
      cancelled: () => false,
      ...context,
    });
  const all = ["ubuntu-24.04", "macos-15", "macos-15-intel", "windows-2025"];
  const legsOf = (id: string, inputs: object): Array<Record<string, unknown>> => {
    const job = jobs[id]!;
    if (job.if && !evaluate(job.if, { inputs })) return [];
    const { runner, include } = job.strategy.matrix;
    if (runner !== undefined)
      return (evaluate(runner, { inputs }) as Array<string>).map((name) => ({ runner: name }));
    return typeof include === "string" ? evaluate(include, { inputs }) : include!;
  };
  const words = (value: string) => value.split(" ").filter(Boolean);
  // A Mac leg's toJSON(steps) when every step that starts succeeds, after setup succeeded, and the
  // roles its summary requires.
  const runMac = (inputs: object, leg: object, steps = jobs.macos!.steps) => {
    const outcomes: Record<string, { outcome: string }> = { vp: { outcome: "success" } };
    for (const step of steps.slice(steps.findIndex((candidate) => candidate.id === "vp") + 2)) {
      const ran = evaluate(step.if!, { inputs, matrix: leg, steps: outcomes });
      if (step.id) outcomes[step.id] = { outcome: ran ? "success" : "skipped" };
    }
    const expected = words(evaluate(steps.at(-1)!.env!.EXPECTED!, { inputs, matrix: leg }));
    return { outcomes, expected, results: summarize(expected, outcomes) };
  };
  const os: Record<string, string> = {
    "ubuntu-24.04": "Linux",
    "macos-15": "macOS",
    "macos-15-intel": "macOS",
    "windows-2025": "Windows",
  };
  const runs = (id: string, name: string, inputs: object, leg: Record<string, unknown>) =>
    evaluate(jobs[id]!.steps.find((step) => step.name === name)!.if!, {
      inputs,
      matrix: leg,
      runner: { os: os[leg.runner as string] },
    }) as boolean;
  // Which runners run each proof, and with which parts, across every job; a proof that runs twice
  // on one runner lists its part twice.
  const coverage = (inputs: Record<string, unknown>, macLegs = legsOf("macos", inputs)) => {
    const runners: Record<string, Map<string, Array<string>>> = {};
    const add = (proof: string, runner: string, part: string) => {
      const byRunner = (runners[proof] ??= new Map());
      byRunner.set(runner, [...(byRunner.get(runner) ?? []), part].toSorted());
    };
    for (const leg of legsOf("managed_python", inputs)) add("managed", leg.runner as string, "all");
    for (const leg of legsOf("real_kernel", inputs)) {
      const parts = ["3.10", "3.12"].filter((version) =>
        runs(
          "real_kernel",
          `Run the real-kernel integration suite on Python ${version}`,
          inputs,
          leg,
        ),
      );
      if (runs("real_kernel", "Run the Compute product case on Python 3.12", inputs, leg))
        parts.push("product");
      expect(parts, `real_kernel ${String(leg.runner)} runs nothing`).not.toEqual([]);
      for (const part of parts)
        add(part === "product" ? "product" : "kernel", leg.runner as string, part);
    }
    for (const leg of legsOf("real_languages", inputs))
      add("languages", leg.runner as string, "all");
    for (const leg of macLegs) {
      const { outcomes, expected, results } = runMac(inputs, leg);
      const runner = leg.runner as string;
      expect(expected, `${runner} starts with nothing to prove`).not.toEqual([]);
      // Exactly the roles its summary requires began, and each ran all its proofs.
      expect(
        Object.keys(PROOFS).filter((role) => outcomes[role]!.outcome === "success"),
        runner,
      ).toEqual(expected);
      expect(
        results.filter((result) => !result.ran),
        runner,
      ).toEqual([]);
      for (const role of expected) {
        if (role === "managed") add("managed", runner, "all");
        else if (role === "python")
          for (const part of ["3.10", "3.12"]) add("kernel", runner, part);
        else add("languages", runner, role);
      }
    }
    return runners;
  };

  // A proof split into legs must give every runner the whole proof once: one leg that runs all of
  // it, or one leg per part.
  const whole: Record<string, Array<Array<string>>> = {
    managed: [["all"]],
    kernel: [["3.10", "3.12"]],
    languages: [["all"], ["files", "kernels", "people"]],
    product: [["product"]],
  };
  const runnersOf = (inputs: Record<string, unknown>, macLegs?: Array<Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(coverage(inputs, macLegs)).map(([proof, byRunner]) => {
        for (const [runner, parts] of byRunner)
          expect(whole[proof], `${proof} ${runner}`).toContainEqual(parts);
        return [proof, [...byRunner.keys()].toSorted((a, b) => all.indexOf(a) - all.indexOf(b))];
      }),
    );
  type Inputs = {
    real_kernel: boolean;
    managed_python: boolean;
    python_product?: boolean | undefined;
    platforms?: string | undefined;
  };
  // The runners each proof the inputs select must run on.
  const selected = ({ real_kernel, managed_python, python_product, platforms }: Inputs) => {
    const on = (proof: boolean) =>
      proof ? (platforms === "linux" ? ["ubuntu-24.04"] : all) : undefined;
    return Object.fromEntries(
      Object.entries({
        managed: on(managed_python),
        kernel: on(real_kernel),
        languages: on(real_kernel),
        product: real_kernel || python_product ? ["ubuntu-24.04"] : undefined,
      }).filter(([, runners]) => runners !== undefined),
    );
  };

  it("runs each selected proof once on every computer asked for, and nothing else", () => {
    // Manual dispatch has neither python_product nor platforms.
    for (const real_kernel of [true, false])
      for (const managed_python of [true, false])
        for (const python_product of [true, false, undefined])
          for (const platforms of ["all", "linux", undefined]) {
            const inputs = { real_kernel, managed_python, python_product, platforms };
            expect(runnersOf(inputs), JSON.stringify(inputs)).toEqual(selected(inputs));
          }
    // Only the product case changed: one Linux leg on the interpreter its step uses.
    for (const platforms of ["linux", "all"]) {
      const inputs = { real_kernel: false, managed_python: false, python_product: true, platforms };
      expect(legsOf("real_kernel", inputs)).toEqual([{ runner: "ubuntu-24.04", python: "3.12" }]);
      expect(legsOf("macos", inputs)).toEqual([]);
    }
    const target = jobs.managed_python!.steps.find((step) => step.env?.EXPECTED_TARGET)!.env!
      .EXPECTED_TARGET!;
    expect(all.map((runner) => evaluate(target, { matrix: { runner } }))).toEqual([
      "linux-x64",
      "darwin-arm64",
      "darwin-x64",
      "win32-x64",
    ]);
    const both = { real_kernel: true, managed_python: true, platforms: "all" };
    for (const leg of legsOf("macos", both))
      expect(leg.target, String(leg.runner)).toBe(evaluate(target, { matrix: leg }));
  });

  it("finds an Intel proof whose leg is missing or listed twice, or whose step did not run", () => {
    const both = { real_kernel: true, managed_python: true, platforms: "all" };
    const [apple, managed, python] = legsOf("macos", both);
    const intel = all.filter((runner) => runner !== "macos-15-intel");
    expect(runnersOf(both, [apple!, managed!])).toEqual({ ...selected(both), kernel: intel });
    expect(runnersOf(both, [apple!, python!])).toEqual({ ...selected(both), managed: intel });
    expect(() => runnersOf(both, [apple!, managed!, managed!, python!])).toThrow();
    for (const [leg, role] of [
      [managed, "managed"],
      [python, "python"],
    ] as const) {
      const last = PROOFS[role]!.at(-1);
      const steps = jobs.macos!.steps.map((step) =>
        step.id === last ? { ...step, if: "${{ false }}" } : step,
      );
      expect(runMac(both, leg!, steps).results.map(({ ran, missing }) => [ran, missing])).toEqual([
        [false, [last]],
      ]);
    }
  });

  // Each role is its begin step, exactly the proofs compute-roles.mjs requires of it and its end
  // step; every proof runs once the role began, whatever an earlier role did.
  const expectRoles = (steps: Array<Step>, roles: Array<string>) => {
    for (const role of roles) {
      const begin = steps.findIndex((step) => step.id === role);
      const finish = steps.findIndex((step) => step.id === `end-${role}`);
      expect(steps[begin]!.run).toMatch(new RegExp(`compute-roles\\.mjs begin ${role}\\b`));
      expect(steps[begin]!.if).toMatch(/^\$\{\{ !cancelled\(\) && steps\.vp\.outcome == 'success'/);
      expect(steps[finish]!.run).toMatch(new RegExp(`compute-roles\\.mjs end ${role}\\b`));
      expect(steps[finish]!.if).toBe(`\${{ !cancelled() && steps.${role}.outcome != 'skipped' }}`);
      const own = steps.slice(begin + 1, finish);
      expect(
        own.map((step) => step.id),
        role,
      ).toEqual(PROOFS[role]);
      for (const step of own) {
        expect(step.if, step.name).toBe(
          `\${{ !cancelled() && steps.${role}.outcome == 'success' }}`,
        );
      }
    }
    // Every step after setup runs whatever an earlier one did, so no proof is skipped after a
    // failure (ci-quarantine.cjs then reads a skipped step as one whose own condition was false).
    const setup = steps.findIndex((step) => step.id === "vp");
    for (const step of steps.slice(setup + 2))
      expect(step.if, step.name).toMatch(/^\$\{\{ !cancelled\(\)/);
    const summary = steps.at(-1)!;
    expect(summary.run).toBe("node .github/scripts/compute-roles.mjs summary");
    expect(summary.env!.STEPS).toBe("${{ toJSON(steps) }}");
    return summary;
  };

  // The plain Python the people role saved is checked after each R and Julia role; the bridge's
  // packages go into the kernel role's own environment.
  const expectPlainPython = (steps: Array<Step>) => {
    const step = (id: string) => steps.find((candidate) => candidate.id === id)!;
    expect(step("people").run).toBe(
      "node .github/scripts/compute-roles.mjs begin people --save-python bare",
    );
    for (const role of ["people", "files", "kernels"])
      expect(step(`end-${role}`).run).toBe(
        `node .github/scripts/compute-roles.mjs end ${role} --check-python bare`,
      );
    expect(step("kernels-install").run).toMatch(
      /^node \.github\/scripts\/compute-roles\.mjs venv kernels /,
    );
    expect(step("kernels-run").env!.SCIENT_TEST_PYTHON).toBe(
      "${{ steps.kernels-install.outputs.python }}",
    );
    for (const candidate of steps)
      expect(candidate.run ?? "", candidate.name).not.toMatch(/restore-python/);
  };

  it("runs each computer's R and Julia proofs in one job, each from a clean start", () => {
    const steps = jobs.real_languages!.steps;
    expect(expectRoles(steps, ["people", "files", "kernels"]).env!.EXPECTED).toBe(
      "people files kernels",
    );
    expectPlainPython(steps);
    const index = (id: string) => steps.findIndex((step) => step.id === id);
    const llvm = steps.findIndex((step) => step.run?.includes("match-windows-llvm.sh"));
    expect(llvm).toBeGreaterThan(-1);
    expect(llvm).toBeLessThan(index("people"));
  });

  it("runs on a Mac the same steps as each role's own job, one role after another", () => {
    const steps = jobs.macos!.steps;
    const source: Record<string, string> = {
      people: "real_languages",
      files: "real_languages",
      kernels: "real_languages",
      languages: "real_languages",
      managed: "managed_python",
      python: "real_kernel",
    };
    const roles = ["people", "files", "kernels", "managed", "python"];
    const same = (step: Step) => ({
      uses: step.uses,
      run: step.run,
      env: step.env,
      with: step.with,
      "working-directory": step["working-directory"],
    });
    // R and Julia's setup, then every proof each role requires: a proof deleted from the Mac job
    // fails here rather than leaving nothing to compare.
    const proofs = [
      "languages-python",
      "languages-r",
      "languages-julia",
      ...roles.flatMap((role) => PROOFS[role]!),
    ].map((id) => {
      const step = steps.find((candidate) => candidate.id === id);
      expect(step, id).toBeDefined();
      return step!;
    });
    expect(proofs.length).toBe(17);
    for (const step of proofs) {
      const role = step.id!.split("-")[0]!;
      const original = jobs[source[role]!]!.steps.find((other) => other.name === step.name);
      expect(original, step.name).toBeDefined();
      // The target comes from the leg here, from a runner map there (checked above).
      if (step.env?.EXPECTED_TARGET)
        expect({ ...same(step), env: undefined }).toEqual({ ...same(original!), env: undefined });
      else expect(same(step), step.name).toEqual(same(original!));
    }
    expectRoles(steps, roles);
    // The plain-Python proof runs before anything is installed into a Python, and the Python it
    // saved is checked unchanged before real Python reuses that interpreter.
    const index = (id: string) => steps.findIndex((step) => step.id === id);
    expect(index("people")).toBeLessThan(index("kernels-install"));
    expect(index("kernels-install")).toBeLessThan(index("python-install-312"));
    expectPlainPython(steps);
    // Managed Python runs between them, so its end checks that Python too whenever it was saved.
    const endManaged = steps[index("end-managed")]!.run!;
    const managedEnd = (people: string) =>
      endManaged.replace(/\$\{\{.*\}\}/, (expression) =>
        evaluate(expression, { steps: { people: { outcome: people } } }),
      );
    expect(managedEnd("success")).toBe(
      "node .github/scripts/compute-roles.mjs end managed --check-python bare",
    );
    for (const people of ["", "skipped", "failure"])
      expect(managedEnd(people), people).toBe(
        "node .github/scripts/compute-roles.mjs end managed ",
      );
    const expected = (inputs: object) =>
      legsOf("macos", inputs).map((leg) => runMac(inputs, leg).expected);
    expect(expected({ real_kernel: true, managed_python: true, platforms: "all" })).toEqual([
      ["people", "files", "kernels", "managed", "python"],
      ["managed"],
      ["python"],
    ]);
    expect(expected({ real_kernel: false, managed_python: true, platforms: "all" })).toEqual([
      ["managed"],
      ["managed"],
    ]);
    expect(expected({ real_kernel: true, managed_python: false, platforms: "all" })).toEqual([
      ["people", "files", "kernels", "python"],
      ["python"],
    ]);
  });

  it("runs the Compute product case on Linux 3.12 and the kernel suites only when asked", () => {
    expect(workflow("scient-compute-python-kernel.yml")).toMatchObject({
      jobs: {
        real_kernel: {
          steps: expect.arrayContaining([
            expect.objectContaining({
              name: "Run the real-kernel integration suite on Python 3.12",
              if: "${{ inputs.real_kernel && (matrix.python == 'both' || matrix.python == '3.12') }}",
            }),
            expect.objectContaining({
              name: "Run the Compute product case on Python 3.12",
              if: "${{ runner.os == 'Linux' && (matrix.python == 'both' || matrix.python == '3.12') }}",
              "working-directory": "apps/server",
              run: expect.stringContaining("src/scient/compute/ComputeProduct.integration.test.ts"),
            }),
          ]),
        },
      },
    });
  });

  it("qualifies recipes and the opted-in managed product in their respective lanes", () => {
    expect(workflow("scient-compute-python-kernel.yml")).toMatchObject({
      jobs: {
        managed_python: {
          steps: expect.arrayContaining([
            expect.objectContaining({
              name: "Qualify recipes",
              if: "${{ matrix.runner != 'windows-2025' }}",
              "working-directory": "apps/server",
              env: { SCIENT_TEST_MANAGED_PYTHON: "1", MPLBACKEND: "Agg" },
              run: "vp test run src/scient/compute/ComputeRecipe.live.test.ts --maxWorkers=1",
            }),
            expect.objectContaining({
              name: "Qualify base, every toolkit combination, and retained kernels",
              "working-directory": "apps/server",
              env: { SCIENT_TEST_MANAGED_PYTHON: "1", MPLBACKEND: "Agg" },
              run: "vp test bench --run src/scient/compute/ManagedPythonProduct.bench.ts --maxWorkers=1",
            }),
          ]),
        },
        // Windows, where managed_python is longest, qualifies recipes beside it.
        managed_recipes: {
          if: "${{ inputs.managed_python && inputs.platforms != 'linux' }}",
          "runs-on": "windows-2025",
          steps: expect.arrayContaining([
            expect.objectContaining({
              name: "Qualify recipes",
              "working-directory": "apps/server",
              env: { SCIENT_TEST_MANAGED_PYTHON: "1", MPLBACKEND: "Agg" },
              run: "vp test run src/scient/compute/ComputeRecipe.live.test.ts --maxWorkers=1",
            }),
          ]),
        },
      },
    });
  });
});
