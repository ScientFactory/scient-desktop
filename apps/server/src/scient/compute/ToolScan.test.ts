import { describe, expect, it } from "vite-plus/test";

import type { DiscoveryContext, RuntimeDiscoveryHost } from "./RuntimeDiscovery.ts";
import { expandPlace, groupTools, toolScanSteps } from "./ToolScan.ts";

/** A computer made of the given files, each runnable. */
function computer(
  files: ReadonlyArray<string>,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: Record<string, string>;
    readonly links?: Readonly<Record<string, string>>;
  } = {},
): DiscoveryContext {
  const platform = options.platform ?? "linux";
  const separator = platform === "win32" ? "\\" : "/";
  const folders = new Map<string, Set<string>>();
  for (const file of files) {
    const parts = file.split(separator);
    for (let index = 1; index < parts.length; index += 1) {
      const folder = parts.slice(0, index).join(separator) || separator;
      const entries = folders.get(folder) ?? new Set<string>();
      entries.add(parts[index]!);
      folders.set(folder, entries);
    }
  }
  const host: RuntimeDiscoveryHost = {
    kind: (path) => (files.includes(path) ? "file" : folders.has(path) ? "directory" : null),
    isDanglingLink: () => false,
    isExecutable: (path) => files.includes(path),
    readDirectory: (path) => [...(folders.get(path) ?? [])],
    readText: () => null,
    realPath: (path) =>
      options.links?.[path] ?? (files.includes(path) || folders.has(path) ? path : null),
    windowsPythonRegistrations: async () => [],
    windowsInstallRoots: async () => [],
  };
  return {
    platform,
    environment: { PATH: "/usr/bin", ...options.environment },
    homeDirectory: platform === "win32" ? "C:\\Users\\a" : "/home/a",
    host,
  };
}

const scan = (context: DiscoveryContext) =>
  groupTools(toolScanSteps(context).flatMap((step) => step.run()));

describe("the tool scan", () => {
  it("finds a language's tool wherever PATH leads, and starts nothing", () => {
    const tools = scan(computer(["/usr/bin/perl", "/usr/bin/gfortran", "/usr/bin/unrelated"]));
    expect(tools.get("perl")?.map((tool) => tool.executable)).toEqual(["/usr/bin/perl"]);
    expect(tools.get("fortran")?.[0]?.name).toBe("gfortran");
    expect(tools.has("unrelated")).toBe(false);
  });

  it("names the same real file once, keeping the first place found", () => {
    const tools = scan(
      computer(["/usr/bin/perl", "/opt/perl/bin/perl"], {
        environment: { PATH: "/opt/perl/bin:/usr/bin" },
        links: { "/usr/bin/perl": "/opt/perl/bin/perl" },
      }),
    );
    expect(tools.get("perl")?.map((tool) => tool.executable)).toEqual(["/opt/perl/bin/perl"]);
  });

  it("does not count Apple's stand-ins before developer tools exist", () => {
    const tools = scan(computer(["/usr/bin/clang", "/usr/bin/java"], { platform: "darwin" }));
    expect(tools.has("c")).toBe(false);
    expect(tools.has("java")).toBe(false);
  });

  it("counts them once developer tools exist", () => {
    const tools = scan(
      computer(["/usr/bin/clang", "/Library/Developer/CommandLineTools/usr/bin/clang"], {
        platform: "darwin",
      }),
    );
    expect(tools.get("c")?.[0]).toMatchObject({ name: "clang", origin: "Xcode tools" });
  });

  it("ignores version-manager shims and finds the real versions", () => {
    const tools = scan(
      computer(["/home/a/.rbenv/shims/ruby", "/home/a/.rbenv/versions/3.3.1/bin/ruby"], {
        environment: { PATH: "/home/a/.rbenv/shims" },
      }),
    );
    expect(tools.get("ruby")?.map((tool) => tool.executable)).toEqual([
      "/home/a/.rbenv/versions/3.3.1/bin/ruby",
    ]);
    expect(tools.get("ruby")?.[0]?.version).toBe("3.3.1");
  });

  it("does not take Windows' WSL launcher for Bash", () => {
    const tools = scan(
      computer(["C:\\Windows\\System32\\bash.exe", "C:\\Tools\\Git\\bin\\bash.exe"], {
        platform: "win32",
        environment: { Path: "C:\\Windows\\System32;C:\\Tools\\Git\\bin" },
      }),
    );
    expect(tools.get("bash")?.map((tool) => tool.executable)).toEqual([
      "C:\\Tools\\Git\\bin\\bash.exe",
    ]);
  });

  it("reads Windows names without their extension or case", () => {
    const tools = scan(
      computer(["C:\\Tools\\PERL.EXE"], {
        platform: "win32",
        environment: { Path: "C:\\Tools" },
      }),
    );
    expect(tools.get("perl")?.[0]?.executable).toBe("C:\\Tools\\PERL.EXE");
  });

  it("reads each conda location as its own step, so one dead drive sets aside only itself", () => {
    const context = computer(["/home/a/miniconda3/envs/lab/bin/gfortran"], {
      environment: { PATH: "/none" },
    });
    const host = context.host;
    const listed = {
      ...context,
      host: {
        ...host,
        readText: (path: string) =>
          path.endsWith("environments.txt") ? "/mnt/dead/env\n" : host.readText(path),
        kind: (path: string) =>
          path === "/home/a/miniconda3/envs/lab/conda-meta"
            ? ("directory" as const)
            : host.kind(path),
      },
    };
    const sources = toolScanSteps(listed).map((step) => step.source);
    expect(sources).toContain("/mnt/dead/env");
    expect(sources).not.toContain("conda");
  });

  it("names a tool in a known place by the command it answers to", () => {
    const tools = scan(
      computer(["C:\\Program Files\\JAGS\\JAGS-4.3.1\\x64\\bin\\jags-terminal.exe"], {
        platform: "win32",
        environment: { Path: "C:\\none", ProgramFiles: "C:\\Program Files" },
      }),
    );
    expect(tools.get("jags")?.[0]?.name).toBe("jags");
  });

  it("leads with the catalog's order within one folder", () => {
    const tools = scan(computer(["/usr/bin/cc", "/usr/bin/gcc", "/usr/bin/clang"]));
    expect(tools.get("c")?.map((tool) => tool.name)).toEqual(["clang", "gcc", "cc"]);
  });

  it("expands one level of a place, and skips what is not there", () => {
    const context = computer(["/opt/a/bin/x", "/opt/b/bin/x", "/opt/b/other/x"]);
    expect(expandPlace(context, "/opt/*/bin")).toEqual(["/opt/a/bin", "/opt/b/bin"]);
    expect(expandPlace(context, "/nowhere/*/bin")).toEqual([]);
  });
});
