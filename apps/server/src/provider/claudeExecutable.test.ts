import { describe, expect, it, vi } from "vitest";

import { resolveClaudeSdkExecutablePath } from "./claudeExecutable";

const NPM_DIRECTORY = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const NPM_SHIM = `${NPM_DIRECTORY}\\claude.cmd`;
const NPM_NATIVE_ENTRY = `${NPM_DIRECTORY}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const NPM_SCRIPT_ENTRY = `${NPM_DIRECTORY}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const PROJECT_DIRECTORY = "C:\\repo";
const PROJECT_SHIM = `${PROJECT_DIRECTORY}\\node_modules\\.bin\\claude.cmd`;
const PROJECT_NATIVE_ENTRY = `${PROJECT_DIRECTORY}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

describe("resolveClaudeSdkExecutablePath", () => {
  it("leaves non-Windows executables unchanged", () => {
    const resolveCommandPath = vi.fn(() => "must-not-be-used");
    expect(
      resolveClaudeSdkExecutablePath("/custom/claude", {
        platform: "darwin",
        resolveCommandPath,
      }),
    ).toBe("/custom/claude");
    expect(resolveCommandPath).not.toHaveBeenCalled();
  });

  it("returns a resolved native Windows executable", () => {
    const nativeExecutable = "C:\\Users\\dev\\bin\\claude.exe";
    expect(
      resolveClaudeSdkExecutablePath("claude", {
        platform: "win32",
        resolveCommandPath: () => nativeExecutable,
      }),
    ).toBe(nativeExecutable);
  });

  it.each([".cmd", ".bat", ".ps1", ".CMD"])(
    "follows an npm %s launcher to the packaged native executable",
    (extension) => {
      const shim = `${NPM_DIRECTORY}\\claude${extension}`;
      expect(
        resolveClaudeSdkExecutablePath("claude", {
          platform: "win32",
          resolveCommandPath: () => shim,
          isFile: (candidate) => candidate === NPM_NATIVE_ENTRY,
        }),
      ).toBe(NPM_NATIVE_ENTRY);
    },
  );

  it("falls back to cli.js for older npm packages", () => {
    expect(
      resolveClaudeSdkExecutablePath("claude", {
        platform: "win32",
        resolveCommandPath: () => NPM_SHIM,
        isFile: (candidate) => candidate === NPM_SCRIPT_ENTRY,
      }),
    ).toBe(NPM_SCRIPT_ENTRY);
  });

  it("follows a project-local node_modules shim to its sibling package", () => {
    expect(
      resolveClaudeSdkExecutablePath("claude", {
        platform: "win32",
        resolveCommandPath: () => PROJECT_SHIM,
        isFile: (candidate) => candidate === PROJECT_NATIVE_ENTRY,
      }),
    ).toBe(PROJECT_NATIVE_ENTRY);
  });

  it("keeps the configured path when a launcher has no known package entry", () => {
    expect(
      resolveClaudeSdkExecutablePath("claude", {
        platform: "win32",
        resolveCommandPath: () => NPM_SHIM,
        isFile: () => false,
      }),
    ).toBe("claude");
  });
});
