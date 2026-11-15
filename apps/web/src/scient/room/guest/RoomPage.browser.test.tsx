import {
  RoomMessageId,
  RoomParticipantId,
  RoomStreamEvent,
  ThreadRoomId,
  TurnItemId,
  type RoomGuestView,
  type RoomRole,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../../test/render";
import { makeThreadProjectionFixture } from "~/test-fixtures";
import { useRoomDirectStore } from "../roomDirectStore";
import { RoomPage } from "./RoomPage";

const participantId = RoomParticipantId.make("participant-1");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(RoomStreamEvent)));
const fixture = makeThreadProjectionFixture();
const at = DateTime.makeUnsafe("2026-11-13T12:00:00Z");
const roomItem = {
  id: TurnItemId.make("room-item"),
  threadId: fixture.thread.id,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  type: "room_message" as const,
  roomMessageId: RoomMessageId.make("message-1"),
  author: { kind: "owner" as const },
  text: "Please check the sample size",
  anchorRunOrdinal: null,
};
const view = (role: RoomRole): RoomGuestView => ({
  roomId: ThreadRoomId.make("room-1"),
  title: "Study discussion",
  me: { participantId, name: "Sam", role },
  participants: [{ participantId, name: "Sam", role, online: true }],
  expiresAt: "2099-11-20T12:00:00Z",
});
const viewEvent = (role: RoomRole): RoomStreamEvent => ({
  type: "view",
  view: view(role),
  model: { driver: null, name: "Model" },
});
const opening = (role: RoomRole): ReadonlyArray<RoomStreamEvent> => [
  viewEvent(role),
  {
    type: "thread",
    item: {
      kind: "snapshot",
      snapshotSequence: 1,
      projection: {
        ...fixture,
        turnItems: [roomItem],
        visibleTurnItems: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: fixture.thread.id,
            sourceItemId: roomItem.id,
            item: roomItem,
          },
        ],
      },
    },
  },
];
function visit(path: string): Disposable {
  const previous = window.location.href;
  window.history.replaceState(window.history.state, "", path);
  return {
    [Symbol.dispose]: () => window.history.replaceState(window.history.state, "", previous),
  };
}
function fakeStream(events: ReadonlyArray<RoomStreamEvent>, sources: Array<EventTarget>) {
  return class extends EventTarget {
    static readonly CLOSED = 2;
    readyState = 1;
    constructor(readonly url: string) {
      super();
      sources.push(this);
      queueMicrotask(() => {
        for (const event of events)
          this.dispatchEvent(new MessageEvent("message", { data: encode(event) }));
      });
    }
    close() {
      this.readyState = 2;
    }
  };
}
const send = (sources: Array<EventTarget>, event: RoomStreamEvent) =>
  sources.at(-1)!.dispatchEvent(new MessageEvent("message", { data: encode(event) }));
const wide = () => page.viewport(1100, 800);
// The "straight to the agent" switch is remembered per person; each test starts with it off.
const switchOff = () => useRoomDirectStore.getState().setDirect(`guest:${participantId}`, false);
const container = () => {
  const element = document.createElement("div");
  element.style.cssText = "height: 800px; width: 900px; display: flex; flex-direction: column;";
  return element;
};

