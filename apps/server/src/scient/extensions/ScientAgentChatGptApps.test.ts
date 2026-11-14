import { describe, expect, it } from "@effect/vitest";

import { chatGptAppRows } from "./ScientAgentChatGptApps.ts";

describe("chatGptAppRows", () => {
  it("reports each connected app with its ChatGPT page", () => {
    const output = JSON.stringify({
      apps: [
        {
          id: "connector_2128aebfecb84f64a069897515042a44",
          name: "Gmail",
          description: "Gmail tools",
          tools: 21,
          readOnlyTools: 10,
        },
        { id: "connector_947e0d954944416db111db556030eea6", name: "Google Calendar", tools: 15 },
      ],
    });
    expect(chatGptAppRows(`starting\n${output}\n`)).toEqual([
      {
        name: "Gmail",
        scope: "chatgpt",
        status: "connected",
        toolCount: 21,
        connectUrl: "https://chatgpt.com/apps/gmail/connector_2128aebfecb84f64a069897515042a44",
        signedIn: true,
      },
      {
        name: "Google Calendar",
        scope: "chatgpt",
        status: "connected",
        toolCount: 15,
        connectUrl:
          "https://chatgpt.com/apps/google-calendar/connector_947e0d954944416db111db556030eea6",
        signedIn: true,
      },
    ]);
  });

  it("reports nothing for a failure or output it cannot read", () => {
    expect(chatGptAppRows(JSON.stringify({ error: { kind: "signed-out" } }))).toEqual([]);
    expect(
      chatGptAppRows(JSON.stringify({ apps: [{ id: "bad id", name: "X", tools: 1 }] })),
    ).toEqual([]);
    expect(chatGptAppRows("")).toEqual([]);
  });
});
