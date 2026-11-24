import { expect, it } from "vite-plus/test";

import { ompToolImages } from "./OmpComputerPresentation.ts";
import { OmpToolRows } from "./OmpToolRows.ts";

it("reads the bash card and its displayed image from 19.1 RPC result frames", () => {
  const rows = new OmpToolRows((text) => text);
  const input = { command: "preview_screenshot" };
  const screenshot = { type: "image", mimeType: "image/png", data: "AAAA" };
  const result = {
    content: [{ type: "text", text: "Screenshot" }, screenshot],
    details: {
      toolCommands: [
        {
          tool: "preview_screenshot",
          mode: "execute",
          args: {},
          exitCode: 0,
          inner: { content: [screenshot] },
        },
      ],
    },
  };
  rows.row("call", "bash", { input, data: undefined, status: "running", output: undefined });
  expect(
    rows.row("call", "bash", {
      input: undefined,
      data: result,
      output: "Screenshot",
      status: "completed",
    }),
  ).toEqual({ type: "command_execution", input: input.command, output: "Screenshot", exitCode: 0 });
  expect(ompToolImages(result)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
});
