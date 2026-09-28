// @vitest-environment happy-dom
import { SCIC_MEDIA_TYPE } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  conversationFileDrag,
  installConversationImportDropTarget,
  type ConversationFileDrag,
} from "./drop";
import { requestConversationImport, useConversationImportRequests } from "./requests";

let uninstall: () => void;
let onDragChange: ReturnType<typeof vi.fn<(drag: ConversationFileDrag | null) => void>>;
let chat: HTMLDivElement;
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

beforeEach(() => {
  useConversationImportRequests.setState({ nextId: 0, queue: [], replaceable: false });
  onDragChange = vi.fn<(drag: ConversationFileDrag | null) => void>();
  uninstall = installConversationImportDropTarget(window, onDragChange);
  // Stands in for the chat column and composer, which take every file drop.
  chat = document.createElement("div");
  chatEvents = [];
  for (const type of ["dragenter", "dragover", "drop"]) {
    chat.addEventListener(type, (event) => {
      chatEvents.push(type);
      event.preventDefault();
    });
  }
  document.body.append(chat);
});

afterEach(() => {
  uninstall();
  chat.remove();
});

const queue = () => useConversationImportRequests.getState().queue;

describe("app conversation file drop", () => {
  it("imports a .scic dropped on the chat column instead of attaching it", () => {
    const archive = new File(["archive"], "source.SCIC");
    fileDrag("dragenter", [archive], chat, [""]);
    const over = fileDrag("dragover", [archive], chat, [""]);
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("copy");

    const dropped = fileDrag("drop", [archive], chat);
    expect(dropped.event.defaultPrevented).toBe(true);
    expect(chatEvents).toEqual([]);
    expect(queue()).toHaveLength(1);
    expect(queue()[0]?.source).toEqual({ _tag: "browser-file", file: archive });
  });

  it("keeps other files and Markdown attaching on the chat column", () => {
    const notes = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    fileDrag("dragover", [notes], chat);
    fileDrag("drop", [notes], chat);
    const script = new File(["x"], "Makefile");
    fileDrag("dragover", [script], chat, [""]);
    fileDrag("drop", [script], chat);
    expect(chatEvents).toEqual(["dragover", "drop", "drop"]);
    expect(queue()).toHaveLength(0);
  });

  it("imports a single Markdown file dropped where nothing else takes it", () => {
    const notes = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    expect(fileDrag("dragover", [notes]).event.defaultPrevented).toBe(true);
    fileDrag("drop", [notes]);
    expect(queue()[0]?.source).toEqual({ _tag: "browser-file", file: notes });
  });

  it("leaves multiple files and other formats with their owners", () => {
    const archive = new File(["archive"], "source.scic");
    fileDrag("drop", [archive, archive]);
    fileDrag("drop", [new File(["text"], "notes.txt")]);
    expect(queue()).toHaveLength(0);
  });

  it("reports the drag for the overlay and clears it when the drag ends", () => {
    const archive = new File(["archive"], "source.scic", { type: SCIC_MEDIA_TYPE });
    fileDrag("dragenter", [archive], chat);
    expect(onDragChange).toHaveBeenLastCalledWith("conversation");
    expect(chatEvents).toEqual([]);
    fileDrag("dragleave", [archive], chat);
    expect(onDragChange).toHaveBeenLastCalledWith(null);

    fileDrag("dragenter", [archive], chat, [""]);
    expect(onDragChange).toHaveBeenLastCalledWith("possible-conversation");
    fileDrag("drop", [archive], chat);
    expect(onDragChange).toHaveBeenLastCalledWith(null);
  });

  it("gives a file dropped on an open import dialog to that dialog", () => {
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

  it("queues a dropped file behind a request no dialog is showing yet", () => {
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

  it("judges a drag by the one file's reported type", () => {
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
