// @effect-diagnostics nodeBuiltinImport:off -- builds a stand-in CmdStan and real model files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { ExecutionRunId } from "@scientfactory/execution";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  cmdstanRoot,
  prepareStan,
  stanDataFile,
  stanMakeSafe,
  stanModelName,
  stanNeedsData,
  stanSetup,
  stanSourceProblem,
  stanServerBuilds,
  stanToolchain,
  publishStan,
  translateStan,
} from "./StanRun.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

const temporaryFolder = (prefix: string) => {
  const folder = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  folders.push(folder);
  return folder;
};

/** A CmdStan as cmdstanpy leaves it: the makefile beside `bin`, which holds its tools. */
function cmdstan(complete = true) {
  const root = NodePath.join(temporaryFolder("scient-cmdstan-"), "cmdstan-2.40.0");
  NodeFS.mkdirSync(NodePath.join(root, "bin"), { recursive: true });
  for (const file of complete
    ? ["makefile", "bin/stanc", "bin/stansummary", "bin/diagnose"]
    : ["bin/stanc"])
    NodeFS.writeFileSync(NodePath.join(root, file), "");
  return { root, stanc: NodePath.join(root, "bin", "stanc") };
}

const EIGHT_SCHOOLS = `data {
  int<lower=0> J;
  array[J] real y;
  array[J] real<lower=0> sigma;
}
parameters {
  real mu;
  real<lower=0> tau;
  vector[J] theta_tilde;
}
model {
  y ~ normal(mu + tau * theta_tilde, sigma);
}
`;

describe("finding CmdStan", () => {
  it("takes a stanc inside CmdStan, and not one on its own", () => {
    const { root, stanc } = cmdstan();
    expect(cmdstanRoot(stanc, "darwin")).toBe(root);
    expect(cmdstanRoot(cmdstan(false).stanc, "darwin")).toBeNull();
    expect(cmdstanRoot("/nowhere/bin/stanc", "darwin")).toBeNull();
  });

  it("follows a stanc linked from elsewhere to its CmdStan", () => {
    const { root, stanc } = cmdstan();
    const bin = temporaryFolder("scient-bin-");
    NodeFS.symlinkSync(stanc, NodePath.join(bin, "stanc"));
    expect(cmdstanRoot(NodePath.join(bin, "stanc"), "linux")).toBe(root);
  });

  it("says what to install when stanc cannot sample", () => {
    const setup = stanSetup(cmdstan(false).stanc, { PATH: "/usr/bin" }, "linux");
    expect(setup).toMatchObject({ availability: "missing" });
    expect("problem" in setup && setup.problem).toMatch(
      /only checks a model.*cmdstanpy.*cmdstanr/su,
    );
  });

  it("refuses a CmdStan whose path has spaces, which its makefiles cannot build from", () => {
    const parent = temporaryFolder("scient cmdstan ");
    const root = NodePath.join(parent, "cmdstan-2.40.0");
    NodeFS.mkdirSync(NodePath.join(root, "bin"), { recursive: true });
    for (const file of ["makefile", "bin/stanc", "bin/stansummary", "bin/diagnose"])
      NodeFS.writeFileSync(NodePath.join(root, file), "");
    const setup = stanSetup(NodePath.join(root, "bin", "stanc"), {}, "linux", () => true);
    expect(setup).toMatchObject({ availability: "invalid" });
  });

  it("names the build tools when make is missing", () => {
    const { stanc } = cmdstan();
    const setup = stanSetup(stanc, { PATH: "/usr/bin" }, "darwin", () => false);
    expect("problem" in setup && setup.problem).toContain("xcode-select --install");
  });
});

