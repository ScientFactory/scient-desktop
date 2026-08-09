import { describe, expect, it } from "vite-plus/test";

import { managedRuntimeSmokeEnvironment } from "./managedProviderRuntime.ts";

describe("managed provider runtime smoke environment", () => {
  it("keeps credential-free Windows host coordinates without forwarding provider secrets", () => {
    const environment = managedRuntimeSmokeEnvironment({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: "C:\\Users\\scientist",
      APPDATA: "C:\\Users\\scientist\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\scientist\\AppData\\Local",
      TEMP: "C:\\Users\\scientist\\AppData\\Local\\Temp",
      ANTHROPIC_API_KEY: "must-not-reach-smoke-test",
      CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-smoke-test",
      OPENAI_API_KEY: "must-not-reach-smoke-test",
    });

    expect(environment).toMatchObject({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: "C:\\Users\\scientist",
      APPDATA: "C:\\Users\\scientist\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\scientist\\AppData\\Local",
      TEMP: "C:\\Users\\scientist\\AppData\\Local\\Temp",
    });
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
  });
});
