// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- CI helper that installs test tools, not app code.
/**
 * CI only: installs one group of languages as a person would, `node <this> <group>`. The test must
 * find and run each one it names in SCIENT_TEST_RUN_TABLE_EXPECT. One that fails to install fails
 * the job at the end, so coverage is never lost silently.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeProcess from "node:process";

type Platform = "linux" | "darwin" | "win32";
/** A shell command that installs it, `true` for what GitHub's computers already have, or why not. */
type Install = string | { readonly skip: string };
type Language = Partial<Record<Platform, Install>>;

const apt = (...names: ReadonlyArray<string>) =>
  `sudo apt-get install -y --no-install-recommends ${names.join(" ")}`;
const brew = (...names: ReadonlyArray<string>) => `brew install ${names.join(" ")}`;
const cask = (name: string) => `brew install --cask ${name}`;
const choco = (...names: ReadonlyArray<string>) =>
  `choco install -y --no-progress ${names.join(" ")}`;
const ALREADY = "true";

const ELAN_UNIX =
  "curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain stable";
const ELAN_WINDOWS =
  "curl -sSfLo elan-init.ps1 https://raw.githubusercontent.com/leanprover/elan/master/elan-init.ps1 && powershell -ExecutionPolicy Bypass -File elan-init.ps1 -NoPrompt 1 -DefaultToolchain stable";
const SCALA_LINUX =
  "curl -sSfL https://github.com/VirtusLab/scala-cli/releases/latest/download/scala-cli-x86_64-pc-linux.gz | gzip -d > scala-cli && chmod +x scala-cli && sudo mv scala-cli /usr/local/bin/";
const CLOJURE_LINUX =
  "curl -sSfLO https://github.com/clojure/brew-install/releases/latest/download/linux-install.sh && chmod +x linux-install.sh && sudo ./linux-install.sh";
const NEXTFLOW_UNIX =
  "curl -sSfL https://get.nextflow.io | bash && sudo mv nextflow /usr/local/bin/";
/** The workflow sets up a plain Python first, so pip installs into it. */
const CMDSTAN = "python -m pip install cmdstanpy && python -m cmdstanpy.install_cmdstan --cores 4";

const NO_WINDOWS = (name: string) => ({
  skip: `${name} has no Windows build; people run it through WSL, which is Linux`,
});