describe("a model's data", () => {
  it("reads the data file beside the model, CmdStan's own name first", () => {
    const folder = temporaryFolder("scient stan data ");
    const model = NodePath.join(folder, "eight_schools.stan");
    expect(stanDataFile(model)).toBeNull();
    NodeFS.writeFileSync(NodePath.join(folder, "eight_schools.data.R"), "J <- 8\n");
    expect(stanDataFile(model)).toBe(NodePath.join(folder, "eight_schools.data.R"));
    NodeFS.writeFileSync(NodePath.join(folder, "eight_schools.json"), "{}");
    expect(stanDataFile(model)).toBe(NodePath.join(folder, "eight_schools.json"));
    NodeFS.writeFileSync(NodePath.join(folder, "eight_schools.data.json"), "{}");
    expect(stanDataFile(model)).toBe(NodePath.join(folder, "eight_schools.data.json"));
  });

  it("knows a model reads data only from a data block that declares something", () => {
    expect(stanNeedsData(EIGHT_SCHOOLS)).toBe(true);
    expect(stanNeedsData("data {\n}\nparameters { real y; }\n")).toBe(false);
    expect(stanNeedsData("transformed data { real x = 1; }\nparameters { real y; }\n")).toBe(false);
    expect(
      stanNeedsData("// data { int N; }\n/* data { int N; } */\nparameters { real y; }\n"),
    ).toBe(false);
  });

  it("stops a model that reads data with none beside it, naming the file to add", () => {
    const folder = temporaryFolder("scient-stan-");
    const model = NodePath.join(folder, "eight_schools.stan");
    NodeFS.writeFileSync(model, EIGHT_SCHOOLS);
    expect(stanSourceProblem(model, "linux", "/tmp")).toBe(
      "eight_schools.stan reads data. Put it in eight_schools.data.json beside the model.",
    );
    NodeFS.writeFileSync(NodePath.join(folder, "eight_schools.data.json"), "{}");
    expect(stanSourceProblem(model, "linux", "/tmp")).toBeNull();
    expect(
      stanSourceProblem(model, "win32", "C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp"),
    ).toMatch(/spaces or symbols/u);
  });
});

