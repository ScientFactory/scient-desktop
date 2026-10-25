// @effect-diagnostics nodeBuiltinImport:off -- Event-driven fake of the portal transport.
import * as NodeEvents from "node:events";
import { Message, MessageType, Variant, type MessageBus } from "dbus-next";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { PortalCaptureShortcut } from "./PortalCaptureShortcut.ts";

const chord = {
  key: "2",
  modKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: true,
  metaKey: false,
};
const root = "/org/freedesktop/portal/desktop";
const portal = "org.freedesktop.portal.GlobalShortcuts";
const clients: PortalCaptureShortcut[] = [];
type Shortcut = [string, { description?: Variant<string>; trigger_description?: Variant<string> }];

class FakeBus extends NodeEvents.EventEmitter {
  calls: Message[] = [];
  sends: Message[] = [];
  disconnect = vi.fn();
  registryError: Error | undefined;
  version = 2;
  autoBind = true;
  actualLabel = "Ctrl+Shift+2";
  bindStatus = 0;
  session = "";
  requestPath = "";
  boundId = "";
  foreignHandle = false;

  send(message: Message) {
    this.sends.push(message);
  }
  signal(
    iface: string,
    member: string,
    path: string,
    body: unknown[],
    sender = ":1.2",
    signature = "",
  ) {
    this.emit(
      "message",
      new Message({
        type: MessageType.SIGNAL,
        sender,
        interface: iface,
        member,
        path,
        body,
        signature,
      }),
    );
  }
  response(path: string, status: number, results: Record<string, Variant<unknown>>) {
    this.signal("org.freedesktop.portal.Request", "Response", path, [status, results]);
  }
  respondBind(status = this.bindStatus) {
    this.response(this.requestPath, status, {
      shortcuts: new Variant("a(sa{sv})", [
        [
          this.boundId,
          {
            description: new Variant("s", "Capture a window"),
            trigger_description: new Variant("s", this.actualLabel),
          },
        ],
      ]),
    });
  }
  activate(id = this.boundId, session = this.session, sender = ":1.2") {
    this.signal(portal, "Activated", root, [session, id, 1, {}], sender, "osta{sv}");
  }
  async call(message: Message) {
    this.calls.push(message);
    const reply = (body: unknown[] = []) =>
      new Message({
        type: MessageType.METHOD_RETURN,
        replySerial: "1",
        destination: ":1.23",
        body,
      });
    if (message.member === "Register") {
      if (this.registryError) throw this.registryError;
      return reply();
    }
    if (message.member === "GetNameOwner") return reply([":1.2"]);
    if (message.member === "Get") return reply([new Variant("u", this.version)]);
    if (message.member === "AddMatch" || message.member === "ConfigureShortcuts") return reply();
    const options = message.body.at(-1) as Record<string, Variant<string>>;
    const path = `${root}/request/1_23/${options.handle_token!.value}`;
    if (message.member === "CreateSession") {
      this.session = `${root}/session/1_23/${options.session_handle_token!.value}`;
      this.response(path, 0, {
        session_handle: new Variant(
          "s",
          this.foreignHandle ? `${root}/session/9_9/other` : this.session,
        ),
      });
    } else if (message.member === "BindShortcuts") {
      this.boundId = (message.body[1] as Shortcut[])[0]![0];
      this.requestPath = path;
      this.emit("bind");
      if (this.autoBind) this.respondBind();
    } else throw new Error(`Unexpected call: ${message.member}`);
    return reply([path]);
  }
}

function start(bus = new FakeBus(), shortcut = chord, managedByHyprland = false) {
  const capture = vi.fn();
  const changed = vi.fn();
  const client = new PortalCaptureShortcut(
    "com.t3tools.T3Code",
    shortcut,
    capture,
    changed,
    bus as unknown as MessageBus,
    managedByHyprland,
  );
  clients.push(client);
  return { bus, client, capture, changed };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// regression: 299404a754 feat(desktop): add cross-platform window capture (#8103)
it("guides users to manual desktop settings when the portal cannot open them", async () => {
  const bus = new FakeBus();
  bus.version = 1;
  bus.bindStatus = 1;
  const { client } = start(bus);
  await client.ready;
  expect(client.hasSession).toBe(true);
  expect(client.state.shortcutCanRetry).toBe(false);
  expect(client.state.shortcutMessage).toBe(
    "Shortcut permission wasn't granted. Allow Scient in your desktop's shortcut settings.",
  );
  await expect(client.configure()).rejects.toThrow("Open your desktop's shortcut settings");
  expect(bus.calls.some((message) => message.member === "ConfigureShortcuts")).toBe(false);
  client.close();
  expect(client.hasSession).toBe(false);
});
