import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerSettings, ServerSettingsPatch } from "./settings";

describe("source control writing settings", () => {
  it("keeps legacy settings behavior unchanged by default", () => {
    const settings = Schema.decodeSync(ServerSettings)({});

    expect(settings.sourceControlWriting).toEqual({
      mode: "standard",
      customInstructions: "",
      followPullRequestTemplate: false,
    });
  });

  it("trims and bounds custom writing instructions", () => {
    expect(
      Schema.decodeSync(ServerSettingsPatch)({
        sourceControlWriting: {
          mode: "custom",
          customInstructions: "  Prefer concise, user-centered wording.  ",
        },
      }),
    ).toEqual({
      sourceControlWriting: {
        mode: "custom",
        customInstructions: "Prefer concise, user-centered wording.",
      },
    });

    expect(() =>
      Schema.decodeSync(ServerSettingsPatch)({
        sourceControlWriting: {
          customInstructions: "x".repeat(2001),
        },
      }),
    ).toThrow();
  });
});
