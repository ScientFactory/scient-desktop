// @effect-diagnostics nodeBuiltinImport:off -- The profile URL is the platform's file URL.
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { libraryInjectionKeys, officeArguments, officeEnvironment } from "./OfficeRenderer.ts";

const staging = {
  root: "/state/document-lab/jobs/job-1",
  profile: "/state/document-lab/jobs/job-1/profile",
  home: "/state/document-lab/jobs/job-1/home",
  tmp: "/state/document-lab/jobs/job-1/tmp",
  input: "/state/document-lab/jobs/job-1/in",
  output: "/state/document-lab/jobs/job-1/out",
};

describe("the LibreOffice worker launch", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "inherits nothing from the server, including a preload shim (%s)",
    (platform) => {
      const env = officeEnvironment({
        staging,
        platform,
        hostEnvironment: {
          LD_PRELOAD: "/tmp/lo_socket_shim.so",
          DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
          OPENAI_API_KEY: "secret",
          SystemRoot: "C:\\Windows",
          PATH: "/opt/homebrew/bin",
        },
      });
      expect(libraryInjectionKeys(env)).toEqual([]);
      expect(Object.values(env).join("\n")).not.toMatch(/lo_socket_shim|secret|homebrew/u);
      expect(env.HOME).toBe(staging.home);
      expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
      if (platform === "win32") expect(env.PATH).toBe("C:\\Windows\\System32");
    },
  );

  it("names injected library variables in any case", () => {
    expect(
      libraryInjectionKeys({
        LD_PRELOAD: "x",
        dyld_insert_libraries: "y",
        LD_AUDIT: "z",
        HOME: "/h",
      }),
    ).toEqual(["LD_PRELOAD", "dyld_insert_libraries", "LD_AUDIT"]);
  });

  it("converts only staged files with a throwaway profile", () => {
    const args = officeArguments(staging, [`${staging.input}/candidate.docx`]);
    expect(args[0]).toBe(`-env:UserInstallation=${NodeURL.pathToFileURL(staging.profile).href}`);
    expect(args).toContain("--headless");
    expect(args.slice(-3)).toEqual(["--outdir", staging.output, `${staging.input}/candidate.docx`]);
  });
});
