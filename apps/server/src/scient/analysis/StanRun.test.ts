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

  it("checks, builds in a folder of its own, samples four chains, summarizes and diagnoses", () => {
    const project = temporaryFolder("scient stan model ");
    const model = NodePath.join(project, "eight schools.stan");
    NodeFS.writeFileSync(model, EIGHT_SCHOOLS);
    NodeFS.writeFileSync(NodePath.join(project, "eight schools.data.json"), "{}");
    const { prepared, root, stanc, folder, staging } = plan(model);
    const draws = NodePath.join(project, "eight schools-draws");
    const chains = [1, 2, 3, 4].map((chain) => NodePath.join(draws, `eight_schools_${chain}.csv`));
    const [own] = NodeFS.readdirSync(folder).filter((entry) => entry.startsWith("build-"));
    const built = NodePath.join(folder, own!, "eight_schools");
    const program = NodePath.join(folder, "eight_schools");
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
        executable: "/bin/sh",
        args: ["-c", '[ -e "$1" ] || mv -f "$0" "$1"; [ -e "$1" ]', built, program],
        cwd: "/project",
        environment: { PATH: "/usr/bin" },
        showOutput: "on-failure",
      },
      {
        executable: program,
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
    });
    // Its own folder holds only this C++: no .stan for make to translate, no older objects.
    expect(NodeFS.readdirSync(NodePath.join(folder, own!))).toEqual(["eight_schools.hpp"]);
    expect(NodeFS.readdirSync(project).filter((name) => name.endsWith(".hpp"))).toEqual([]);
  });

  it("samples the program already built from the same C++, building nothing", () => {
    const model = NodePath.join(temporaryFolder("scient-stan-"), "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const folder = builtFolder("a");
    NodeFS.writeFileSync(NodePath.join(folder, "a"), "the program");
    const { prepared } = plan(model, folder);
    expect(prepared.before.map((step) => step.executable)).toEqual([
      expect.stringMatching(/stanc$/u),
      NodePath.join(folder, "a"),
      expect.stringMatching(/stansummary$/u),
    ]);
    expect(NodeFS.readdirSync(folder).sort()).toEqual(["a", "a.hpp"]);
  });

  it("builds each time in a new folder, so objects a build left behind are never linked", () => {
    const model = NodePath.join(temporaryFolder("scient-stan-"), "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const folder = builtFolder("a");
    // What an interrupted build or KEEP_OBJECT=true leaves: an object beside a build's C++.
    const earlier = NodePath.join(folder, "build-1-000000000000");
    NodeFS.mkdirSync(earlier);
    NodeFS.writeFileSync(NodePath.join(earlier, "a.o"), "old object");
    NodeFS.writeFileSync(NodePath.join(folder, "a.o"), "old object");
    const first = plan(model, folder).prepared.before[1]!.args.at(-1)!;
    const second = plan(model, folder).prepared.before[1]!.args.at(-1)!;
    expect(new Set([first, second, NodePath.join(earlier, "a")]).size).toBe(3);
    for (const target of [first, second]) {
      expect(NodeFS.readdirSync(NodePath.dirname(target))).toEqual(["a.hpp"]);
    }
  });

  it("samples a model that reads no data without a data argument", () => {
    const model = NodePath.join(temporaryFolder("scient-stan-"), "a.stan");
    NodeFS.writeFileSync(model, "parameters { real y; }\nmodel { y ~ normal(0, 1); }\n");
    expect(plan(model).prepared.before[3]?.args).not.toContain("data");
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
    const [check, make, publish] = prepared.before;
    expect(check?.args.at(-1)).toBe(model);
    for (const arg of [...make!.args, ...publish!.args.slice(2)]) {
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
    const translate = (options: { readonly timeoutMs?: number; readonly now?: number } = {}) =>
      translateStan({
        runId: ExecutionRunId.make("run"),
        stanc,
        root,
        model,
        environment: { PATH: "/usr/bin:/bin" },
        platform: "linux",
        temporary,
        ...options,
      });
    const folderOf = async () => {
      const translation = await translate();
      if (!("folder" in translation)) throw new Error(JSON.stringify(translation));
      return translation.folder;
    };
    const builds = NodePath.join(temporary, "scient-stan");
    return { builds, folderOf, model, project, translate };
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

  it("lets two translations of one model at once share one folder and one C++", async () => {
    const { builds, model, project, translate } = computer();
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const [first, second] = await Promise.all([translate(), translate()]);
    expect(first).toEqual(second);
    const written = NodeFS.readFileSync(NodePath.join(project, "written.log"), "utf8")
      .trim()
      .split("\n");
    expect(new Set(written).size).toBe(2);
    for (const file of written) {
      expect(NodePath.basename(file)).toMatch(/^m\.\d+-[0-9a-f]{12}\.hpp$/u);
    }
    expect("folder" in first! && NodeFS.readdirSync(first.folder)).toEqual(["m.hpp"]);
    expect(NodeFS.readdirSync(NodePath.join(builds, "incoming"))).toEqual([]);
  });

  it("removes builds unused for 30 days, keeping the one just used", async () => {
    const { builds, folderOf, model, translate } = computer();
    NodeFS.writeFileSync(model, "parameters { real y; }\n");
    const folder = await folderOf();
    const stale = NodePath.join(builds, "0123456789abcdef0123456789abcdef");
    NodeFS.mkdirSync(stale);
    const day = 24 * 60 * 60;
    // 2026-11-09, in seconds.
    const now = 1_794_182_400;
    NodeFS.utimesSync(stale, now - 31 * day, now - 31 * day);
    NodeFS.utimesSync(folder, now - 31 * day, now - 31 * day);
    await translate({ now: now * 1000 });
    expect(NodeFS.existsSync(stale)).toBe(false);
    expect(NodeFS.existsSync(folder)).toBe(true);
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
