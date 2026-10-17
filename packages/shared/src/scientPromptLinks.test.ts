import { describe, expect, it } from "vite-plus/test";
import {
  buildScientNewThreadLink,
  parseScientNewThreadLink,
  parseScientThreadLinkPrompt,
  scientPromptLinkAppPath,
} from "./scientPromptLinks.ts";

describe("Scient prompt-link producer and consumer", () => {
  it("round-trips a draft and model context without a hosted authority", () => {
    const prompt = "Review β results & methods\nDo not send yet";
    const link = buildScientNewThreadLink({
      prompt,
      repository: { owner: "ScientFactory", name: "scient-desktop" },
      provider: "scient",
      model: "research",
    });
    expect(link.startsWith("scient://new?")).toBe(true);
    const path = scientPromptLinkAppPath(link);
    expect(path).not.toBeNull();
    expect(parseScientNewThreadLink(new URL(path!, "https://app.invalid").search)).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: prompt, hiddenCharacters: 0 },
        repository: { owner: "ScientFactory", name: "scient-desktop" },
        provider: "scient",
        model: "research",
      },
    });
  });

  it("accepts only registered Scient app schemes or an explicitly owned web origin", () => {
    expect(scientPromptLinkAppPath("scient-next-dev://threads/env/thread?prompt=hi")).toBe(
      "/env/thread?prompt=hi",
    );
    for (const link of [
      "t3code://new?prompt=hi",
      "scient-unregistered://new?prompt=hi",
      "https://app.t3.codes/new?prompt=hi",
      "https://scient.example/new?prompt=hi",
    ])
      expect(scientPromptLinkAppPath(link)).toBeNull();
    expect(
      scientPromptLinkAppPath("https://scient.example/new?prompt=hi", "https://scient.example"),
    ).toBe("/new?prompt=hi");
    expect(
      scientPromptLinkAppPath("https://elsewhere.example/new?prompt=hi", "https://scient.example"),
    ).toBeNull();
  });

  it("keeps hidden-character refusal and prompt-only review errors branded Scient", () => {
    expect(parseScientNewThreadLink("?prompt=%E2%80%8B")).toEqual({
      ok: false,
      error:
        "This prompt had only hidden characters, so it may be malicious. Scient did not open it.",
    });
    expect(parseScientThreadLinkPrompt("?prompt=a%E2%80%8Bb")).toEqual({
      ok: true,
      value: { text: "ab", hiddenCharacters: 1 },
    });
  });
});
