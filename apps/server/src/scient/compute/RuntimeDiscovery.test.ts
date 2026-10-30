import { describe, expect, it } from "@effect/vitest";

import { enumeratePythonRuntimes, parseWindowsPythonRegistry } from "./RuntimeDiscovery.ts";
import { fakeDiscoveryContext, fakeDiscoveryHost } from "./RuntimeDiscoveryTestHost.ts";

const summary = (runtimes: ReturnType<typeof enumeratePythonRuntimes>) =>
  runtimes.map((runtime) => [runtime.executable, runtime.source, runtime.origin, runtime.problem]);

describe("Python discovery on macOS and Linux", () => {
  it("finds every PATH match, managers, conda environments and Homebrew without launching", () => {
    const host = fakeDiscoveryHost({
      files: [
        "/usr/local/bin/python3",
        "/opt/homebrew/bin/python3",
        "/home/ada/.pyenv/versions/3.11.9/bin/python",
        "/home/ada/.local/share/uv/python/cpython-3.13.1-macos-aarch64-none/bin/python3",
        "/home/ada/miniforge3/bin/python",
        "/home/ada/miniforge3/conda-meta/history",
        "/home/ada/miniforge3/envs/analysis/bin/python",
        "/home/ada/miniforge3/envs/analysis/conda-meta/history",
        "/home/ada/miniforge3/envs/r-only/conda-meta/history",
        "/srv/shared/env/bin/python",
        "/srv/shared/env/conda-meta/history",
      ],
      text: { "/home/ada/.conda/environments.txt": "/srv/shared/env\n" },
    });
    const runtimes = enumeratePythonRuntimes(
      fakeDiscoveryContext("darwin", host, { PATH: "/usr/local/bin:/opt/homebrew/bin" }),
      { projectRoot: null, windowsRegistrations: [] },
    );
    expect(summary(runtimes)).toEqual([
      ["/usr/local/bin/python3", "path", null, null],
      ["/opt/homebrew/bin/python3", "path", null, null],
      ["/home/ada/.pyenv/versions/3.11.9/bin/python", "conventional", "pyenv", null],
      [
        "/home/ada/.local/share/uv/python/cpython-3.13.1-macos-aarch64-none/bin/python3",
        "conventional",
        "uv",
        null,
      ],
      ["/home/ada/miniforge3/bin/python", "conventional", "conda: base", null],
      ["/home/ada/miniforge3/envs/analysis/bin/python", "conventional", "conda: analysis", null],
      ["/srv/shared/env/bin/python", "conventional", "conda: base", null],
    ]);
  });

  it("puts project environments first and keeps a broken one visible with its cause", () => {
    const host = fakeDiscoveryHost({
      files: [
        "/usr/bin/python3",
        "/p/.pixi/envs/default/bin/python",
        "/p/.pixi/envs/default/conda-meta/x",
      ],
      text: { "/p/.venv/pyvenv.cfg": "home = /old/python/bin\nversion = 3.12.1\n" },
      links: { "/p/.venv/bin/python": "/old/python/bin/python3" },
    });
    const runtimes = enumeratePythonRuntimes(
      fakeDiscoveryContext("linux", host, { PATH: "/usr/bin" }),
      { projectRoot: "/p", windowsRegistrations: [] },
    );
    expect(summary(runtimes)).toEqual([
      [
        "/p/.venv/bin/python",
        "project",
        ".venv",
        "Its base Python at /old/python/bin is gone. Recreate the environment.",
      ],
      ["/p/.pixi/envs/default/bin/python", "project", "pixi: default", null],
      ["/usr/bin/python3", "path", null, null],
    ]);
  });

  it("keeps a virtualenv distinct from the base Python its interpreter links to", () => {
    const host = fakeDiscoveryHost({
      files: ["/opt/homebrew/bin/python3"],
      text: { "/p/.venv/pyvenv.cfg": "home = /opt/homebrew/bin\n" },
      links: {
        "/p/.venv/bin/python": "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3": "/opt/homebrew/bin/python3",
      },
    });
    const runtimes = enumeratePythonRuntimes(
      fakeDiscoveryContext("darwin", host, { PATH: "/usr/local/bin:/opt/homebrew/bin" }),
      { projectRoot: "/p", windowsRegistrations: [] },
    );
    expect(runtimes.map((runtime) => runtime.executable)).toEqual([
      "/p/.venv/bin/python",
      "/usr/local/bin/python3",
    ]);
  });

  it("skips the macOS python3 shim unless developer tools are installed", () => {
    const shim = fakeDiscoveryHost({ files: ["/usr/bin/python3"] });
    const context = (host: ReturnType<typeof fakeDiscoveryHost>) =>
      fakeDiscoveryContext("darwin", host, { PATH: "/usr/bin" });
    expect(
      enumeratePythonRuntimes(context(shim), { projectRoot: null, windowsRegistrations: [] }),
    ).toEqual([]);
    const tools = fakeDiscoveryHost({
      files: ["/usr/bin/python3", "/Library/Developer/CommandLineTools/usr/bin/python3"],
    });
    expect(
      enumeratePythonRuntimes(context(tools), { projectRoot: null, windowsRegistrations: [] }).map(
        (runtime) => runtime.executable,
      ),
    ).toEqual(["/usr/bin/python3", "/Library/Developer/CommandLineTools/usr/bin/python3"]);
  });

  it("finds Pythons when the GUI launch lost the shell PATH", () => {
    const host = fakeDiscoveryHost({ files: ["/opt/homebrew/bin/python3"] });
    expect(
      summary(
        enumeratePythonRuntimes(fakeDiscoveryContext("darwin", host, { PATH: "/usr/bin:/bin" }), {
          projectRoot: null,
          windowsRegistrations: [],
        }),
      ),
    ).toEqual([["/opt/homebrew/bin/python3", "conventional", "Homebrew", null]]);
  });
});