const GROUPS: Readonly<Record<string, Readonly<Record<string, Language>>>> = {
  compiled: {
    c: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    cpp: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    fortran: { linux: apt("gfortran"), darwin: brew("gcc"), win32: ALREADY },
    rust: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    go: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    java: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    kotlin: { linux: ALREADY, darwin: brew("kotlin"), win32: choco("kotlinc") },
    scala: {
      linux: SCALA_LINUX,
      darwin: brew("Virtuslab/scala-cli/scala-cli"),
      win32: choco("scala-cli"),
    },
    csharp: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    fsharp: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    zig: {
      linux: "sudo snap install zig --classic --beta",
      darwin: brew("zig"),
      win32: choco("zig"),
    },
    nim: { linux: apt("nim"), darwin: brew("nim"), win32: choco("nim") },
  },
  scripts: {
    bash: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    powershell: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    javascript: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    typescript: {
      linux: "curl -fsSL https://deno.land/install.sh | sh -s -- -y",
      darwin: brew("deno"),
      win32: choco("deno"),
    },
    perl: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    ruby: { linux: ALREADY, darwin: ALREADY, win32: ALREADY },
    lua: { linux: apt("lua5.4"), darwin: brew("lua"), win32: choco("lua") },
    tcl: { linux: apt("tcl"), darwin: brew("tcl-tk"), win32: choco("magicsplat-tcl-tk") },
    sqlite: { linux: apt("sqlite3"), darwin: ALREADY, win32: choco("sqlite") },
    apl: {
      linux: apt("apl"),
      darwin: brew("gnu-apl"),
      win32: { skip: "GNU APL has no Windows build, and Dyalog needs a sign-up to download" },
    },
  },
  functional: {
    haskell: { linux: apt("ghc"), darwin: brew("ghc"), win32: choco("ghc") },
    ocaml: {
      linux: apt("ocaml-nox"),
      darwin: brew("ocaml"),
      win32: { skip: "OCaml on Windows builds its compiler through opam, about 20 minutes" },
    },
    clojure: { linux: CLOJURE_LINUX, darwin: brew("clojure"), win32: choco("babashka") },
    "common-lisp": { linux: apt("sbcl"), darwin: brew("sbcl"), win32: choco("sbcl") },
    racket: { linux: apt("racket"), darwin: brew("minimal-racket"), win32: choco("racket") },
    elixir: { linux: apt("elixir"), darwin: brew("elixir"), win32: choco("elixir") },
    erlang: { linux: apt("erlang-nox"), darwin: brew("erlang"), win32: choco("erlang") },
    prolog: {
      linux: apt("swi-prolog-nox"),
      darwin: brew("swi-prolog"),
      win32: choco("swi-prolog"),
    },
  },
  math: {
    gp: { linux: apt("pari-gp"), darwin: brew("pari"), win32: choco("pari-gp") },
    maxima: { linux: apt("maxima"), darwin: brew("maxima"), win32: choco("maxima") },
    gap: { linux: apt("gap"), darwin: brew("gap"), win32: NO_WINDOWS("GAP") },
    macaulay2: {
      linux: apt("macaulay2"),
      darwin: brew("Macaulay2/tap/M2"),
      win32: NO_WINDOWS("Macaulay2"),
    },
    singular: { linux: apt("singular"), darwin: brew("singular"), win32: NO_WINDOWS("Singular") },
    coq: { linux: apt("coq"), darwin: brew("rocq"), win32: choco("coq") },
    lean: { linux: ELAN_UNIX, darwin: ELAN_UNIX, win32: ELAN_WINDOWS },
    agda: {
      linux: apt("agda-bin"),
      darwin: brew("agda"),
      win32: { skip: "Agda has no Windows installer; it builds from Haskell, about an hour" },
    },
  },
  lab: {
    octave: { linux: apt("octave"), darwin: brew("octave"), win32: choco("octave.portable") },
    gnuplot: { linux: apt("gnuplot-nox"), darwin: brew("gnuplot"), win32: choco("gnuplot") },
    minizinc: { linux: apt("minizinc"), darwin: cask("minizincide"), win32: choco("minizinc") },
    verilog: { linux: apt("iverilog"), darwin: brew("icarus-verilog"), win32: choco("iverilog") },
    vhdl: { linux: apt("ghdl"), darwin: brew("ghdl"), win32: choco("ghdl") },
    scilab: { linux: apt("scilab-cli"), darwin: cask("scilab"), win32: choco("scilab") },
    jags: { linux: apt("jags"), darwin: brew("jags"), win32: choco("jags") },
    spss: { linux: apt("pspp"), darwin: brew("pspp"), win32: choco("pspp") },
    nextflow: {
      linux: NEXTFLOW_UNIX,
      darwin: brew("nextflow"),
      win32: { skip: "Nextflow does not run on Windows, only through WSL" },
    },
    snakemake: {
      linux: "pipx install snakemake",
      darwin: brew("snakemake"),
      win32: "pipx install snakemake",
    },
    idl: { linux: apt("gnudatalanguage"), darwin: brew("gnudatalanguage"), win32: choco("gdl") },
    stan: { linux: CMDSTAN, darwin: CMDSTAN, win32: CMDSTAN },
  },
  // Each is hundreds of megabytes or more, so they run on one computer. Their routes are the same
  // everywhere.
  heavy: {
    isabelle: {
      linux:
        'curl -sSfL "https://isabelle.in.tum.de/dist/Isabelle2025_linux.tar.gz" | tar -xz -C "$HOME"',
    },
    sage: {
      linux:
        'curl -sSfL https://micro.mamba.pm/install.sh | bash && "$HOME/.local/bin/micromamba" create -y -n sage -c conda-forge sage',
    },
    root: { linux: "sudo snap install root-framework" },
    "imagej-macro": {
      linux:
        'curl -sSfLo fiji.zip https://downloads.imagej.net/fiji/latest/fiji-latest-linux64-jdk.zip && unzip -q fiji.zip -d "$HOME"',
    },
    netlogo: {
      linux:
        'curl -sSfL "https://downloads.netlogo.org/6.4.0/NetLogo-6.4.0-64.tgz" | tar -xz -C "$HOME"',
    },
    modelica: {
      linux: [
        "curl -fsSL https://build.openmodelica.org/apt/openmodelica.asc | sudo gpg --dearmor -o /usr/share/keyrings/openmodelica-keyring.gpg",
        'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/openmodelica-keyring.gpg] https://build.openmodelica.org/apt $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/openmodelica.list',
        "sudo apt-get update -q",
        apt("omc"),
      ].join(" && "),
    },
  },
};

