import { describe, expect, it } from "vite-plus/test";

import {
  buildOverleafGitEnvironment,
  posixAskpassScript,
  windowsAskpassLauncher,
  windowsAskpassPowerShellScript,
} from "./OverleafGitExecutor.ts";

describe("Overleaf Git credential boundary", () => {
  it("constructs a closed environment without ambient Git, SSH, proxy, trace, or Node values", () => {
    const env = buildOverleafGitEnvironment({
      home: "C:/state/runtime/op/home",
      temp: "C:/state/runtime/op/tmp",
      childPath: "C:/Program Files/Git/cmd;C:/Windows/System32",
      hooks: "C:/state/runtime/op/hooks",
      globalConfig: "C:/state/runtime/op/gitconfig",
      globalExcludes: "C:/state/runtime/op/excludes",
      askpass: "C:/state/runtime/op/askpass.cmd",
      tokenPath: "C:/state/runtime/op/token with spaces",
      identity: { name: "Human Author", email: "human@example.com" },
      windows: {
        systemRoot: "C:/Windows",
        systemDrive: "C:",
        comspec: "C:/Windows/System32/cmd.exe",
        pathext: ".COM;.EXE;.BAT;.CMD",
        appData: "C:/state/runtime/op/home/AppData/Roaming",
        localAppData: "C:/state/runtime/op/home/AppData/Local",
      },
    });

    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS_REQUIRE: "force",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Human Author",
      GIT_COMMITTER_EMAIL: "human@example.com",
      SystemRoot: "C:/Windows",
      TEMP: "C:/state/runtime/op/tmp",
    });
    expect(
      Object.keys(env).some((key) => /^(?:SSH_|https?_proxy|GIT_TRACE|NODE_OPTIONS)/iu.test(key)),
    ).toBe(false);
    expect(Object.values(env).join("\n")).not.toContain("AI");
    expect(Object.values(env).join("\n")).not.toContain("LLM");
  });

  it("uses newline-free askpass output and a packaged-app-independent Windows runtime", () => {
    const script = windowsAskpassPowerShellScript();
    const launcher = windowsAskpassLauncher(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\state with spaces\\askpass.ps1",
    );
    expect(script).toContain("File]::ReadAllText");
    expect(script).toContain("Console]::Out.Write");
    expect(script).not.toMatch(/WriteLine|\btype\b/iu);
    expect(launcher).toContain('powershell.exe"');
    expect(launcher).not.toContain("node");
    expect(launcher).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(posixAskpassScript()).toContain("printf '%s'");
  });
});