describe("Python discovery on Windows", () => {
  const local = "C:\\Users\\ada\\AppData\\Local";
  const windowsApps = `${local}\\Microsoft\\WindowsApps`;

  it("marks Store shortcuts and still finds launcher-registered Python outside PATH", () => {
    const host = fakeDiscoveryHost({
      separator: "\\",
      files: [
        `${windowsApps}\\python.exe`,
        `${local}\\Programs\\Python\\Python312\\python.exe`,
        "D:\\Tools\\Python311\\python.exe",
        "C:\\Projects\\study\\.venv\\Scripts\\python.exe",
      ],
      text: {
        "C:\\Projects\\study\\.venv\\pyvenv.cfg": `home = ${local}\\Programs\\Python\\Python312\n`,
      },
    });
    const runtimes = enumeratePythonRuntimes(
      fakeDiscoveryContext("win32", host, { Path: windowsApps, LOCALAPPDATA: local }),
      {
        projectRoot: "C:\\Projects\\study",
        windowsRegistrations: ["D:\\Tools\\Python311\\python.exe"],
      },
    );
    expect(summary(runtimes)).toEqual([
      ["C:\\Projects\\study\\.venv\\Scripts\\python.exe", "project", ".venv", null],
      [
        `${windowsApps}\\python.exe`,
        "path",
        null,
        expect.stringContaining("Microsoft Store shortcut"),
      ],
      ["D:\\Tools\\Python311\\python.exe", "conventional", "Python launcher", null],
      [`${local}\\Programs\\Python\\Python312\\python.exe`, "conventional", "python.org", null],
    ]);
  });

  it("trusts Store aliases when a Store Python is installed, and dedupes case-insensitively", () => {
    const host = fakeDiscoveryHost({
      separator: "\\",
      files: [
        `${windowsApps}\\python.exe`,
        `${local}\\Packages\\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\\x`,
        "C:\\Python312\\python.exe",
      ],
    });
    const runtimes = enumeratePythonRuntimes(
      fakeDiscoveryContext("win32", host, {
        Path: `${windowsApps};C:\\Python312;c:\\python312`,
        LOCALAPPDATA: local,
      }),
      { projectRoot: null, windowsRegistrations: ["c:\\PYTHON312\\python.exe"] },
    );
    expect(summary(runtimes)).toEqual([
      [`${windowsApps}\\python.exe`, "path", null, null],
      ["C:\\Python312\\python.exe", "path", null, null],
    ]);
  });

  it("finds conda environments at the prefix root", () => {
    const host = fakeDiscoveryHost({
      separator: "\\",
      files: [
        "C:\\Users\\ada\\miniconda3\\python.exe",
        "C:\\Users\\ada\\miniconda3\\conda-meta\\history",
        "C:\\Users\\ada\\miniconda3\\envs\\geo\\python.exe",
        "C:\\Users\\ada\\miniconda3\\envs\\geo\\conda-meta\\history",
      ],
    });
    expect(
      summary(
        enumeratePythonRuntimes(fakeDiscoveryContext("win32", host, {}), {
          projectRoot: null,
          windowsRegistrations: [],
        }),
      ),
    ).toEqual([
      ["C:\\Users\\ada\\miniconda3\\python.exe", "conventional", "conda: base", null],
      ["C:\\Users\\ada\\miniconda3\\envs\\geo\\python.exe", "conventional", "conda: geo", null],
    ]);
  });

  it("reads PEP 514 registrations from reg query output", () => {
    const output = [
      "HKEY_CURRENT_USER\\Software\\Python\\PythonCore\\3.12",
      "    DisplayName    REG_SZ    Python 3.12 (64-bit)",
      "",
      "HKEY_CURRENT_USER\\Software\\Python\\PythonCore\\3.12\\InstallPath",
      "    (Default)    REG_SZ    C:\\Users\\ada\\AppData\\Local\\Programs\\Python\\Python312\\",
      "    ExecutablePath    REG_SZ    C:\\Users\\ada\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
      "",
      "HKEY_CURRENT_USER\\Software\\Python\\ContinuumAnalytics\\Anaconda39-64\\InstallPath",
      "    (Default)    REG_SZ    D:\\Anaconda3",
    ].join("\r\n");
    expect(parseWindowsPythonRegistry(output)).toEqual([
      "C:\\Users\\ada\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
      "D:\\Anaconda3\\python.exe",
    ]);
  });
});