/** Where installers put commands for a new terminal. Scient reads the same login PATH. */
const PROFILE_PATHS = ["~/.elan/bin", "~/.deno/bin", "~/.local/bin"];

const group = process.argv[2] ?? "";
const languages = GROUPS[group];
if (languages === undefined) {
  throw new Error(`Name a group: ${Object.keys(GROUPS).join(", ")}.`);
}
const platform = NodeProcess.platform as Platform;
const home = NodeOS.homedir();
const append = (variable: string, text: string) => {
  const target = process.env[variable];
  if (target) NodeFS.appendFileSync(target, text);
};

if (platform === "linux") {
  NodeChildProcess.execSync("sudo apt-get update -q", { stdio: "inherit" });
}

const installed: Array<string> = [];
const failed: Array<string> = [];
const rows: Array<string> = [];
for (const [languageId, ways] of Object.entries(languages)) {
  const way = ways[platform];
  if (way === undefined) {
    rows.push(`| ${languageId} | Tested on another computer |`);
    continue;
  }
  if (typeof way !== "string") {
    rows.push(`| ${languageId} | Not tested: ${way.skip} |`);
    continue;
  }
  console.log(`::group::Install ${languageId}`);
  const result = NodeChildProcess.spawnSync("bash", ["-c", way], {
    stdio: "inherit",
    timeout: 25 * 60_000,
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1" },
  });
  console.log("::endgroup::");
  if (result.status === 0) {
    installed.push(languageId);
    rows.push(`| ${languageId} | Installed |`);
  } else {
    failed.push(languageId);
    rows.push(`| ${languageId} | Could not install |`);
    console.log(`::error::Could not install ${languageId} with: ${way}`);
  }
}

const paths = PROFILE_PATHS.map((place) => place.replace("~", home));
if (platform === "win32") {
  // An app started after an install sees the PATH the installer saved, not this shell's.
  const saved = NodeChildProcess.execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ],
    { encoding: "utf8" },
  );
  paths.push(...saved.trim().split(";").filter(Boolean));
}
append("GITHUB_PATH", `${paths.filter((place) => NodeFS.existsSync(place)).join("\n")}\n`);
append("GITHUB_ENV", `SCIENT_TEST_RUN_TABLE_EXPECT=${installed.join(",")}\n`);
append("GITHUB_ENV", `SCIENT_RUN_LANGUAGES_NOT_INSTALLED=${failed.join(",")}\n`);
append(
  "GITHUB_STEP_SUMMARY",
  `### ${group} on ${platform} ${NodeProcess.arch}\n\n| Language | Install |\n| --- | --- |\n${rows.join("\n")}\n`,
);
