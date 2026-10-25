// Decides which CI jobs a change needs. Prints `key=value` lines for
// $GITHUB_OUTPUT; a job runs unless its key is "false".
//
//   node ci-changes.cjs --paths <file>          gate by the listed paths
//   node ci-changes.cjs --paths0 <file>         gate by NUL-delimited Git paths
//   node ci-changes.cjs --paths <file> --full   run every job (main backstop)
//   node ci-changes.cjs                         changed paths unknown: run everything
//
// scripts/check-changed.ts requires the same decisions so local runs match CI.
//
// Every changed path maps to workspace packages, which then pull in their
// dependents from package.json. A path this file does not recognize runs
// everything, so a new root file or directory can only cost minutes.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

// Inert for package ownership and release smoke. Tests still run for these paths.
const INERT = [
  /^docs\//,
  /^\.(agents|cursor|vscode|devcontainer|macroscope|repos)\//,
  /^[^/]+\.md$/,
  /^LICENSE$/,
];

// Run everything: the root vite.config.ts loads the first as setup for every
// package's tests, and the vendored mobile tarballs are installed dependencies.
const RUNS_EVERYTHING = [
  /^packages\/shared\/src\/(HostProcess|testing\/longTempDir)\.ts$/,
  /^apps\/mobile\/deps\//,
];

// Paths outside a package, or files inside one that other packages read
// through relative imports rather than a package.json dependency.
const EXTRA_OWNERS = [
  // Vite configs and tsconfigs of these apps import scripts/lib directly.
  [/^scripts\/lib\//, ["@t3tools/desktop", "@t3tools/mobile", "@t3tools/web", "t3"]],
  // scripts/build-desktop-artifact.ts reads the GNOME extension manifest.
  [/^apps\/desktop\/gnome-extension\//, ["@t3tools/scripts"]],
  [/^native\/browser-secret\//, ["@t3tools/desktop"]],
  [/^native\/kde-snap-shot\//, ["@t3tools/desktop"]],
  [/^native\/libghostty-vt\//, ["@t3tools/web"]],
];
const RUST = /^native\/(resource-monitor|kde-snap-shot|hyprland-snap-shot)\//;
// SCIENT-FORK:START — Rust inputs outside the crates do not change release-smoke ownership.
const RUST_INPUT =
  /(?:^|\/)(?:[^/]+\.rs|Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?)$|(?:^|\/)\.cargo\//;
// SCIENT-FORK:END

// Declared dependencies that only feed a build step: the server bundles the
// built web app (apps/server/vite.config.ts) but never imports it.
const BUILD_ONLY_DEPS = { t3: ["@t3tools/web"] };

// Sources scripts/mobile-native-static-check.ts lints, plus the tool and rule
// configuration that decides how it lints them, plus the root package.json
// that defines the lint:mobile command.
const MOBILE_NATIVE =
  /^apps\/mobile\/[\s\S]*\.(swift|kt|kts)$|^apps\/mobile\/(\.swiftlint\.yml|detekt\.yml|\.editorconfig|Brewfile)$|^scripts\/mobile-native-static-check\.ts$|^package\.json$|^\.github\/workflows\/ci\.yml$|^\.github\/scripts\/ci-changes\.cjs$|^\.github\/actions\/ci-changes\//;

function readWorkspace() {
  const patterns = [];
  let inPackages = false;
  for (const line of fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
    if (/^\S/.test(line)) inPackages = line.startsWith("packages:");
    const entry = inPackages && line.match(/^\s+-\s+["']?([^"'\s]+)/);
    if (entry) patterns.push(entry[1]);
  }

  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return fs.readdirSync(path.join(root, parent)).map((name) => `${parent}/${name}`);
  });

  const packages = [];
  for (const dir of dirs) {
    const manifestPath = path.join(root, dir, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    packages.push({
      name: manifest.name,
      dir,
      hasTest: Boolean(manifest.scripts?.test),
      deps: Object.keys(deps).filter(
        (dep) =>
          String(deps[dep]).startsWith("workspace:") &&
          !BUILD_ONLY_DEPS[manifest.name]?.includes(dep),
      ),
    });
  }
  return packages;
}

// Returns the packages a path touches, [] for an inert path, or null when the
// path is not understood and everything must run.
function ownersOf(file, packages) {
  if (INERT.some((pattern) => pattern.test(file))) return [];
  // A manifest can change dependencies or versions other packages read.
  if (path.posix.basename(file) === "package.json") return null;
  if (RUNS_EVERYTHING.some((pattern) => pattern.test(file))) return null;
  const extra = EXTRA_OWNERS.flatMap(([pattern, names]) => (pattern.test(file) ? names : []));
  // scripts/build-desktop-artifact.test.ts reads the crates' sources.
  if (RUST.test(file)) return ["@t3tools/scripts", ...extra];

  const owner = packages
    .filter((pkg) => file.startsWith(`${pkg.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (owner) return [owner.name, ...extra];
  return extra.length > 0 ? extra : null;
}

function decide(files, packages, full) {
  const all = new Set(packages.map((pkg) => pkg.name));
  let affected = new Set();
  let everything = full || files === null;
  let rust = false;

  for (const file of files ?? []) {
    if (RUST.test(file) || RUST_INPUT.test(file)) rust = true;
    const owners = ownersOf(file, packages);
    if (owners === null) {
      everything = true;
      console.error(`Runs everything: ${file}`);
    } else {
      for (const owner of owners) affected.add(owner);
    }
  }

  // Release smoke reads scripts/ itself, not what the scripts tests read.
  let scriptsChanged = everything;
  if (everything) {
    affected = all;
  } else {
    // Add dependents until nothing changes.
    let grew = true;
    while (grew) {
      grew = false;
      for (const pkg of packages) {
        if (!affected.has(pkg.name) && pkg.deps.some((dep) => affected.has(dep))) {
          affected.add(pkg.name);
          grew = true;
        }
      }
    }
    scriptsChanged = affected.has("@t3tools/scripts");
  }

  return {
    affected: [...affected].sort(),
    outputs: {
      // SCIENT-FORK:START — test inputs extend beyond the package/import graph.
      // Keep upstream outputs for local tooling, but never select a subset in CI.
      typecheck: true,
      build: true,
      test: true,
      test_packages: "",
      test_web: true,
      test_server: true,
      // SCIENT-FORK:END
      rust: everything || rust,
      release_smoke: scriptsChanged,
      // SCIENT-FORK:START — main is the full backstop, including native static analysis.
      mobile_native: full || files === null || files.some((file) => MOBILE_NATIVE.test(file)),
      // SCIENT-FORK:END
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  // SCIENT-FORK:START — hosted detection preserves arbitrary Git filenames.
  const nul = args.includes("--paths0");
  const pathsIndex = args.indexOf(nul ? "--paths0" : "--paths");
  // SCIENT-FORK:END
  const files =
    pathsIndex === -1
      ? null
      : fs
          .readFileSync(args[pathsIndex + 1], "utf8")
          .split(nul ? "\0" : "\n")
          .filter(Boolean);
  const { affected, outputs } = decide(files, readWorkspace(), args.includes("--full"));

  console.error(`Affected packages: ${affected.join(", ") || "none"}`);
  for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
}

module.exports = { readWorkspace, decide };

if (require.main === module) main();
