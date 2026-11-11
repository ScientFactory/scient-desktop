import { describe, expect, it } from "@effect/vitest";
import { BrowserProfileId, ThreadId } from "@t3tools/contracts";

import { withThreadChoice } from "./profileChoices.ts";

describe("withThreadChoice", () => {
  it("clears the conversation's own profile and keeps its site switches", () => {
    const threadId = ThreadId.make("thread-1");
    const work = BrowserProfileId.make("work");
    const at = "2026-11-09T12:00:00.000Z";
    const switched = withThreadChoice(
      { projects: {}, threads: {} },
      { threadId, profileId: work, url: "https://moodle.example.edu/" },
      at,
    );
    expect(switched.threads[threadId]).toEqual({
      profileId: work,
      sites: { "moodle.example.edu": { profileId: work, at } },
    });
    expect(withThreadChoice(switched, { threadId, profileId: null }, at).threads[threadId]).toEqual(
      { sites: { "moodle.example.edu": { profileId: work, at } } },
    );
  });
});
