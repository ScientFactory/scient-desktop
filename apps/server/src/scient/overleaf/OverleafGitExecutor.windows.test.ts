// @effect-diagnostics nodeBuiltinImport:off -- Real Windows executables and security descriptors.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { make } from "./OverleafGitExecutor.ts";
import { makeGitScratch } from "./OverleafGitScratch.ts";
import { withExecutor, windowsCompilerCommand } from "./OverleafGitExecutor.testkit.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const acl = (path: string) =>
  JSON.parse(
    NodeChildProcess.execFileSync(
      NodePath.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$a=if ([IO.Directory]::Exists($env:SCIENT_TEST_ACL_PATH)) { [IO.Directory]::GetAccessControl($env:SCIENT_TEST_ACL_PATH) } else { [IO.File]::GetAccessControl($env:SCIENT_TEST_ACL_PATH) }; @{protected=$a.AreAccessRulesProtected; owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString()} })} | ConvertTo-Json -Depth 4 -Compress",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PSModulePath: NodePath.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "Modules",
          ),
          SCIENT_TEST_ACL_PATH: path,
        },
      },
    ),
  ) as {
    protected: boolean;
    owner: string;
    rules: { sid: string; inherited: boolean; type: string }[];
  };

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("Overleaf Git on Windows", () => {
  it.effect(
    "ignores command shims, directories and broken or old executables before a working Git",
    () =>
      withExecutor(({ runtimeRoot, work, publicationHelper }) =>
        Effect.gen(function* () {
          const directories = ["shim", "directory", "broken", "old"].map((name) =>
            NodePath.join(work, name),
          );
          for (const directory of directories) NodeFS.mkdirSync(directory);
          NodeFS.writeFileSync(
            NodePath.join(directories[0]!, "git.cmd"),
            "@echo git version 2.99.0\r\n",
          );
          NodeFS.mkdirSync(NodePath.join(directories[1]!, "git.exe"));
          NodeFS.writeFileSync(NodePath.join(directories[2]!, "git.exe"), "not an executable");
          NodeFS.writeFileSync(
            NodePath.join(directories[3]!, "old.c"),
            '#include <stdio.h>\nint main(void) { puts("git version 2.38.0"); return 0; }\n',
          );
          windowsCompilerCommand("cl.exe /nologo /W4 /WX old.c /Fe:git.exe", directories[3]!);
          const environment = {
            ...process.env,
            PATH: [...directories, process.env.PATH ?? process.env.Path].join(";"),
            PATHEXT: ".CMD;.EXE",
          };
          const git = yield* make({ runtimeRoot, publicationHelper }).pipe(
            Effect.provideService(HostProcess.Environment, environment),
          );
          const found = yield* git.availability;
          expect(found.executable.toLowerCase()).toMatch(/git\.exe$/u);
          expect(directories.some((directory) => found.executable.startsWith(directory))).toBe(
            false,
          );
        }),
      ),
  );

  it.effect("creates scratch and token files private even under a broadly inherited parent", () =>
    withExecutor(({ work, publicationHelper }) =>
      Effect.gen(function* () {
        NodeChildProcess.execFileSync(
          NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
          [work, "/grant", "*S-1-5-32-545:(OI)(CI)R"],
        );
        const scratch = yield* Effect.promise(() =>
          makeGitScratch(NodePath.join(work, "runtime"), true, publicationHelper),
        );
        const directory = yield* Effect.promise(() => scratch.create());
        const token = NodePath.join(directory, "token");
        NodeFS.writeFileSync(token, "dummy-token-canary");
        const directoryAcl = acl(directory);
        expect(directoryAcl.protected).toBe(true);
        expect(acl(work).rules.some((rule) => rule.sid === "S-1-5-32-545")).toBe(true);
        for (const security of [directoryAcl, acl(token)]) {
          expect(security.rules.length).toBeGreaterThan(0);
          expect(
            security.rules.every(
              (rule) =>
                rule.type === "Allow" && [directoryAcl.owner, "S-1-5-18"].includes(rule.sid),
            ),
          ).toBe(true);
        }
        const root = NodePath.join(work, "broad");
        NodeFS.mkdirSync(root);
        const exit = yield* Effect.tryPromise(() => makeGitScratch(root, true)).pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
      }),
    ),
  );
});
