import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $copyNode, $getRoot, $isElementNode, PASTE_COMMAND, type LexicalEditor } from "lexical";
import { act, createRef } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { collapseExpandedComposerCursor } from "../composer-logic";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { ComposerCitationNode } from "./ComposerCitationNode";
import { EnvironmentId, ThreadId, type FileCitation } from "@t3tools/contracts";
import {
  serializeComposerCitation,
  collectComposerCitations,
} from "@t3tools/shared/composerCitations";

vi.mock("./chat/FileTagChip", () => ({
  FILE_TAG_CHIP_CLASS_NAME: "",
  FileTagChipContent: () => null,
}));
vi.mock("./chat/ComposerPendingTerminalContexts", () => ({
  ComposerPendingTerminalContextChip: () => null,
}));
vi.mock("./chat/AssistantCitationChip", () => ({
  AssistantCitationChip: () => null,
  CitationChip: () => null,
}));

let lexicalEditor: LexicalEditor;
// Keep the real composer, registered nodes, updates, and snapshot API. Only the
// DOM view is omitted so Lexical runs headlessly in this component test.
vi.mock("@lexical/react/LexicalPlainTextPlugin", () => ({
  PlainTextPlugin: function HeadlessEditor() {
    [lexicalEditor] = useLexicalComposerContext();
    return null;
  },
}));

let renderer: ReactTestRenderer | undefined;
const editorRef = createRef<ComposerPromptEditorHandle>();

function composer(value: string) {
  return (
    <ComposerPromptEditor
      value={value}
      cursor={collapseExpandedComposerCursor(value, value.length)}
      terminalContexts={[]}
      skills={[]}
      disabled={false}
      placeholder="Write a prompt"
      onRemoveTerminalContext={() => {}}
      onChange={() => {}}
      onPaste={() => {}}
      editorRef={editorRef}
    />
  );
}

async function renderPrompt(value: string) {
  await act(() => {
    if (renderer) renderer.update(composer(value));
    else renderer = create(composer(value));
  });
}

function $firstMention() {
  const paragraph = $getRoot().getFirstChildOrThrow();
  if (!$isElementNode(paragraph)) throw new Error("Expected a composer paragraph");
  const mention = paragraph.getFirstChildOrThrow();
  if (mention.getType() !== "composer-mention") throw new Error("Expected a mention");
  return mention;
}

class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer;

  constructor(text: string) {
    super("paste", { cancelable: true });
    this.clipboardData = {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    } as unknown as DataTransfer;
  }
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { activeElement: null });
});

