// @effect-diagnostics nodeBuiltinImport:off -- This contract test reads a repository workflow file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { MANAGED_RUNTIME_CATALOG_PROVIDERS } from "@scientfactory/provider-runtime";

function workflow(name: string) {
  return parse(
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "../.github/workflows", name), "utf8"),
  );
}

const repositoryRoot = NodePath.join(import.meta.dirname, "..");

/**
 * The publication guards (`if [condition &&] ! git diff --quiet A B -- ...`),
 * each with the shell condition it runs under and its pathspecs as git reads
 * them: a plain path covers the file or the whole folder, and a quoted
 * `:(glob)` pattern matches with `*` staying inside one folder.
 */
function publicationGuards() {
  const text = NodeFS.readFileSync(
    NodePath.join(repositoryRoot, ".github/workflows/managed-provider-runtime-update-provider.yml"),
    "utf8",
  );
  return [
    ...text.matchAll(
      /if (?:(\[\[[^\n]*?\]\]) && )?! git diff --quiet "\$SOURCE_SHA" refs\/remotes\/origin\/main -- \\\n([\s\S]*?); then/gu,
    ),
  ].map((match) => ({
    condition: match[1],
    pathspecs: match[2]!
      .split("\n")
      .map((line) => line.replace(/\\$/u, "").trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        // A pattern must be quoted, or the shell expands it against the old checkout
        // and a file added on main since is never compared.
        if (/[*?[]/u.test(line)) expect(line, line).toMatch(/^':\(glob\)[^']+'$/u);
        return line.replace(/^'(.*)'$/u, "$1");
      }),
  }));
}

const GLOB_MAGIC = ":(glob)";
const globPattern = (pathspec: string) =>
  new RegExp(
    `^${pathspec
      .slice(GLOB_MAGIC.length)
      .split("**/")
      .map((part) =>
        part
          .split("*")
          .map((literal) => literal.replace(/[.+^${}()|[\]\\?]/gu, "\\$&"))
          .join("[^/]*"),
      )
      .join("(?:.*/)?")}$`,
    "u",
  );

function pathspecCovers(pathspec: string, path: string): boolean {
  return pathspec.startsWith(GLOB_MAGIC)
    ? globPattern(pathspec).test(path)
    : path === pathspec || path.startsWith(`${pathspec}/`);
}

function pathspecMatchesSomething(pathspec: string): boolean {
  if (!pathspec.startsWith(GLOB_MAGIC)) {
    return NodeFS.existsSync(NodePath.join(repositoryRoot, pathspec));
  }
  // Patterns here name files of one folder.
  const folder = NodePath.dirname(pathspec.slice(GLOB_MAGIC.length));
  return NodeFS.readdirSync(NodePath.join(repositoryRoot, folder)).some((name) =>
    pathspecCovers(pathspec, `${folder}/${name}`),
  );
}

/**
 * What the given suites load when they run, from their import graph: static
 * imports, re-exports and literal dynamic imports that carry values (a
 * type-only import loads nothing). Relative imports are followed file by file.
 * An import of a workspace package counts as the package's folder, plus the
 * workspace packages it declares as dependencies. Each entry maps to one
 * importer, for the failure message.
 */
