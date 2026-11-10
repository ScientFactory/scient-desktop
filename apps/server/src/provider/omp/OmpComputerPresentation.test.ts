import { assert, it } from "@effect/vitest";

import {
  ompComputerPermissionsNeeded,
  ompComputerStatusErrors,
  ompComputerPresentation,
  ompToolImages,
  retainedComputerPresentation,
} from "./OmpComputerPresentation.ts";

it("reads an Eval call that uses the desktop as computer use named after its app", () => {
  const presentation = ompComputerPresentation("eval", {
    language: "js",
    title: "Type into TextEdit",
    code: 'const win = await computer.window({ app: "TextEdit" });\nawait win.screenshot();',
  });
  assert.deepEqual(presentation, {
    title: "Type into TextEdit",
    toolSurface: "computer",
    toolIcon: { _tag: "native-app", app: { _tag: "display-name", displayName: "TextEdit" } },
    toolSource: {
      key: "native-app-name:textedit",
      name: "TextEdit",
      kind: "computer",
      icon: { _tag: "native-app", app: { _tag: "display-name", displayName: "TextEdit" } },
    },
  });
});

it("reads Python keyword arguments and falls back to a generic title", () => {
  const presentation = ompComputerPresentation("eval", {
    language: "py",
    code: 'win = await computer.window(app="Google Chrome")\nawait win.screenshot()',
  });
  assert.strictEqual(presentation?.title, "Use Google Chrome");
  assert.strictEqual(presentation?.toolSource.name, "Google Chrome");
});

it("names the app an item opens in, never the item itself", () => {
  assert.strictEqual(
    ompComputerPresentation("eval", { code: 'await computer.apps.open("Notes")' })?.toolSource.name,
    "Notes",
  );
  const file = ompComputerPresentation("eval", {
    code: 'await computer.apps.open("~/notes.txt")',
  });
  assert.strictEqual(file?.title, "Computer use");
  assert.strictEqual(file?.toolSource.key, "computer-use");
  assert.isUndefined(file?.toolIcon);
});

it("leaves other Eval calls and other tools alone", () => {
  assert.isUndefined(ompComputerPresentation("eval", { code: "print(1 + 1)" }));
  assert.isUndefined(ompComputerPresentation("eval", { code: "mycomputer.window()" }));
  assert.isUndefined(ompComputerPresentation("bash", { code: "computer.window()" }));
  assert.isUndefined(ompComputerPresentation("eval", "computer.window()"));
});

it("keeps a call's presentation for frames without arguments", () => {
  const presentation = ompComputerPresentation("eval", { code: "await computer.screenshot()" });
  assert.deepEqual(retainedComputerPresentation(presentation), presentation);
  assert.isUndefined(retainedComputerPresentation({ title: "eval" }));
  assert.isUndefined(retainedComputerPresentation(undefined));
});

it("keeps raster screenshots from a tool result, in order", () => {
  const images = ompToolImages({
    content: [
      { type: "text", text: "Saved screenshot" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
      { type: "image", mimeType: "image/jpeg", data: "BBBB", detail: "original" },
    ],
  });
  assert.deepEqual(images, [
    { mimeType: "image/png", data: "AAAA" },
    { mimeType: "image/jpeg", data: "BBBB" },
  ]);
  assert.deepEqual(ompToolImages("text"), []);
  assert.deepEqual(ompToolImages({ content: "text" }), []);
});

it("reads the macOS panes the agent says were refused", () => {
  assert.deepEqual(
    ompComputerPermissionsNeeded(
      "DesktopError: macOS Screen & System Audio Recording permission is not granted to Scient, which macOS holds responsible for omp; enable Scient in System Settings > Privacy & Security > Screen & System Audio Recording\n" +
        "macOS Accessibility permission is not granted to Scient, which macOS holds responsible for omp",
    ),
    ["screen-recording", "accessibility"],
  );
  assert.deepEqual(
    ompComputerPermissionsNeeded("macOS Screen Recording permission is not granted to the app"),
    ["screen-recording"],
  );
  assert.deepEqual(ompComputerPermissionsNeeded("Window not found"), []);
  assert.deepEqual(ompComputerPermissionsNeeded(undefined), []);
});

it("recognizes a call through a handle from an earlier cell by the prelude's status", () => {
  const result = {
    content: [{ type: "text", text: "ToolError: PermissionDenied: …" }],
    details: {
      statusEvents: [
        { op: "computer", detail: 'desktop.window({"app":"TextEdit"})' },
        {
          op: "computer",
          error:
            "PermissionDenied: macOS Accessibility permission is not granted to Scient, which macOS holds responsible for omp",
        },
        { op: "read", detail: "notes.md" },
      ],
    },
  };
  const presentation = ompComputerPresentation(
    "eval",
    { title: "Inspecting the window", code: "console.log(await win.ax());" },
    result,
  );
  assert.strictEqual(presentation?.title, "Inspecting the window");
  assert.strictEqual(presentation?.toolSource.name, "TextEdit");
  assert.deepEqual(ompComputerPermissionsNeeded(ompComputerStatusErrors(result).join("\n")), [
    "accessibility",
  ]);
  assert.isUndefined(
    ompComputerPresentation("eval", { code: "print(1)" }, { details: { statusEvents: [] } }),
  );
});
