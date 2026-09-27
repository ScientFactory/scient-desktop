// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { installConversationImportDropTarget } from "./drop";
import { useConversationImportRequests } from "./requests";

let uninstall: () => void;

function dispatchFileDrag(type: "dragover" | "drop", files: File[], claimed = false) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = {
    types: ["Files"],
    items: files.map(() => ({ kind: "file" })),
    files,
    dropEffect: "none",
  };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  if (claimed) event.preventDefault();
  document.body.dispatchEvent(event);
  return { event, dataTransfer };
}

beforeEach(() => {
  useConversationImportRequests.setState({ nextId: 0, queue: [] });
  uninstall = installConversationImportDropTarget(window);
});

afterEach(() => uninstall());

describe("app conversation file drop", () => {
  it("opens one .scic or .md in the shared preview queue", () => {
    const archive = new File(["archive"], "source.SCIC");
    const drag = dispatchFileDrag("dragover", [archive]);
    expect(drag.event.defaultPrevented).toBe(true);
    expect(drag.dataTransfer.dropEffect).toBe("copy");

    const dropped = dispatchFileDrag("drop", [archive]);
    expect(dropped.event.defaultPrevented).toBe(true);
    expect(useConversationImportRequests.getState().queue[0]?.source).toEqual({
      _tag: "browser-file",
      file: archive,
    });

    dispatchFileDrag("drop", [new File(["# Notes"], "notes.md")]);
    expect(useConversationImportRequests.getState().queue).toHaveLength(2);
  });

  it("leaves claimed drops, multiple files, and other formats with their owners", () => {
    const archive = new File(["archive"], "source.scic");
    expect(dispatchFileDrag("drop", [archive], true).event.defaultPrevented).toBe(true);
    dispatchFileDrag("drop", [archive, archive]);
    dispatchFileDrag("drop", [new File(["text"], "notes.txt")]);
    expect(useConversationImportRequests.getState().queue).toHaveLength(0);
  });

  it("keeps separate requests for repeated imports of the same file", () => {
    const archive = new File(["archive"], "source.scic");
    dispatchFileDrag("drop", [archive]);
    dispatchFileDrag("drop", [archive]);
    const requests = useConversationImportRequests.getState().queue;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.id).not.toBe(requests[1]?.id);
  });
});