describe("the toolchain", () => {
  const files =
    (...paths: ReadonlyArray<string>) =>
    (path: string) =>
      paths.includes(path);

  it("uses make from PATH, or MAKE, on Mac and Linux", () => {
    const exists = files("/usr/bin/make", "/opt/gmake");
    expect(
      stanToolchain({ root: "/c", environment: { PATH: "/usr/bin" }, platform: "linux", exists }),
    ).toEqual({
      make: "/usr/bin/make",
      environment: { PATH: "/usr/bin" },
    });
    expect(
      stanToolchain({
        root: "/c",
        environment: { PATH: "/usr/bin", MAKE: "/opt/gmake" },
        platform: "linux",
        exists,
      })?.make,
    ).toBe("/opt/gmake");
    expect(
      stanToolchain({ root: "/c", environment: { PATH: "/bin" }, platform: "linux", exists }),
    ).toBeNull();
  });

  it("puts RTools, then TBB, on a Windows PATH that lacks a compiler, keeping its own spelling", () => {
    const toolchain = stanToolchain({
      root: "C:\\cmdstan",
      environment: { Path: "C:\\Windows", SystemDrive: "C:" },
      platform: "win32",
      exists: files(
        "C:\\rtools44\\usr\\bin\\make.exe",
        "C:\\rtools44\\x86_64-w64-mingw32.static.posix\\bin\\g++.exe",
      ),
    });
    expect(toolchain).toEqual({
      make: "C:\\rtools44\\usr\\bin\\make.exe",
      environment: {
        SystemDrive: "C:",
        Path: [
          "C:\\cmdstan\\stan\\lib\\stan_math\\lib\\tbb",
          "C:\\rtools44\\usr\\bin",
          "C:\\rtools44\\x86_64-w64-mingw32.static.posix\\bin",
          "C:\\Windows",
        ].join(";"),
      },
      added: [
        "C:\\cmdstan\\stan\\lib\\stan_math\\lib\\tbb",
        "C:\\rtools44\\usr\\bin",
        "C:\\rtools44\\x86_64-w64-mingw32.static.posix\\bin",
      ],
    });
  });

  it("prefers mingw32-make, and finds cmdstanpy's RTools 4.0 in ~/.cmdstan", () => {
    const toolchain = stanToolchain({
      root: "C:\\cmdstan",
      environment: { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\ada" },
      platform: "win32",
      exists: files(
        "C:\\Users\\ada\\.cmdstan\\RTools40\\mingw64\\bin\\g++.exe",
        "C:\\Users\\ada\\.cmdstan\\RTools40\\mingw64\\bin\\mingw32-make.exe",
        "C:\\Users\\ada\\.cmdstan\\RTools40\\usr\\bin\\make.exe",
      ),
    });
    expect(toolchain?.make).toBe(
      "C:\\Users\\ada\\.cmdstan\\RTools40\\mingw64\\bin\\mingw32-make.exe",
    );
  });

  it("leaves a Windows compiler already on PATH alone, and needs one", () => {
    const onPath = stanToolchain({
      root: "C:\\cmdstan",
      environment: { PATH: "C:\\mingw64\\bin" },
      platform: "win32",
      exists: files(
        "C:\\mingw64\\bin\\g++.exe",
        "C:\\mingw64\\bin\\mingw32-make.exe",
        "C:\\rtools45\\usr\\bin\\make.exe",
      ),
    });
    expect(onPath?.environment.PATH).toBe(
      "C:\\cmdstan\\stan\\lib\\stan_math\\lib\\tbb;C:\\mingw64\\bin",
    );
    expect(
      stanToolchain({
        root: "C:\\cmdstan",
        environment: { PATH: "C:\\tools" },
        platform: "win32",
        exists: files("C:\\tools\\make.exe"),
      }),
    ).toBeNull();
  });
});

/** A build folder holding a model's C++, as `translateStan` leaves it. */
const builtFolder = (name: string) => {
  const folder = temporaryFolder("scient-stan-build-");
  NodeFS.writeFileSync(NodePath.join(folder, `${name}.hpp`), "// C++\n");
  return folder;
};

describe("the run", () => {
  const plan = (model: string, folder = builtFolder(stanModelName(model, "linux"))) => {
    const { root, stanc } = cmdstan();
    const staging = temporaryFolder("scient-stan-staging-");
    const prepared = prepareStan({
      stanc,
      root,
      toolchain: { make: "/usr/bin/make", environment: { PATH: "/usr/bin" } },
      model,
      folder,
      staging,
      cwd: "/project",
      platform: "linux",
      threads: 18,
    });
    return { prepared, root, stanc, folder, staging };
  };

  it("checks, builds in the folder's build, samples four chains, summarizes and diagnoses", () => {
    const project = temporaryFolder("scient stan model ");
    const model = NodePath.join(project, "eight schools.stan");
    NodeFS.writeFileSync(model, EIGHT_SCHOOLS);
    NodeFS.writeFileSync(NodePath.join(project, "eight schools.data.json"), "{}");
    const { prepared, root, stanc, folder, staging } = plan(model);
    const draws = NodePath.join(project, "eight schools-draws");
    const chains = [1, 2, 3, 4].map((chain) => NodePath.join(draws, `eight_schools_${chain}.csv`));
    const built = NodePath.join(folder, "build", "eight_schools");
    expect(prepared.before).toEqual([
      {
        executable: stanc,
        args: [
          `--include-paths=${project}`,
          "--name=eight_schools_model",
          `--o=${NodePath.join(staging, "eight_schools.hpp")}`,
          model,
        ],
        cwd: "/project",
        environment: { PATH: "/usr/bin" },
      },
      {
        executable: "/usr/bin/make",
        args: ["-s", "STAN_THREADS=true", built],
        cwd: root,
        environment: { PATH: "/usr/bin" },
        showOutput: "on-failure",
      },
      {
        executable: built,
        args: [
          "sample",
          "num_chains=4",
          "data",
          `file=${NodePath.join(project, "eight schools.data.json")}`,
          "output",
          `file=${NodePath.join(draws, "eight_schools.csv")}`,
          `profile_file=${NodePath.join(draws, "profile.csv")}`,
          "refresh=0",
          "num_threads=4",
        ],
        cwd: "/project",
        environment: { PATH: "/usr/bin" },
        showOutput: "on-failure",
      },
      {
        executable: NodePath.join(root, "bin", "stansummary"),
        args: ["-c", NodePath.join(draws, "summary.csv"), ...chains],
        cwd: "/project",
        environment: { PATH: "/usr/bin" },
      },
    ]);
    expect(prepared).toMatchObject({
      executable: NodePath.join(root, "bin", "diagnose"),
      args: chains,
      publication: { from: built, to: NodePath.join(folder, "eight_schools") },
    });
    // The build holds only this C++: no .stan for make to translate, no earlier objects.
    expect(NodeFS.readdirSync(NodePath.join(folder, "build"))).toEqual(["eight_schools.hpp"]);
    expect(NodeFS.readdirSync(project).filter((name) => name.endsWith(".hpp"))).toEqual([]);
  });

  it("samples the program already published from the same C++, building nothing", () => {
    const model = NodePath.join(temporaryFolder("scient-stan-"), "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const folder = builtFolder("a");
    NodeFS.writeFileSync(NodePath.join(folder, "a"), "the program");
    const { prepared } = plan(model, folder);
    expect(prepared.publication).toBeNull();
    expect(prepared.before.map((step) => step.executable)).toEqual([
      expect.stringMatching(/stanc$/u),
      NodePath.join(folder, "a"),
      expect.stringMatching(/stansummary$/u),
    ]);
  });

  it("empties the build first, so objects an interrupted build left are never linked", () => {
    const model = NodePath.join(temporaryFolder("scient-stan-"), "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const folder = builtFolder("a");
    // What an interrupted build or KEEP_OBJECT=true leaves behind.
    NodeFS.mkdirSync(NodePath.join(folder, "build"));
    NodeFS.writeFileSync(NodePath.join(folder, "build", "a.o"), "old object");
    NodeFS.writeFileSync(NodePath.join(folder, "build", "a"), "old program");
    plan(model, folder);
    expect(NodeFS.readdirSync(NodePath.join(folder, "build"))).toEqual(["a.hpp"]);
  });

  it("publishes a built program with a rename, and no shell anywhere in the run", async () => {
    const model = NodePath.join(temporaryFolder("scient-stan-"), "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const { prepared, folder } = plan(model);
    const shells = /(?:^|[\\/])(?:sh|bash|cmd(?:\.exe)?)$/iu;
    expect([...prepared.before, prepared].filter((step) => shells.test(step.executable))).toEqual(
      [],
    );
    NodeFS.writeFileSync(prepared.publication!.from, "the program");
    await publishStan(prepared.publication!);
    expect(NodeFS.readFileSync(NodePath.join(folder, "a"), "utf8")).toBe("the program");
    expect(plan(model, folder).prepared.publication).toBeNull();
  });

  it("samples a model that reads no data without a data argument", () => {
    const model = NodePath.join(temporaryFolder("scient-stan-"), "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\nmodel { y ~ normal(0, 1); }\n");
    expect(plan(model).prepared.before[2]?.args).not.toContain("data");
  });

  it("removes the last run's table and chains, which stansummary would not replace", () => {
    const project = temporaryFolder("scient-stan-");
    const model = NodePath.join(project, "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\nmodel { y ~ normal(0, 1); }\n");
    const draws = NodePath.join(project, "a-draws");
    NodeFS.mkdirSync(draws);
    for (const name of ["summary.csv", "a_1.csv", "a_4.csv", "notes.txt"])
      NodeFS.writeFileSync(NodePath.join(draws, name), "old");
    plan(model);
    expect(NodeFS.readdirSync(draws)).toEqual(["notes.txt"]);
  });

  it("names programs as Stan identifiers", () => {
    expect(stanModelName("/m/my-model.stan", "linux")).toBe("my_model");
    expect(stanModelName("/m/2024 fit.stan", "linux")).toBe("m_2024_fit");
    expect(stanModelName("C:\\m\\Fit.STAN", "win32")).toBe("Fit");
  });
});

describe("each server's own builds", () => {
  const staging = (state: string, runId: string) => ({
    projectId: "project",
    runId: ExecutionRunId.make(runId),
    artifactStagingDirectory: NodePath.join(state, "runs", "project", runId, "artifact-staging"),
  });

  it("keeps one server's builds apart from another's, and shares them across its own runs", () => {
    const first = stanServerBuilds(
      staging("/home/a/.scient/userdata/analysis", "r1"),
      "linux",
      "/tmp",
    );
    const again = stanServerBuilds(
      staging("/home/a/.scient/userdata/analysis", "r2"),
      "linux",
      "/tmp",
    );
    const other = stanServerBuilds(staging("/home/a/.scient/dev/analysis", "r1"), "linux", "/tmp");
    expect(first).toBe(again);
    expect(other).not.toBe(first);
    expect(NodePath.dirname(first)).toBe("/tmp/scient-stan");
    // A staging folder laid out otherwise gets this process's own key, shared with no server.
    const unknown = stanServerBuilds(
      { projectId: "p", runId: ExecutionRunId.make("r"), artifactStagingDirectory: "/x/staging" },
      "linux",
      "/tmp",
    );
    expect(new Set([first, other, unknown]).size).toBe(3);
    expect(NodePath.basename(unknown)).toMatch(/^process-\d+-[0-9a-f]{12}$/u);
  });
});

/** Names a shell or make would read: backticks, substitutions, variables, quotes and separators. */
const HOSTILE = [
  "tick `touch scient-ran-tick` x",
  "sub $(touch scient-ran-sub) x",
  "var $HOME x",
  'double "quote" x',
  "single 'quote' x",
  "semi ;touch scient-ran-semi; x",
  "space x",
  "percent 100% x",
  "comma a,b x",
];

describe("a model in a folder whose name a shell or make would read", () => {
  it.each(HOSTILE)("hands %s only to stanc, as one argument, and never to make", (name) => {
    const { root, stanc } = cmdstan();
    const project = NodePath.join(temporaryFolder("scient-stan-project-"), name);
    NodeFS.mkdirSync(project);
    const model = NodePath.join(project, "m.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const prepared = prepareStan({
      stanc,
      root,
      toolchain: { make: "/usr/bin/make", environment: {} },
      model,
      folder: builtFolder("m"),
      staging: temporaryFolder("scient-stan-staging-"),
      cwd: project,
      platform: "linux",
    });
    const [check, make] = prepared.before;
    expect(check?.args.at(-1)).toBe(model);
    for (const arg of make!.args) {
      expect(arg).not.toContain(name);
      expect(stanMakeSafe(arg.replace(/^[A-Z_]+=/u, ""), "linux"), arg).toBe(true);
    }
    // stanc splits include folders at commas, so it gets none rather than two wrong ones.
    expect(check?.args.some((arg) => arg.startsWith("--include-paths="))).toBe(!name.includes(","));
  });

  it("refuses a model that includes files from a folder whose path has a comma", () => {
    const folder = NodePath.join(temporaryFolder("scient-stan-"), "a,b");
    NodeFS.mkdirSync(folder);
    const model = NodePath.join(folder, "m.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    expect(stanSourceProblem(model, "linux", "/tmp")).toBeNull();
    NodeFS.writeFileSync(model, "functions {\n#include f.stanfunctions\n}\n");
    expect(stanSourceProblem(model, "linux", "/tmp")).toMatch(/separated by commas.*Rename/su);
  });

  it("lets only plain path characters reach make", () => {
    expect(stanMakeSafe("/var/folders/v4/x_y-z/T/scient-stan/0123abcd", "darwin")).toBe(true);
    expect(stanMakeSafe("C:\\Users\\ADALOV~1\\AppData\\Local\\Temp", "win32")).toBe(true);
    expect(stanMakeSafe("C:/cmdstan/cmdstan-2.40.0", "win32")).toBe(true);
    // A user name in any language is a folder make builds in.
    expect(stanMakeSafe("C:\\Users\\José\\AppData\\Local\\Temp", "win32")).toBe(true);
    expect(stanMakeSafe("/home/zoë/.cmdstan/cmdstan-2.40.0", "linux")).toBe(true);
    expect(stanMakeSafe("/home/山田/tmp", "linux")).toBe(true);
    for (const name of HOSTILE) expect(stanMakeSafe(`/tmp/${name}`, "linux"), name).toBe(false);
    expect(stanMakeSafe("/tmp/a:b", "linux")).toBe(false);
    expect(stanMakeSafe("/tmp/a#b", "linux")).toBe(false);
    expect(stanMakeSafe("/tmp/a=b", "linux")).toBe(false);
    expect(stanMakeSafe("C:\\Users\\Ada Lovelace\\Temp", "win32")).toBe(false);
  });

  it("refuses a temporary folder make cannot build in, before anything runs", () => {
    const folder = temporaryFolder("scient-stan-");
    const model = NodePath.join(folder, "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    expect(stanSourceProblem(model, "linux", "/tmp/x $(y)")).toMatch(/spaces or symbols.*TMPDIR/su);
    expect(stanSourceProblem(model, "linux", "/tmp/a,b")).toMatch(/spaces or symbols/su);
    expect(stanSourceProblem(model, "linux", "/tmp")).toBeNull();
  });
});

/**
 * A stanc that writes the model and every `.stanfunctions` in its include folder to its output, so
 * the C++ changes exactly when the model or an included file does. A model's words pick a failure.
 */
const FAKE_STANC = `#!/bin/sh
out=; dir=; model=
for arg in "$@"; do
  case "$arg" in
    --o=*) out="\${arg#--o=}" ;;
    --include-paths=*) dir="\${arg#--include-paths=}" ;;
    --*) ;;
    *) model="$arg" ;;
  esac
done
echo $$ > "$dir/stanc.pid"
grep -q error "$model" && { echo "Syntax error in '$model', line 1, column 2" >&2; exit 1; }
# Ignores the polite stop, as a stuck tool may.
grep -q stuck "$model" && { trap '' TERM; while :; do sleep 1; done; }
# 1.2 MB of warnings, beyond the 1 MiB a buffered child may print.
grep -q noisy "$model" && head -c 1200000 /dev/zero | tr '\\0' w >&2
echo "$out" >> "$dir/written.log"
cat "$model" "$dir"/*.stanfunctions > "$out" 2>/dev/null
exit 0
`;

// The stand-in stanc is a shell script, which needs a POSIX shell; Windows has none.
describe.runIf(NodeFS.existsSync("/bin/sh"))("translating to C++ and keeping it by content", () => {
  const computer = () => {
    const { root } = cmdstan();
    const stanc = NodePath.join(root, "bin", "stanc");
    NodeFS.writeFileSync(stanc, FAKE_STANC);
    NodeFS.chmodSync(stanc, 0o755);
    const temporary = temporaryFolder("scient-stan-builds-");
    const project = temporaryFolder("scient stan model ");
    const model = NodePath.join(project, "m.stan");
    const builds = NodePath.join(temporary, "scient-stan", "server-a");
    // Answers CmdStan's print-CXX as its makefiles would, from make/local, and counts the asks.
    const make = NodePath.join(root, "bin", "make");
    NodeFS.writeFileSync(
      make,
      `#!/bin/sh\necho asked >> "${root}/asked.log"\ncxx=$(sed -n 's/^CXX *= *//p' make/local 2>/dev/null | tail -1)\necho "CXX = \${cxx:-clang++}"\n`,
    );
    NodeFS.chmodSync(make, 0o755);
    const translate = (
      options: {
        readonly timeoutMs?: number;
        readonly now?: number;
        readonly environment?: Readonly<Record<string, string>>;
      } = {},
    ) =>
      translateStan({
        runId: ExecutionRunId.make("run"),
        stanc,
        root,
        model,
        toolchain: {
          make,
          environment: { PATH: "/usr/bin:/bin", ...options.environment },
        },
        builds,
        platform: "linux",
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    const folderOf = async () => {
      const translation = await translate();
      if (!("folder" in translation)) throw new Error(JSON.stringify(translation));
      return translation.folder;
    };
    return { builds, folderOf, model, project, root, temporary, translate };
  };

  it("keeps the same C++ in the same folder, so its program is reused", async () => {
    const { builds, folderOf, model, project } = computer();
    NodeFS.writeFileSync(model, "functions {\n#include f.stanfunctions\n}\n");
    NodeFS.writeFileSync(NodePath.join(project, "f.stanfunctions"), "real f() { return 1; }\n");
    const folder = await folderOf();
    expect(NodeFS.readFileSync(NodePath.join(folder, "m.hpp"), "utf8")).toContain("return 1");
    NodeFS.writeFileSync(NodePath.join(folder, "m"), "the program");
    expect(await folderOf()).toBe(folder);
    expect(NodeFS.readdirSync(folder).sort()).toEqual(["m", "m.hpp"]);
    expect(NodeFS.readdirSync(NodePath.join(builds, "incoming"))).toEqual([]);
  });

  it("puts changed C++ in a new folder and leaves the old one as it was", async () => {
    const { folderOf, model, project } = computer();
    NodeFS.writeFileSync(model, "functions {\n#include f.stanfunctions\n}\n");
    NodeFS.writeFileSync(NodePath.join(project, "f.stanfunctions"), "real f() { return 1; }\n");
    const first = await folderOf();
    NodeFS.writeFileSync(NodePath.join(first, "m"), "the program for return 1");
    NodeFS.writeFileSync(NodePath.join(project, "f.stanfunctions"), "real f() { return 2; }\n");
    const second = await folderOf();
    expect(second).not.toBe(first);
    expect(NodeFS.readdirSync(second)).toEqual(["m.hpp"]);
    expect(NodeFS.readFileSync(NodePath.join(first, "m"), "utf8")).toBe("the program for return 1");
    expect(NodeFS.readFileSync(NodePath.join(first, "m.hpp"), "utf8")).toContain("return 1");
  });

  it("fails with stanc's first message when the model does not translate", async () => {
    const { builds, model, translate } = computer();
    NodeFS.writeFileSync(model, "an error\n");
    expect(await translate()).toEqual({
      problem: `Stan could not translate the model: Syntax error in '${model}', line 1, column 2`,
    });
    expect(NodeFS.readdirSync(builds).sort()).toEqual(["incoming"]);
    expect(NodeFS.readdirSync(NodePath.join(builds, "incoming"))).toEqual([]);
  });

  it("takes a translation that prints more than a child's output buffer", async () => {
    const { folderOf, model } = computer();
    NodeFS.writeFileSync(model, "// noisy\nparameters { real y; }\n");
    const folder = await folderOf();
    expect(NodeFS.readFileSync(NodePath.join(folder, "m.hpp"), "utf8")).toContain("noisy");
  });

  it("stops a stanc that ignores the polite stop, with its whole tree, and settles", async () => {
    const { model, project, translate } = computer();
    NodeFS.writeFileSync(model, "// stuck\nparameters { real y; }\n");
    expect(await translate({ timeoutMs: 2000 })).toEqual({
      problem: "Stan could not translate the model: stanc did not finish in 2 seconds.",
    });
    const pid = Number(NodeFS.readFileSync(NodePath.join(project, "stanc.pid"), "utf8"));
    expect(() => NodeProcess.kill(pid, 0)).toThrow();
  });

  it("gives a new folder when the compiler, its flags or CmdStan's makefiles change", async () => {
    const { folderOf, model, root, translate } = computer();
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const folderFor = async (environment: Readonly<Record<string, string>> = {}) => {
      const translation = await translate({ environment });
      if (!("folder" in translation)) throw new Error(JSON.stringify(translation));
      return translation.folder;
    };
    const plain = await folderOf();
    expect(await folderFor()).toBe(plain);
    // A variable make does not read leaves the build as it was.
    expect(await folderFor({ EDITOR: "vi" })).toBe(plain);
    const folders = [
      await folderFor({ CXX: "/opt/gcc/bin/g++" }),
      await folderFor({ CXXFLAGS: "-O0" }),
      await folderFor({ STAN_OPENCL: "true" }),
    ];
    NodeFS.mkdirSync(NodePath.join(root, "make"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "make", "program"), "%.o : %.hpp\n");
    folders.push(await folderOf());
    NodeFS.writeFileSync(NodePath.join(root, "make", "program"), "%.o : %.hpp\n\t# changed\n");
    folders.push(await folderOf());
    expect(new Set([plain, ...folders]).size).toBe(6);
  });

  it("fingerprints the compiler make/local names, as make reports it, asking make once", async () => {
    const { folderOf, model, root, temporary } = computer();
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const compiler = NodePath.join(temporary, "custom-c++");
    NodeFS.writeFileSync(compiler, "compiler 1");
    NodeFS.mkdirSync(NodePath.join(root, "make"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "make", "local"), `CXX=${compiler}\n`);
    const asked = () =>
      NodeFS.readFileSync(NodePath.join(root, "asked.log"), "utf8").split("\n").length - 1;
    const first = await folderOf();
    expect(await folderOf()).toBe(first);
    expect(asked()).toBe(1);
    // The same compiler upgraded in place: make/local is unchanged, the compiler is not.
    NodeFS.writeFileSync(compiler, "compiler 2, larger");
    const upgraded = await folderOf();
    expect(upgraded).not.toBe(first);
    expect(asked()).toBe(1);
    NodeFS.writeFileSync(NodePath.join(root, "make", "local"), `CXX=${compiler}\nO=2\n`);
    expect(await folderOf()).not.toBe(upgraded);
    expect(asked()).toBe(2);
  });

  it("prunes only this server's builds unused for 30 days", async () => {
    const { builds, folderOf, model, temporary, translate } = computer();
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const folder = await folderOf();
    const stale = NodePath.join(builds, "0123456789abcdef0123456789abcdef");
    const otherServer = NodePath.join(temporary, "scient-stan", "server-b", "fedcba9876543210");
    for (const old of [stale, otherServer]) NodeFS.mkdirSync(old, { recursive: true });
    const day = 24 * 60 * 60;
    // 2026-11-09, in seconds.
    const now = 1_794_182_400;
    for (const old of [stale, folder, otherServer, NodePath.dirname(otherServer)]) {
      NodeFS.utimesSync(old, now - 31 * day, now - 31 * day);
    }
    await translate({ now: now * 1000 });
    expect(NodeFS.existsSync(stale)).toBe(false);
    expect(NodeFS.existsSync(folder)).toBe(true);
    expect(NodeFS.existsSync(otherServer)).toBe(true);
  });

  it("never opens what a comment names, such as a pipe that would block", async () => {
    const { folderOf, model, project } = computer();
    const pipe = NodePath.join(project, "pipe.stanfunctions.fifo");
    expect(NodeChildProcess.spawnSync("mkfifo", [pipe]).status).toBe(0);
    NodeFS.writeFileSync(model, `// #include ${NodePath.basename(pipe)}\nparameters { real y; }\n`);
    await folderOf();
    expect(stanSourceProblem(model, "linux", "/tmp")).toBeNull();
  });
});