function qualificationInputs(roots: ReadonlyArray<string>) {
  const workspacePackages = new Map<
    string,
    { readonly folder: string; readonly dependencies: ReadonlyArray<string> }
  >();
  for (const parent of ["apps", "packages"]) {
    for (const name of NodeFS.readdirSync(NodePath.join(repositoryRoot, parent))) {
      const manifestPath = NodePath.join(repositoryRoot, parent, name, "package.json");
      if (!NodeFS.existsSync(manifestPath)) continue;
      const manifest = parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
        readonly name?: string;
        readonly dependencies?: Record<string, string>;
        readonly peerDependencies?: Record<string, string>;
      };
      if (manifest.name === undefined) continue;
      workspacePackages.set(manifest.name, {
        folder: `${parent}/${name}`,
        dependencies: Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })
          .filter(([, version]) => version.startsWith("workspace:"))
          .map(([dependency]) => dependency),
      });
    }
  }
  const imports =
    /(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu;
  const modules = new Map<string, string>();
  const packages = new Map<string, string>();
  const addPackage = (name: string, importer: string) => {
    const workspacePackage = workspacePackages.get(name);
    if (workspacePackage === undefined || packages.has(workspacePackage.folder)) return;
    packages.set(workspacePackage.folder, importer);
    for (const dependency of workspacePackage.dependencies) addPackage(dependency, name);
  };
  const addModule = (path: string, importer: string) => {
    if (modules.has(path)) return;
    modules.set(path, importer);
    if (!/\.tsx?$/u.test(path)) return;
    const source = NodeFS.readFileSync(NodePath.join(repositoryRoot, path), "utf8");
    for (const match of source.matchAll(imports)) {
      const specifier = match[2] ?? match[3]!;
      if (match[1] !== undefined) continue;
      if (!specifier.startsWith(".")) {
        const [scope, name] = specifier.split("/");
        addPackage(specifier.startsWith("@") ? `${scope}/${name}` : scope!, path);
        continue;
      }
      const target = NodePath.join(NodePath.dirname(path), specifier);
      const resolved = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`].find(
        (candidate) => {
          const absolute = NodePath.join(repositoryRoot, candidate);
          return NodeFS.existsSync(absolute) && NodeFS.statSync(absolute).isFile();
        },
      );
      // An import written inside a string (a fixture's source) names no file here.
      if (resolved !== undefined) addModule(resolved, path);
    }
  };
  for (const root of roots) addModule(root, "the qualification");
  return { modules, packages };
}

describe("managed provider runtime update workflow", () => {
  it("lets sibling families finish and queues every serialized publication", () => {
    const caller = workflow("managed-provider-runtime-updates.yml");
    const reusable = workflow("managed-provider-runtime-update-provider.yml");
    expect(caller.jobs.provider.strategy["fail-fast"]).toBe(false);
    expect(reusable.jobs.qualify.strategy["fail-fast"]).toBe(false);
    expect(reusable.jobs.qualify.needs).toBe("discover");
    expect(reusable.jobs.publish.needs).toEqual(["discover", "qualify"]);
    expect(caller.concurrency).toMatchObject({ "cancel-in-progress": false, queue: "max" });
    expect(reusable.jobs.publish.concurrency).toMatchObject({
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  it("guards the ACP qualification import graph without invalidating sibling families", () => {
    const guards = publicationGuards();
    const guarded = guards
      .filter(
        (guard) =>
          guard.condition === undefined ||
          guard.condition === '[[ "$PROVIDER" == antigravityAcp ]]',
      )
      .flatMap((guard) => guard.pathspecs);
    const inputs = qualificationInputs(["apps/server/scripts/qualify-antigravity-acp-catalog.ts"]);
    const unguarded = [...inputs.modules, ...inputs.packages]
      .filter(([path]) => !guarded.some((pathspec) => pathspecCovers(pathspec, path)))
      .map(([path, importer]) => `${path} (imported by ${importer})`);
    expect(unguarded).toEqual([]);
    expect(guards.find((guard) => guard.condition === undefined)?.pathspecs).not.toContain(
      "apps/server/src/provider/acp",
    );
  });

  it("checks exactly the app-approved release families in both dispatch and the schedule", () => {
    const caller = workflow("managed-provider-runtime-updates.yml");
    expect(caller.on.workflow_dispatch.inputs.provider.options).toEqual([
      "all",
      ...MANAGED_RUNTIME_CATALOG_PROVIDERS,
    ]);
    const defaultMatrix = /\|\|\s*'(\[[^']+\])'/u.exec(
      caller.jobs.provider.strategy.matrix.provider,
    )?.[1];
    expect(defaultMatrix).toBeDefined();
    expect(JSON.parse(defaultMatrix!)).toEqual(MANAGED_RUNTIME_CATALOG_PROVIDERS);
  });

  it("keeps ACP on its own native installer and uses the provisioned package manager", () => {
    const caller = workflow("managed-provider-runtime-updates.yml");
    const reusable = workflow("managed-provider-runtime-update-provider.yml");
    expect(caller.on.workflow_dispatch.inputs.provider.options).toContain("antigravityAcp");
    expect(caller.jobs.provider.strategy.matrix.provider).toContain('"antigravityAcp"');
    const steps = reusable.jobs.qualify.steps;
    expect(
      steps.find((step: { run?: string }) =>
        step.run?.includes("node scripts/qualify-managed-runtime-catalog.ts"),
      ).if,
    ).toBe("inputs.provider != 'antigravityAcp'");
    const deps = steps.find(
      (step: { name: string }) => step.name === "Install official ACP qualification dependencies",
    );
    expect(deps.if).toBe("inputs.provider == 'antigravityAcp'");
    expect(deps.run).toBe("vp install --frozen-lockfile --filter=t3...");
    expect(
      steps.find((step: { run?: string }) =>
        step.run?.includes("node apps/server/scripts/qualify-antigravity-acp-catalog.ts"),
      ).if,
    ).toBe("inputs.provider == 'antigravityAcp'");
    expect(reusable.env.CATALOG_PATH).toContain("/managed-runtime-catalog.json");
    expect(reusable.env.BUNDLED_CATALOG_PATH).toContain("/bundled-managed-runtime-catalog.json");
  });

  it("gives GitHub CLI the least-privilege release app token during publication", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(
        import.meta.dirname,
        "../.github/workflows/managed-provider-runtime-update-provider.yml",
      ),
      "utf8",
    );
    const publishStep =
      workflow
        .split("      - name: Merge and publish the qualified provider\n")[1]
        ?.split(/^      - name:/mu)[0] ?? "";

    expect(publishStep).toContain("GH_TOKEN: ${{ steps.app-token.outputs.token }}");
    expect(publishStep).toContain('gh api "/users/${APP_SLUG}[bot]"');
  });

  it("keeps feature-branch qualification read-only and pins the caller's exact source", () => {
    const caller = workflow("managed-provider-runtime-updates.yml");
    const reusable = workflow("managed-provider-runtime-update-provider.yml");
    expect(caller.jobs.provider.with.publish).toBe(
      "${{ github.ref == 'refs/heads/main' && !inputs.qualify_only }}",
    );
    expect(reusable.on.workflow_call.inputs.publish.default).toBe(false);
    expect(reusable.permissions).toEqual({ contents: "read" });
    expect(reusable.jobs.publish.if).toBe(
      "inputs.publish && github.ref == 'refs/heads/main' && needs.discover.outputs.changed == 'true' && needs.qualify.result == 'success'",
    );
    expect(reusable.jobs.discover.steps[0].with.ref).toBe(
      "${{ inputs.publish && github.ref == 'refs/heads/main' && 'main' || github.sha }}",
    );
    expect(reusable.jobs.qualify.steps[0].with.ref).toBe(
      "${{ needs.discover.outputs.source_sha }}",
    );
    expect(
      reusable.jobs.discover.steps.some((step: { uses?: string }) =>
        step.uses?.includes("create-github-app-token"),
      ),
    ).toBe(false);
    expect(
      reusable.jobs.qualify.steps.some((step: { uses?: string }) =>
        step.uses?.includes("create-github-app-token"),
      ),
    ).toBe(false);
  });

  it("requalifies unchanged candidates and requires every Windows stress cycle to pass", () => {
    const reusable = workflow("managed-provider-runtime-update-provider.yml");
    const upload = reusable.jobs.discover.steps.find(
      (step: { name: string }) => step.name === "Upload immutable candidate",
    );
    expect(upload.if).toBe(
      "steps.catalog.outputs.available == 'true' && (steps.catalog.outputs.changed == 'true' || !inputs.publish)",
    );
    expect(reusable.jobs.qualify.if).toBe(
      "needs.discover.outputs.available == 'true' && (needs.discover.outputs.changed == 'true' || !inputs.publish)",
    );
    expect(reusable.jobs.discover.outputs.available).toBe("${{ steps.catalog.outputs.available }}");
    const exercise = reusable.jobs.qualify.steps.find(
      (step: { name: string }) =>
        step.name === "Exercise download, verification, smoke, activation, and removal",
    );
    expect(exercise.env.QUALIFICATION_RUNS).toBe(
      "${{ !inputs.publish && runner.os == 'Windows' && '5' || '1' }}",
    );
    expect(exercise.run).toContain("set -euo pipefail");
    expect(exercise.run).toContain("args+=(--repair)");
    expect(exercise.run).toContain("attempt <= QUALIFICATION_RUNS");
  });

  it("qualifies Scient on every platform its release carries, with the isolated app activation code", () => {
    const reusable = workflow("managed-provider-runtime-update-provider.yml");
    // Scient takes the full six-runner matrix: one runner per release binary.
    expect(reusable.jobs.qualify.strategy.matrix.runner).not.toContain(
      "inputs.provider == 'scient'",
    );
    expect(reusable.jobs.qualify.strategy.matrix.runner).toContain(
      '\'["macos-26","macos-15-intel","ubuntu-24.04","ubuntu-24.04-arm","windows-2025","windows-11-arm"]\'',
    );
    const dependencies = reusable.jobs.qualify.steps.find(
      (step: { name: string }) => step.name === "Install RPC qualification dependencies",
    );
    expect(dependencies.if).toBe("inputs.provider == 'omp' || inputs.provider == 'scient'");
    const script = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "qualify-managed-runtime-catalog.ts"),
      "utf8",
    );
    expect(script).toContain("apps/server/scripts/qualifyScientAgentManagedRuntime.ts");
    expect(script).toContain('SCIENT_AGENT_ROOT: NodePath.join(home, "scient-agent")');
    expect(script).toContain('verifyRpc("scient", executablePath, installed.version, signal)');
    expect(script).toContain("...qualification");
  });

  it("invalidates Scient publication when any of its qualification inputs changes", () => {
    const guarded = publicationGuards()
      .filter(
        (guard) =>
          guard.condition === undefined || guard.condition === '[[ "$PROVIDER" == scient ]]',
      )
      .flatMap((guard) => guard.pathspecs);
    const inputs = qualificationInputs([
      "apps/server/scripts/qualifyScientAgentManagedRuntime.ts",
      "apps/server/src/scient/providerLifecycle/ScientAgentManagedRuntimeActions.ts",
    ]);
    expect(inputs.modules.size).toBeGreaterThan(2);
    const unguarded = [...inputs.modules, ...inputs.packages]
      .filter(([path]) => !guarded.some((pathspec) => pathspecCovers(pathspec, path)))
      .map(([path, importer]) => `${path} (imported by ${importer})`);
    expect(unguarded).toEqual([]);
  });

  it("proves Droid's protocol once against the candidate binary where its fixtures are verified", () => {
    const reusable = workflow("managed-provider-runtime-update-provider.yml");
    const dependencies = reusable.jobs.qualify.steps.find(
      (step: { name: string }) => step.name === "Install Droid protocol qualification dependencies",
    );
    // The live fixtures drive POSIX shells and a private HOME; they are verified on macOS.
    expect(dependencies.if).toBe("inputs.provider == 'droid' && runner.os == 'macOS'");
    expect(dependencies.run).toBe("vp install --frozen-lockfile --ignore-scripts --filter=t3...");
    const exercise = reusable.jobs.qualify.steps.find(
      (step: { name: string }) =>
        step.name === "Exercise download, verification, smoke, activation, and removal",
    );
    expect(exercise.run).toContain(
      'if [[ "$PROVIDER" == droid && "$attempt" == 1 && "$RUNNER_OS" == macOS ]]; then args+=(--droid-live-tests); fi',
    );
    // The protocol suites and the binary they run must be the qualified ones.
    const script = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "qualify-managed-runtime-catalog.ts"),
      "utf8",
    );
    for (const suite of [
      "DroidRuntime",
      "DroidReasoning",
      "DroidProviderStatus",
      "DroidBackgroundGeneration",
      "DroidKeyIsolation",
      "DroidRequestLimits",
    ]) {
      expect(script).toContain(`apps/server/src/provider/droid/${suite}.live.test.ts`);
      expect(
        NodeFS.existsSync(
          NodePath.join(
            import.meta.dirname,
            `../apps/server/src/provider/droid/${suite}.live.test.ts`,
          ),
        ),
      ).toBe(true);
    }
    expect(script).toContain("SCIENT_DROID_TEST_BINARY: binary");
    expect(script).toContain("SCIENT_DROID_TEST_VERSION: version");
    expect(script).toContain("--droid-live-tests is valid only for Droid qualification.");
  });

  it("voids every provider's publication only for what its own qualification runs", () => {
    const [everyProvider, acp, droid, scient, ...others] = publicationGuards();
    expect(others).toEqual([]);
    // Discovery, artifact qualification and publication: the same for every provider.
    expect(everyProvider).toEqual({
      condition: undefined,
      pathspecs: [
        ".github/workflows/managed-provider-runtime-update-provider.yml",
        "apps/server/src/scient/providerLifecycle/ManagedRuntimeCatalog.ts",
        "apps/server/src/scient/providerLifecycle/bundled-managed-runtime-catalog.json",
        "packages/scient-provider-runtime",
        "packages/shared",
        "pnpm-lock.yaml",
        "scripts/package.json",
        "scripts/lib/managed-runtime-catalog.ts",
        "scripts/lib/antigravity-acp-artifact.ts",
        "scripts/promote-managed-runtime-catalog.ts",
        "scripts/qualify-managed-runtime-catalog.ts",
        "scripts/update-managed-runtime-catalog.ts",
      ],
    });
    expect(acp?.condition).toBe('[[ "$PROVIDER" == antigravityAcp ]]');
    expect(acp?.pathspecs).toContain("apps/server/src/provider/AntigravityInstallation.ts");
    // Each server qualifier invalidates its own family.
    expect(droid?.condition).toBe('[[ "$PROVIDER" == droid ]]');
    expect(scient?.condition).toBe('[[ "$PROVIDER" == scient ]]');
  });

  it("republishes nothing when what Droid's protocol qualification runs changed on main meanwhile", () => {
    const guarded = publicationGuards().flatMap((guard) => guard.pathspecs);
    expect(guarded.length).toBeGreaterThan(0);
    // A renamed path or a pattern that matches nothing would silently stop guarding anything.
    for (const pathspec of guarded) {
      expect(pathspecMatchesSomething(pathspec), pathspec).toBe(true);
    }
    // The six suites the qualification runs are the roots of what it executes.
    const script = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "qualify-managed-runtime-catalog.ts"),
      "utf8",
    );
    const suites = [
      ...script.matchAll(/"(apps\/server\/src\/provider\/droid\/[^"]+\.live\.test\.ts)"/gu),
    ].map((match) => match[1]!);
    expect(suites).toHaveLength(6);

    // Every module the suites load, however indirectly, must void a run when it
    // changes: the server modules file by file, the workspace packages by folder.
    const inputs = qualificationInputs(suites);
    expect(inputs.modules.size).toBeGreaterThan(suites.length);
    const unguarded = [...inputs.modules, ...inputs.packages]
      .filter(([path]) => !guarded.some((pathspec) => pathspecCovers(pathspec, path)))
      .map(([path, importer]) => `${path} (imported by ${importer})`);
    expect(unguarded).toEqual([]);
    expect(guarded).toContain("scripts/qualify-managed-runtime-catalog.ts");
  });

  it("qualifies Pi on every official native target and proves its live integration once", () => {
    const reusable = workflow("managed-provider-runtime-update-provider.yml");
    const runners = reusable.jobs.qualify.strategy.matrix.runner as string;
    expect(runners).not.toContain("inputs.provider == 'pi'");
    expect(runners).toContain(
      '["macos-26","macos-15-intel","ubuntu-24.04","ubuntu-24.04-arm","windows-2025","windows-11-arm"]',
    );
    const dependencies = reusable.jobs.qualify.steps.find(
      (step: { name: string }) => step.name === "Install Pi integration qualification dependencies",
    );
    expect(dependencies.if).toBe("inputs.provider == 'pi'");
    expect(dependencies.run).toBe("vp install --frozen-lockfile --ignore-scripts --filter=t3...");
    const exercise = reusable.jobs.qualify.steps.find(
      (step: { name: string }) =>
        step.name === "Exercise download, verification, smoke, activation, and removal",
    );
    expect(exercise.run).toContain(
      'if [[ "$PROVIDER" == pi && "$attempt" == 1 ]]; then args+=(--pi-live-tests); fi',
    );
  });
});
