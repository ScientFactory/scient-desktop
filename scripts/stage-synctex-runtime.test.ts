import { describe, expect, it } from "vitest";

import {
  assertPinnedSyncTexSource,
  assertStaticLinuxProgramHeaders,
  cmakeArchitecture,
  renderCMakeProject,
  runtimeExecutableName,
  runtimePlatformKey,
  SYNCTEX_SOURCE,
  ZLIB_SOURCE,
} from "./stage-synctex-runtime.ts";

describe("SyncTeX runtime staging", () => {
  it("pins immutable verified upstream sources", () => {
    expect(SYNCTEX_SOURCE.url).toContain(SYNCTEX_SOURCE.commit);
    expect(ZLIB_SOURCE.url).toContain(ZLIB_SOURCE.commit);
    expect(SYNCTEX_SOURCE.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(ZLIB_SOURCE.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("maps release targets without hiding unsupported architectures", () => {
    expect(runtimePlatformKey("mac", "arm64")).toBe("darwin-arm64");
    expect(runtimePlatformKey("mac", "x64")).toBe("darwin-x64");
    expect(runtimePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(runtimePlatformKey("win", "x64")).toBe("win32-x64");
    expect(runtimeExecutableName("win")).toBe("synctex.exe");
    expect(runtimeExecutableName("linux")).toBe("synctex");
  });

  it("builds native or universal macOS binaries deliberately", () => {
    expect(cmakeArchitecture("mac", "arm64")).toBe("arm64");
    expect(cmakeArchitecture("mac", "x64")).toBe("x86_64");
    expect(cmakeArchitecture("mac", "universal")).toBe("arm64;x86_64");
    expect(cmakeArchitecture("linux", "x64")).toBeNull();
  });

  it("keeps the standalone define on the CLI translation unit only", () => {
    const project = renderCMakeProject({ syncTexDirectory: "/source", zlibDirectory: "/zlib" });
    expect(project).toContain(
      'set_source_files_properties("/source/synctex_main.c" PROPERTIES COMPILE_DEFINITIONS SYNCTEX_STANDALONE)',
    );
    expect(project).not.toContain("target_compile_definitions(synctex PRIVATE SYNCTEX_STANDALONE)");
    expect(project).toContain("target_link_libraries(synctex PRIVATE zlibstatic)");
    expect(project).toContain("target_link_libraries(synctex PRIVATE Shlwapi)");
    expect(project).toContain('CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"');
    expect(project).toContain("target_link_options(synctex PRIVATE -static");
  });

  it("rejects a source tree whose official interface versions drift", () => {
    expect(() =>
      assertPinnedSyncTexSource(
        '#define SYNCTEX_CLI_VERSION_STRING "1.7"\n#define SYNCTEX_VERSION_STRING "1.31"',
        "#if defined(SYNCTEX_STANDALONE)",
      ),
    ).not.toThrow();
    expect(() =>
      assertPinnedSyncTexSource(
        '#define SYNCTEX_CLI_VERSION_STRING "2.0"\n#define SYNCTEX_VERSION_STRING "1.31"',
        "#if defined(SYNCTEX_STANDALONE)",
      ),
    ).toThrow(/expected version/u);
  });

  it("rejects Linux output that still names a dynamic interpreter", () => {
    expect(() => assertStaticLinuxProgramHeaders("LOAD 0x0\nGNU_STACK 0x0")).not.toThrow();
    expect(() =>
      assertStaticLinuxProgramHeaders("INTERP 0x318 Requesting program interpreter"),
    ).toThrow(/dynamically linked/u);
  });
});
