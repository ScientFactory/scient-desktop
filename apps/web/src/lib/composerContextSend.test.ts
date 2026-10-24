import {
  ComposerContextId,
  EnvironmentId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import type { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

type Config = { environment: { capabilities: { inlineMessageContext?: boolean } } };
const state = vi.hoisted(() => ({
  configs: undefined as Atom.Writable<Map<EnvironmentId, Config>> | undefined,
}));
vi.mock("../state/server", async (original) => {
  const actual = await original<typeof import("../state/server")>();
  const { Atom } = await import("effect/reactivity");
  state.configs = Atom.make(new Map<EnvironmentId, Config>());
  return { ...actual, environmentServerConfigsAtom: state.configs };
});

import { appAtomRegistry } from "../rpc/atomRegistry";
import { prepareComposerContextMessage } from "./composerContextSend";

const environmentId = EnvironmentId.make("synthetic-send");
const otherEnvironment = EnvironmentId.make("synthetic-other-send");
const element = {
  pageUrl: "https://synthetic.test/checkout",
  pageTitle: "Checkout",
  tagName: "button",
  selector: "#submit",
  htmlPreview: '<button id="submit">Buy</button>',
  componentName: "SubmitButton",
  source: {
    functionName: "SubmitButton",
    fileName: "src/Checkout.tsx",
    lineNumber: 42,
    columnNumber: 7,
  },
  styles: "color: red;",
};
const context = {
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make("terminal_send"),
      kind: "terminal",
      label: "Terminal 1 lines 3-4",
      terminalId: "terminal-1",
      terminalLabel: "Terminal 1",
      lineStart: 3,
      lineEnd: 4,
      text: "boom\nagain",
    },
    {
      version: 1,
      contextId: ComposerContextId.make("element_send"),
      kind: "element",
      label: "Checkout button",
      ...element,
    },
    {
      version: 1,
      contextId: ComposerContextId.make("preview-annotation_send"),
      kind: "preview-annotation",
      label: "Fix checkout",
      annotationId: "annotation-send",
      pageUrl: element.pageUrl,
      pageTitle: "Checkout",
      comment: "Make the button clearer",
      targetSummary: "1 selected element",
      styleChanges: ["color: red → blue"],
      elements: [element],
    },
    {
      version: 1,
      contextId: ComposerContextId.make("review-comment_send"),
      kind: "review-comment",
      label: "b.ts L4",
      sectionId: "file:a/b.ts",
      sectionTitle: "File comment",
      filePath: "a/b.ts",
      startIndex: 3,
      endIndex: 3,
      rangeLabel: "L4",
      text: "Why this branch?",
      diff: "const stable = `ok`;",
      fenceLanguage: "ts",
    },
  ],
} satisfies OrchestrationMessageContext;
const text = `Inspect ${context.records.map(formatComposerContextReference).join(" and ")} please`;

function setup() {
  const configs = state.configs!;
  const unmount = appAtomRegistry.mount(configs);
  const previous = appAtomRegistry.get(configs);
  appAtomRegistry.set(configs, new Map());
  return {
    capability(id: EnvironmentId, value: boolean | undefined) {
      appAtomRegistry.update(configs, (current) =>
        new Map(current).set(id, {
          environment: { capabilities: value === undefined ? {} : { inlineMessageContext: value } },
        }),
      );
    },
    [Symbol.dispose]() {
      appAtomRegistry.set(configs, previous);
      unmount();
    },
  };
}

function expectLegacy(message: ReturnType<typeof prepareComposerContextMessage>) {
  expect(message).not.toHaveProperty("context");
  expect(message.text).not.toContain("t3-context://");
  expect(message.text).toContain("@terminal-1:3-4");
  expect(message.text).toContain("3 | boom\n  4 | again");
  expect(message.text).toContain(element.htmlPreview);
  expect(message.text).toContain("src/Checkout.tsx:42:7");
  expect(message.text).toContain("Make the button clearer");
  expect(message.text).toContain("Why this branch?");
  expect(message.text).toContain("```ts\nconst stable = `ok`;\n```");
  const recovered = upgradeLegacyContextMessage(message.text).records;
  expect(recovered).toHaveLength(4);
  expect(recovered.find((record) => record.kind === "terminal")).toMatchObject({
    terminalLabel: "Terminal 1",
    lineStart: 3,
    lineEnd: 4,
    text: "boom\nagain",
  });
  const legacyElement = {
    ...element,
    pageTitle: null,
    tagName: "submitbutton",
    source: { ...element.source, functionName: null },
  };
  expect(recovered.find((record) => record.kind === "element")).toMatchObject(legacyElement);
  expect(recovered.find((record) => record.kind === "preview-annotation")).toMatchObject({
    annotationId: "annotation-send",
    comment: "Make the button clearer",
    elements: [legacyElement],
  });
  expect(recovered.find((record) => record.kind === "review-comment")).toMatchObject({
    filePath: "a/b.ts",
    rangeLabel: "L4",
    text: "Why this branch?",
    diff: "const stable = `ok`;",
  });
}

describe("composer submission capability boundary", () => {
  it("preserves the exact structured records and authored text for an explicit true capability", () => {
    using scope = setup();
    scope.capability(environmentId, true);
    const message = prepareComposerContextMessage({ environmentId, text, context });
    expect(message.text).toBe(text);
    expect(message.context).toBe(context);
    expect(message.context?.records).toBe(context.records);
  });

  it("serializes all four context kinds for a server without the capability", () => {
    using scope = setup();
    scope.capability(environmentId, undefined);
    const before = JSON.stringify(context);
    expectLegacy(prepareComposerContextMessage({ environmentId, text, context }));
    expect(JSON.stringify(context)).toBe(before);
  });

  it("does not borrow a different environment's modern capability", () => {
    using scope = setup();
    scope.capability(otherEnvironment, true);
    expectLegacy(prepareComposerContextMessage({ environmentId, text, context }));
    scope.capability(environmentId, true);
    scope.capability(otherEnvironment, false);
    expect(prepareComposerContextMessage({ environmentId, text, context }).context).toBe(context);
  });

  it("leaves a context-free message untouched", () => {
    using scope = setup();
    scope.capability(environmentId, true);
    expect(
      prepareComposerContextMessage({ environmentId, text: "plain prose  ", context: undefined }),
    ).toEqual({ text: "plain prose  " });
  });

  it("rereads capability on each fan-out callback invocation", () => {
    using scope = setup();
    const start = () => prepareComposerContextMessage({ environmentId, text, context });
    scope.capability(environmentId, false);
    expectLegacy(start());
    scope.capability(environmentId, true);
    expect(start().context).toBe(context);
    scope.capability(environmentId, undefined);
    expectLegacy(start());
  });
});
