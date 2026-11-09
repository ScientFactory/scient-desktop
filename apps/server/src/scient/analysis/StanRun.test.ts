// @effect-diagnostics nodeBuiltinImport:off -- builds a stand-in CmdStan and real model files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  cmdstanRoot,
  prepareStan,
  stanBuildFolder,
  stanDataFile,
  stanMakeSafe,
  stanModelName,
  stanNeedsData,
  stanSetup,
  stanSourceProblem,
  stanToolchain,
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

describe("the run", () => {
  const plan = (model: string, platform: NodeJS.Platform = "linux") => {
    const { root, stanc } = cmdstan();
    const temporary = temporaryFolder("scient-stan-build-");
    const staging = temporaryFolder("scient-stan-staging-");
    const prepared = prepareStan({
      stanc,
      root,
      toolchain: { make: "/usr/bin/make", environment: { PATH: "/usr/bin" } },
      model,
      staging,
      cwd: "/project",
      platform,
      temporary,
      threads: 18,
    });
    return { prepared, root, stanc, temporary, staging };
  };

  it("checks, builds, samples four chains, summarizes and diagnoses, keeping the draws beside the model", () => {
    const folder = temporaryFolder("scient stan model ");
    const model = NodePath.join(folder, "eight schools.stan");
    NodeFS.writeFileSync(model, EIGHT_SCHOOLS);
    NodeFS.writeFileSync(NodePath.join(folder, "eight schools.data.json"), "{}");
    const { prepared, root, stanc, temporary, staging } = plan(model);
    const build = stanBuildFolder(root, model, "linux", temporary);
    const draws = NodePath.join(folder, "eight schools-draws");
    const chains = [1, 2, 3, 4].map((chain) => NodePath.join(draws, `eight_schools_${chain}.csv`));
    expect(prepared.before).toEqual([
      {
        executable: stanc,
        args: [
          `--include-paths=${folder}`,
          "--name=eight_schools_model",
          `--o=${NodePath.join(staging, "eight_schools.hpp")}`,
          model,
        ],
        cwd: "/project",
        environment: { PATH: "/usr/bin" },
      },
      {
        executable: "/usr/bin/make",
        args: ["-s", "STAN_THREADS=true", NodePath.join(build, "eight_schools")],
        cwd: root,
        environment: { PATH: "/usr/bin" },
        showOutput: "on-failure",
      },
      {
        executable: NodePath.join(build, "eight_schools"),
        args: [
          "sample",
          "num_chains=4",
          "data",
          `file=${NodePath.join(folder, "eight schools.data.json")}`,
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
    });
    // No .stan beside the C++, so make only compiles and never translates.
    expect(NodeFS.readdirSync(build)).toEqual([]);
    expect(NodeFS.existsSync(draws)).toBe(true);
    expect(NodeFS.readdirSync(folder).filter((name) => name.endsWith(".hpp"))).toEqual([]);
  });

  it("samples a model that reads no data without a data argument", () => {
    const model = NodePath.join(temporaryFolder("scient-stan-"), "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\nmodel { y ~ normal(0, 1); }\n");
    expect(plan(model).prepared.before[2]?.args).not.toContain("data");
  });

  it("removes the last run's table and chains, which stansummary would not replace", () => {
    const folder = temporaryFolder("scient-stan-");
    const model = NodePath.join(folder, "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\nmodel { y ~ normal(0, 1); }\n");
    const draws = NodePath.join(folder, "a-draws");
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
    const temporary = temporaryFolder("scient-stan-build-");
    const folder = NodePath.join(temporaryFolder("scient-stan-project-"), name);
    NodeFS.mkdirSync(folder);
    const model = NodePath.join(folder, "m.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const prepared = prepareStan({
      stanc,
      root,
      toolchain: { make: "/usr/bin/make", environment: {} },
      model,
      staging: temporary,
      cwd: folder,
      platform: "linux",
      temporary,
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
 * the C++ changes exactly when the model or an included file does. Fails on a model saying "error".
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
grep -q error "$model" && { echo "Syntax error in '$model', line 1" >&2; exit 1; }
cat "$model" "$dir"/*.stanfunctions > "$out" 2>/dev/null
exit 0
`;

// The stand-in stanc is a shell script, which needs a POSIX shell; Windows has none.
describe.runIf(NodeFS.existsSync("/bin/sh"))("translating to the build's C++", () => {
  const computer = () => {
    const { root } = cmdstan();
    const stanc = NodePath.join(root, "bin", "stanc");
    NodeFS.writeFileSync(stanc, FAKE_STANC);
    NodeFS.chmodSync(stanc, 0o755);
    const temporary = temporaryFolder("scient-stan-build-");
    const folder = temporaryFolder("scient stan model ");
    const model = NodePath.join(folder, "m.stan");
    const hpp = NodePath.join(stanBuildFolder(root, model, "linux", temporary), "m.hpp");
    const translate = () =>
      translateStan({
        stanc,
        root,
        model,
        environment: { PATH: "/usr/bin:/bin" },
        platform: "linux",
        temporary,
      });
    // 2020-01-01, in seconds.
    const old = 1_577_836_800;
    const age = () => NodeFS.utimesSync(hpp, old, old);
    const replaced = () => NodeFS.statSync(hpp).mtimeMs !== old * 1000;
    return { folder, hpp, model, translate, age, replaced };
  };

  it("keeps the C++ when nothing changed, so make does not compile again", async () => {
    const { folder, hpp, model, translate, age, replaced } = computer();
    NodeFS.writeFileSync(model, "functions {\n#include f.stanfunctions\n}\n");
    NodeFS.writeFileSync(NodePath.join(folder, "f.stanfunctions"), "real f() { return 1; }\n");
    await translate();
    expect(NodeFS.readFileSync(hpp, "utf8")).toContain("return 1");
    age();
    await translate();
    expect(replaced()).toBe(false);
    expect(NodeFS.readdirSync(NodePath.dirname(hpp))).toEqual(["m.hpp"]);
  });

  it("replaces the C++ when only an included file changed", async () => {
    const { folder, hpp, model, translate, age, replaced } = computer();
    NodeFS.writeFileSync(model, "functions {\n#include f.stanfunctions\n}\n");
    NodeFS.writeFileSync(NodePath.join(folder, "f.stanfunctions"), "real f() { return 1; }\n");
    await translate();
    age();
    NodeFS.writeFileSync(NodePath.join(folder, "f.stanfunctions"), "real f() { return 2; }\n");
    await translate();
    expect(replaced()).toBe(true);
    expect(NodeFS.readFileSync(hpp, "utf8")).toContain("return 2");
  });

  it("leaves the last good C++ when the model does not translate", async () => {
    const { hpp, model, translate } = computer();
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    await translate();
    NodeFS.writeFileSync(model, "an error\n");
    await translate();
    expect(NodeFS.readFileSync(hpp, "utf8")).toBe("parameters { real y; }\n");
    expect(NodeFS.readdirSync(NodePath.dirname(hpp))).toEqual(["m.hpp"]);
  });

  it("never opens what a comment names, such as a pipe that would block", async () => {
    const { folder, model, translate } = computer();
    const pipe = NodePath.join(folder, "pipe.stanfunctions.fifo");
    expect(NodeChildProcess.spawnSync("mkfifo", [pipe]).status).toBe(0);
    NodeFS.writeFileSync(model, `// #include ${NodePath.basename(pipe)}\nparameters { real y; }\n`);
    await translate();
    expect(stanSourceProblem(model, "linux", "/tmp")).toBeNull();
  });
});
