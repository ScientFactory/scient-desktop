import { EnvironmentId, defaultBrowserProfileRecord } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { notSent, remoteView, type RemoteLineInput } from "./remoteComputersView";

const at = "2026-11-04T10:14:00.000Z";
const share = (overrides = {}) => ({
  environmentId: EnvironmentId.make("lab"),
  label: "Lab server",
  sentAt: at,
  seenAt: at,
  applied: 3,
  waiting: 0,
  needsYou: [] as string[],
  ...overrides,
});
const view = (overrides: Partial<RemoteLineInput> = {}) =>
  remoteView({
    phase: "connected",
    sharing: true,
    sending: false,
    refused: undefined,
    remote: { accountsProtocol: 1 },
    shared: [share()],
    universities: [],
    ...overrides,
  });
const kind = (overrides: Partial<RemoteLineInput> = {}) => view(overrides).state.kind;

describe("another computer's line", () => {
  it("takes the first state that matches", () => {
    expect(kind({ sharing: false, sending: true })).toBe("sharing-off");
    expect(kind({ sending: true, refused: "relay" })).toBe("sending");
    expect(kind({ failure: { reason: "refused", at }, refused: "relay" })).toBe("failed");
    expect(kind({ refused: "unencrypted", remote: {} })).toBe("refused");
    expect(kind({ remote: {} })).toBe("outdated");
    expect(kind()).toBe("delivered");
    expect(view({ phase: "offline" }).state).toEqual({
      kind: "offline",
      sentAt: at,
      seenAt: at,
    });
    // An older computer offline still shows what it holds.
    expect(kind({ phase: "offline", remote: {} })).toBe("offline");
    expect(kind({ shared: [] })).toBe("on-connect");
  });

  it("adds what needs the user there, across profiles", () => {
    const line = view({
      shared: [
        share({ needsYou: ["github.com"], kept: 3, waiting: 2 }),
        share({ needsYou: ["github.com", "overleaf.com"], waiting: 1 }),
      ],
      universities: ["HUJI"],
    });
    expect(line.needsYou).toEqual(["github.com", "overleaf.com"]);
    expect(line).toMatchObject({ kept: 3, waiting: 3, universities: ["HUJI"] });
  });

  it("names the persistent profiles that stay here, with why", () => {
    const record = (overrides = {}) => ({ ...defaultBrowserProfileRecord("work"), ...overrides });
    expect(
      notSent([
        { id: "default", name: "Main", record: record() },
        {
          id: "work",
          name: "Work",
          record: record({ scope: { type: "projects", projectIds: [] } }),
        },
        { id: "old", name: "Old", record: record({ access: "off" }) },
      ]),
    ).toEqual([
      { name: "Work", reason: "projects" },
      { name: "Old", reason: "off" },
    ]);
  });
});
