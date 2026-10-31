import { describe, expect, it } from "vite-plus/test";

import { fakeDiscoveryContext, fakeDiscoveryHost } from "./RuntimeDiscoveryTestHost.ts";
import {
  juliaPackagePresent,
  readJuliaFacts,
  readPythonFacts,
  readRFacts,
  rPackageVersion,
} from "./RuntimeFacts.ts";

describe("Python facts", () => {
  it("reads a virtual environment's version and packages from its files", () => {
    const context = fakeDiscoveryContext(
      "linux",
      fakeDiscoveryHost({
        files: ["/p/.venv/bin/python"],
        text: {
          "/p/.venv/pyvenv.cfg": "home = /usr/bin\nversion = 3.12.4\n",
          "/p/.venv/lib/python3.12/site-packages/numpy-2.1.0.dist-info/METADATA": "",
          "/p/.venv/lib/python3.12/site-packages/old_pkg-1.0-py3.12.egg-info/PKG-INFO": "",
        },
      }),
    );
    const facts = readPythonFacts(context, "/p/.venv/bin/python");
    expect(facts.version).toBe("3.12.4");
    expect(facts.packages("numpy")).toEqual({ state: "present", version: "2.1.0" });
    expect(facts.packages("old-pkg")).toEqual({ state: "present", version: "1.0" });
    expect(facts.packages("ipykernel")).toEqual({ state: "absent" });
  });

  it("says unknown rather than absent when it cannot see a site folder", () => {
    const context = fakeDiscoveryContext(
      "linux",
      fakeDiscoveryHost({ files: ["/opt/x/bin/python3"] }),
    );
    const facts = readPythonFacts(context, "/opt/x/bin/python3");
    expect(facts.version).toBeNull();
    expect(facts.packages("ipykernel")).toEqual({ state: "unknown" });
  });

  it("follows inherited system packages, Debian's folder and editable installs", () => {
    const context = fakeDiscoveryContext(
      "linux",
      fakeDiscoveryHost({
        files: ["/p/venv/bin/python"],
        text: {
          "/p/venv/pyvenv.cfg": "home = /usr/bin\ninclude-system-site-packages = true\n",
          "/p/venv/lib/python3.12/site-packages/link.pth": "/src/lib\nimport evil\n",
          "/src/lib/mine-0.1.dist-info/METADATA": "",
          "/usr/lib/python3.12/dist-packages/scipy-1.13.dist-info/METADATA": "",
        },
      }),
    );
    const facts = readPythonFacts(context, "/p/venv/bin/python");
    expect(facts.packages("mine").state).toBe("present");
    expect(facts.packages("scipy")).toEqual({ state: "present", version: "1.13" });
  });

  it("reads a conda environment's version from its package records", () => {
    const context = fakeDiscoveryContext(
      "linux",
      fakeDiscoveryHost({
        files: ["/c/envs/a/bin/python"],
        text: { "/c/envs/a/conda-meta/python-3.11.9-h123_0.json": "{}" },
      }),
    );
    expect(readPythonFacts(context, "/c/envs/a/bin/python").version).toBe("3.11.9");
  });

  it("reads Windows layouts", () => {
    const context = fakeDiscoveryContext(
      "win32",
      fakeDiscoveryHost({
        separator: "\\",
        files: ["C:\\p\\.venv\\Scripts\\python.exe"],
        text: {
          "C:\\p\\.venv\\pyvenv.cfg": "version_info = 3.13.1.final.0\n",
          "C:\\p\\.venv\\Lib\\site-packages\\pandas-3.0.dist-info\\METADATA": "",
        },
      }),
    );
    const facts = readPythonFacts(context, "C:\\p\\.venv\\Scripts\\python.exe");
    expect(facts.version).toBe("3.13.1.final.0");
    expect(facts.packages("pandas")).toEqual({ state: "present", version: "3.0" });
  });
});

describe("R facts", () => {
  const description =
    "Package: base\nVersion: 4.6.2\nBuilt: R 4.6.2; ; 2026-06-01; aarch64-apple-darwin\n";

  it("reads the home its launcher script names, then version and packages", () => {
    const context = fakeDiscoveryContext(
      "darwin",
      fakeDiscoveryHost({
        text: {
          "/opt/R/bin/R": 'R_HOME_DIR="/opt/R/lib/R"\nexec stuff\n',
          "/opt/R/lib/R/library/base/DESCRIPTION": description,
          "/opt/R/lib/R/library/IRkernel/DESCRIPTION": "Package: IRkernel\nVersion: 1.3.2\n",
        },
      }),
    );
    const facts = readRFacts(context, "/opt/R/bin/R");
    expect(facts).toEqual({
      home: "/opt/R/lib/R",
      version: "4.6.2",
      architecture: "aarch64-apple-darwin",
    });
    expect(rPackageVersion(context, facts, "IRkernel")).toBe("1.3.2");
    expect(rPackageVersion(context, facts, "ggplot2")).toBeNull();
  });

  it.each(["C:\\R\\bin\\R.exe", "C:\\R\\bin\\x64\\R.exe"])("finds the home of %s", (executable) => {
    const context = fakeDiscoveryContext(
      "win32",
      fakeDiscoveryHost({
        separator: "\\",
        files: [executable],
        text: { "C:\\R\\library\\base\\DESCRIPTION": description },
      }),
    );
    expect(readRFacts(context, executable)).toMatchObject({ home: "C:\\R", version: "4.6.2" });
  });
});

describe("Julia facts", () => {
  it("reads the version and finds a package in the person's depot", () => {
    const context = fakeDiscoveryContext(
      "linux",
      fakeDiscoveryHost({
        files: ["/opt/julia/bin/julia"],
        text: {
          "/opt/julia/include/julia/julia_version.h": '#define JULIA_VERSION_STRING "1.13.3"\n',
          "/home/ada/.julia/environments/v1.13/Project.toml": '[deps]\nIJulia = "7073ff75"\n',
        },
      }),
    );
    const facts = readJuliaFacts(context, "/opt/julia/bin/julia");
    expect(facts.version).toBe("1.13.3");
    expect(juliaPackagePresent(context, facts, "IJulia")).toBe(true);
    expect(juliaPackagePresent(context, facts, "Plots")).toBe(false);
  });
});