describe("RoomPage", () => {
  it("joins after name submission, drops the credential, and returns using the session", async () => {
    using _page = visit("/guest?room#synthetic-invite.signature");
    await wide();
    const sources: Array<EventTarget> = [];
    using requests = vi.spyOn(window, "fetch").mockImplementation(async (url, init) => {
      if (url === "/api/room/join") {
        const body = JSON.parse(String(init?.body));
        return body.name === "Sam" && body.credential === "synthetic-invite.signature"
          ? Response.json({ participantId })
          : Response.json({ message: "Invalid join" }, { status: 400 });
      }
      return new Response(null, { status: 204 });
    });
    using _stream = vi
      .spyOn(window, "EventSource")
      .mockImplementation(fakeStream(opening("discuss"), sources) as never);
    await using screen = await render(<RoomPage />, { container: container() });
    await expect.element(screen.getByLabelText("Your name")).toBeVisible();
    expect(requests).not.toHaveBeenCalled();
    await userEvent.fill(screen.getByLabelText("Your name"), "Sam");
    await userEvent.click(screen.getByRole("button", { name: "Join", exact: true }));
    await expect.element(screen.getByRole("heading", { name: "Study discussion" })).toBeVisible();
    expect(window.location.search).toBe(`?room=${participantId}`);
    expect(window.location.hash).toBe("");
    await screen.rerender(<RoomPage key="reload" />);
    await expect
      .element(screen.getByRole("textbox", { name: "Message everyone", exact: true }))
      .toBeVisible();
    expect(screen.container.querySelector("#room-name")).toBeNull();
    expect(requests.mock.calls.filter(([url]) => url === "/api/room/join")).toHaveLength(1);
  });

  it("posts for everyone, goes straight to the agent when switched on, and follows permissions", async () => {
    using _page = visit(`/guest?room=${participantId}`);
    await wide();
    switchOff();
    const sources: Array<EventTarget> = [];
    const posts: Array<FormData> = [];
    using _requests = vi.spyOn(window, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/messages?") && init?.body instanceof FormData)
        posts.push(init.body);
      return new Response(null, { status: 204 });
    });
    using _stream = vi
      .spyOn(window, "EventSource")
      .mockImplementation(fakeStream(opening("agent"), sources) as never);
    await using screen = await render(<RoomPage />, { container: container() });
    const everyoneBox = () =>
      screen.getByRole("textbox", { name: "Message everyone", exact: true });
    const agentBox = () => screen.getByRole("textbox", { name: "Message the agent", exact: true });
    const agentSwitch = () => screen.getByRole("button", { name: "Send straight to the agent" });
    await userEvent.fill(everyoneBox(), "Hello people");
    await userEvent.keyboard("{Enter}");
    await expect.element(everyoneBox()).toHaveValue("");
    expect(posts[0]?.get("to")).toBe("people");
    await userEvent.click(agentSwitch());
    await expect.element(agentSwitch()).toHaveAttribute("aria-pressed", "true");
    await userEvent.fill(agentBox(), "Run it");
    await userEvent.keyboard("{Enter}");
    await expect.element(agentBox()).toHaveValue("");
    expect(posts[1]?.get("to")).toBe("agent");
    // Without the agent permission, everything is for everyone, whatever the switch said.
    send(sources, viewEvent("discuss"));
    await expect.element(agentSwitch()).not.toBeInTheDocument();
    await expect.element(everyoneBox()).toBeVisible();
    send(sources, viewEvent("watch"));
    await expect.element(everyoneBox()).not.toBeInTheDocument();
    await expect.element(screen.getByText(roomItem.text)).toBeVisible();
    send(sources, viewEvent("agent"));
    await expect.element(agentBox()).toBeVisible();
    switchOff();
  });

  it("shows a message in the thread until sent, and surfaces a rejected send", async () => {
    using _page = visit(`/guest?room=${participantId}`);
    await wide();
    switchOff();
    using _requests = vi.spyOn(window, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/send?")) {
        const body = JSON.parse(String(init?.body));
        return Response.json(
          { message: body.itemId === roomItem.id ? "The agent is unavailable" : "Wrong message" },
          { status: 409 },
        );
      }
      return new Response(null, { status: 204 });
    });
    using _stream = vi
      .spyOn(window, "EventSource")
      .mockImplementation(fakeStream(opening("agent"), []) as never);
    await using screen = await render(<RoomPage />, { container: container() });
    const thread = screen.getByRole("region", { name: "Thread" });
    await expect.element(thread.getByText(roomItem.text)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Send Owner's message to agent" }));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("The agent is unavailable");
  });

  it("keeps a failed post's text and files available for retry", async () => {
    using _page = visit(`/guest?room=${participantId}`);
    await wide();
    const sources: Array<EventTarget> = [];
    const posts: Array<FormData> = [];
    using _requests = vi.spyOn(window, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/messages?") && init?.body instanceof FormData) {
        posts.push(init.body);
        if (posts.length === 1)
          return Response.json({ message: "Please try again" }, { status: 503 });
      }
      return new Response(null, { status: 204 });
    });
    using _stream = vi
      .spyOn(window, "EventSource")
      .mockImplementation(fakeStream(opening("discuss"), sources) as never);
    await using screen = await render(<RoomPage />, { container: container() });
    const chatBox = () => screen.getByRole("textbox", { name: "Message everyone", exact: true });
    await expect.element(chatBox()).toBeVisible();
    await userEvent.fill(chatBox(), "Attached notes");
    await userEvent.upload(
      screen.getByLabelText("Files to attach"),
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Please try again");
    await expect.element(chatBox()).toHaveValue("Attached notes");
    await expect.element(screen.getByRole("button", { name: "Remove notes.txt" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await expect.element(chatBox()).toHaveValue("");
    await expect
      .element(screen.getByRole("button", { name: "Remove notes.txt" }))
      .not.toBeInTheDocument();
    expect(posts[1]?.get("text")).toBe("Attached notes");
    expect(posts[1]?.get("file")).toMatchObject({ name: "notes.txt" });
  });

  it("shows why a returning session was rejected without opening its stream", async () => {
    using _page = visit(`/guest?room=${participantId}`);
    await wide();
    using _requests = vi
      .spyOn(window, "fetch")
      .mockImplementation(async () =>
        Response.json(
          { reason: "removed", message: "Your room access was removed" },
          { status: 403 },
        ),
      );
    using source = vi.spyOn(window, "EventSource");
    await using screen = await render(<RoomPage />);
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Your room access was removed");
    expect(source).not.toHaveBeenCalled();
  });

  it("removes the timeline and composer when access expires live", async () => {
    using _page = visit(`/guest?room=${participantId}`);
    await wide();
    const sources: Array<EventTarget> = [];
    using _requests = vi
      .spyOn(window, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    using _stream = vi
      .spyOn(window, "EventSource")
      .mockImplementation(fakeStream(opening("discuss"), sources) as never);
    await using screen = await render(<RoomPage />, { container: container() });
    await expect
      .element(screen.getByRole("textbox", { name: "Message everyone", exact: true }))
      .toBeVisible();
    send(sources, { type: "ended", reason: "expired" });
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Your access to this room has expired.");
    await expect
      .element(screen.getByRole("textbox", { name: "Message everyone", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText(roomItem.text)).not.toBeInTheDocument();
  });
});
