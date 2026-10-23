import { SCIC_MEDIA_TYPE } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  conversationFileDrag,
  installConversationImportDropTarget,
  type ConversationFileDrag,
} from "./drop";
import { requestConversationImport, useConversationImportRequests } from "./requests";

let uninstall: () => void;
let onDragChange: ReturnType<typeof vi.fn<(drag: ConversationFileDrag | null) => void>>;

let chatEvents: string[];

function fileDrag(
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  files: ReadonlyArray<File>,
  target: EventTarget = document.body,
  itemTypes: ReadonlyArray<string> = files.map((file) => file.type),
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = {
    types: ["Files"],
    // Browsers expose kind and type during a drag, and files only on drop.
    items: itemTypes.map((itemType) => ({ kind: "file", type: itemType })),
    files: type === "drop" ? files : [],
    dropEffect: "none",
  };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return { event, dataTransfer };
}

async function _setupFixture0(_fixture: _Fixture) {
  useConversationImportRequests.setState({ nextId: 0, queue: [], replaceable: false });
  onDragChange = vi.fn<(drag: ConversationFileDrag | null) => void>();
  uninstall = installConversationImportDropTarget(window, onDragChange);
  // Stands in for the chat column and composer, which take every file drop.
  _fixture.chat = document.createElement("div");
  chatEvents = [];
  for (const type of ["dragenter", "dragover", "drop"]) {
    _fixture.chat.addEventListener(type, (event) => {
      chatEvents.push(type);
      event.preventDefault();
    });
  }
  document.body.append(_fixture.chat);
}

async function _cleanupFixture1(_fixture: _Fixture) {
  uninstall();
  _fixture.chat.remove();
}

const queue = () => useConversationImportRequests.getState().queue;

describe("app conversation file drop", () => {
  it("imports a .scic dropped on the chat column instead of attaching it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const archive = new File(["archive"], "source.SCIC");
    fileDrag("dragenter", [archive], _fixture.chat, [""]);
    const over = fileDrag("dragover", [archive], _fixture.chat, [""]);
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("copy");

    const dropped = fileDrag("drop", [archive], _fixture.chat);
    expect(dropped.event.defaultPrevented).toBe(true);
    expect(chatEvents).toEqual([]);
    expect(queue()).toHaveLength(1);
    expect(queue()[0]?.source).toEqual({ _tag: "browser-file", file: archive });
  });

  it("keeps other files and Markdown attaching on the chat column", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const notes = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    fileDrag("dragover", [notes], _fixture.chat);
    fileDrag("drop", [notes], _fixture.chat);
    const script = new File(["x"], "Makefile");
    fileDrag("dragover", [script], _fixture.chat, [""]);
    fileDrag("drop", [script], _fixture.chat);
    expect(chatEvents).toEqual(["dragover", "drop", "drop"]);
    expect(queue()).toHaveLength(0);
  });

  it("imports a single Markdown file dropped where nothing else takes it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const notes = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    expect(fileDrag("dragover", [notes]).event.defaultPrevented).toBe(true);
    fileDrag("drop", [notes]);
    expect(queue()[0]?.source).toEqual({ _tag: "browser-file", file: notes });
  });

  it("leaves multiple files and other formats with their owners", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const archive = new File(["archive"], "source.scic");
    fileDrag("drop", [archive, archive]);
    fileDrag("drop", [new File(["text"], "notes.txt")]);
    expect(queue()).toHaveLength(0);
  });

  it("reports the drag for the overlay and clears it when the drag ends", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const archive = new File(["archive"], "source.scic", { type: SCIC_MEDIA_TYPE });
    fileDrag("dragenter", [archive], _fixture.chat);
    expect(onDragChange).toHaveBeenLastCalledWith("conversation");
    expect(chatEvents).toEqual([]);
    fileDrag("dragleave", [archive], _fixture.chat);
    expect(onDragChange).toHaveBeenLastCalledWith(null);

    fileDrag("dragenter", [archive], _fixture.chat, [""]);
    expect(onDragChange).toHaveBeenLastCalledWith("possible-conversation");
    fileDrag("drop", [archive], _fixture.chat);
    expect(onDragChange).toHaveBeenLastCalledWith(null);
  });

  it("gives a file dropped on an open import dialog to that dialog", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    requestConversationImport();
    // The dialog is on screen.
    useConversationImportRequests.setState({ replaceable: true });
    const first = new File(["a"], "first.scic");
    const second = new File(["b"], "second.scic");
    fileDrag("drop", [first]);
    fileDrag("drop", [second]);
    expect(queue()).toHaveLength(1);
    expect(queue()[0]?.source).toEqual({ _tag: "browser-file", file: second });

    // While that dialog commits an import, a dropped file waits its turn.
    useConversationImportRequests.setState({ replaceable: false });
    fileDrag("drop", [first]);
    expect(queue().map((request) => request.source)).toEqual([
      { _tag: "browser-file", file: second },
      { _tag: "browser-file", file: first },
    ]);
  });

  it("queues a dropped file behind a request no dialog is showing yet", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const first = new File(["a"], "first.scic");
    const second = new File(["b"], "second.scic");
    fileDrag("drop", [first]);
    fileDrag("drop", [second]);
    expect(queue().map((request) => request.source)).toEqual([
      { _tag: "browser-file", file: first },
      { _tag: "browser-file", file: second },
    ]);
  });
});

describe("conversationFileDrag", () => {
  const drag = (items: ReadonlyArray<{ kind: string; type: string }>) =>
    conversationFileDrag({
      types: ["Files"],
      items: items as unknown as DataTransferItemList,
    });

  it("judges a drag by the one file's reported type", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(drag([{ kind: "file", type: SCIC_MEDIA_TYPE }])).toBe("conversation");
    expect(drag([{ kind: "file", type: "" }])).toBe("possible-conversation");
    expect(drag([{ kind: "file", type: "application/octet-stream" }])).toBe(
      "possible-conversation",
    );
    expect(drag([{ kind: "file", type: "image/png" }])).toBeNull();
    expect(drag([{ kind: "string", type: "text/plain" }])).toBeNull();
    expect(
      drag([
        { kind: "file", type: "" },
        { kind: "file", type: "" },
      ]),
    ).toBeNull();
    expect(conversationFileDrag(null)).toBeNull();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    chat: undefined! as HTMLDivElement,
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