describe("file quotes share the real composer inline node", () => {
  const citation: FileCitation = {
    kind: "file",
    version: 1,
    environmentId: EnvironmentId.make("remote"),
    threadId: ThreadId.make("thread"),
    cwd: "/project",
    path: "docs/雪 👋.md",
    revision: `sha256:${"a".repeat(64)}`,
    origin: "draft",
    sourceStart: 0,
    sourceEnd: 90,
    startLine: 1,
    endLine: 4,
    from: 1,
    to: 12,
    text: "selected text\n  indentation",
    prefix: "",
    suffix: "",
    comment: "Explain",
  };
  function $citation() {
    const paragraph = $getRoot().getFirstChildOrThrow();
    if (!$isElementNode(paragraph)) throw new Error("Expected paragraph");
    const node = paragraph.getChildren().find((entry) => entry instanceof ComposerCitationNode);
    if (!(node instanceof ComposerCitationNode)) throw new Error("Expected citation");
    return node;
  }
  it("survives adjacent file mentions, controlled replacements, clone, JSON reload and comment edits", async () => {
    const token = serializeComposerCitation(citation);
    const prompt = `[notes.md](notes.md) ${token} trailing text`;
    await renderPrompt(prompt);
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
    await act(() =>
      lexicalEditor.update(
        () => {
          const node = $citation();
          expect(node.isInline()).toBe(true);
          node.replace($copyNode(node));
        },
        { discrete: true },
      ),
    );
    const exported = lexicalEditor.getEditorState().toJSON();
    await renderPrompt("");
    await act(() => lexicalEditor.setEditorState(lexicalEditor.parseEditorState(exported)));
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
    await act(() =>
      lexicalEditor.update(() => $citation().setComment("  New comment  "), { discrete: true }),
    );
    const updated = editorRef.current!.readSnapshot().value;
    expect(collectComposerCitations(updated)[0]?.citation).toEqual({
      ...citation,
      comment: "New comment",
    });
    expect(updated.startsWith("[notes.md](notes.md) ")).toBe(true);
    expect(updated.endsWith(" trailing text")).toBe(true);
    await act(() => lexicalEditor.update(() => $citation().remove(), { discrete: true }));
    expect(editorRef.current!.readSnapshot().value).toBe("[notes.md](notes.md)  trailing text");
  });
  it("pastes one file citation atomically with its quote and comment", async () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    await renderPrompt("Before ");
    const token = serializeComposerCitation(citation);
    const event = new TestClipboardEvent(token);
    await act(() =>
      lexicalEditor.update(
        () => {
          $getRoot().selectEnd();
          lexicalEditor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
        },
        { discrete: true },
      ),
    );
    expect(event.defaultPrevented).toBe(true);
    expect(editorRef.current!.readSnapshot().value).toBe(`Before ${token}`);
    expect(collectComposerCitations(editorRef.current!.readSnapshot().value)).toHaveLength(1);
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("composer mention serialization", () => {
  it.each([
    "@README.md control",
    "@terminal-1:3 Explain this output\n\n<terminal_context>\n- Terminal 1 line 3:\n  3 | output\n</terminal_context>",
    '@"docs/My \\"File\\".md" please',
    '@"docs/雪 👋.md" please',
    "[README.md](README.md) control",
    "[config#draft?.json](config%23draft%3f.json) control",
    "Plain text\n  Keep indentation 👋",
  ])("preserves the initial prompt %s", async (prompt) => {
    await renderPrompt(prompt);
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
  });

  it("preserves original source when replacing the controlled prompt", async () => {
    for (const prompt of ["", "@README.md control", "Older plain control", "@README.md control"]) {
      await renderPrompt(prompt);
      expect(editorRef.current?.readSnapshot()).toMatchObject({
        value: prompt,
        expandedCursor: prompt.length,
      });
      if (prompt === "@README.md control") {
        expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
      }
    }
  });

  it("preserves source when Lexical clones the mention and reloads exported state", async () => {
    const prompt = '@"docs/雪 👋.md" remains a chip';
    await renderPrompt(prompt);
    const originalKey = lexicalEditor.getEditorState().read(() => $firstMention().getKey());

    await act(() => {
      lexicalEditor.update(
        () => {
          const mention = $firstMention();
          mention.replace($copyNode(mention));
        },
        { discrete: true },
      );
    });
    expect(lexicalEditor.getEditorState().read(() => $firstMention().getKey())).not.toBe(
      originalKey,
    );
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
    const exportedState = lexicalEditor.getEditorState().toJSON();

    await renderPrompt("");
    await act(() => {
      lexicalEditor.setEditorState(lexicalEditor.parseEditorState(exportedState));
    });
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
    expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
  });

  it("keeps canonical serialization when importing legacy mention JSON without source", async () => {
    await renderPrompt("");
    await act(() => {
      lexicalEditor.setEditorState(
        lexicalEditor.parseEditorState(
          JSON.stringify({
            root: {
              type: "root",
              version: 1,
              children: [
                {
                  type: "paragraph",
                  version: 1,
                  children: [{ type: "composer-mention", version: 1, path: "README.md" }],
                },
              ],
            },
          }),
        ),
      );
    });
    expect(editorRef.current?.readSnapshot().value).toBe("[README.md](README.md)");
    expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
  });

  it("still serializes a newly inserted mention canonically", async () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    await renderPrompt("");
    const event = new TestClipboardEvent("@README.md ");
    await act(() => {
      lexicalEditor.update(
        () => {
          $getRoot().selectEnd();
          lexicalEditor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
        },
        { discrete: true },
      );
    });
    expect(event.defaultPrevented).toBe(true);
    expect(editorRef.current?.readSnapshot().value).toBe("[README.md](README.md) ");
    expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
  });
});
