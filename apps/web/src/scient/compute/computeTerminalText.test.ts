import { describe, expect, it } from "vite-plus/test";

import { renderTerminalText } from "./computeTerminalText";

describe("renderTerminalText", () => {
  it("collapses carriage-return progress into its final state", () => {
    // Chunks as ipykernel delivers a tqdm-style bar on stderr.
    const chunks = [0, 50, 100].map(
      (percent) =>
        `\r${String(percent).padStart(3)}%|${"█".repeat(percent / 10).padEnd(10)}| ${percent}/100`,
    );
    expect(renderTerminalText([...chunks, "\n"].join("")).text).toBe("100%|██████████| 100/100");
  });

  it("styles SGR colours and removes every escape sequence from the text", () => {
    const rendered = renderTerminalText(
      "\u001b[1;32mINFO\u001b[0m ok \u001b[38;5;208mo\u001b[0m \u001b[38;2;10;120;200mt\u001b[0m\u001b]8;;https://x\u0007link\u001b]8;;\u0007\n",
    );
    expect(rendered.text).toBe("INFO ok o tlink");
    expect(rendered.runs.map((run) => [run.text, run.style])).toEqual([
      ["INFO", { bold: true, fg: 2 }],
      [" ok ", null],
      ["o", { fg: "rgb(255, 135, 0)" }],
      [" ", null],
      ["t", { fg: "rgb(10, 120, 200)" }],
      ["link", null],
    ]);
  });

  it("applies backspace, erase-in-line and cursor-up overwrites", () => {
    expect(renderTerminalText("abc\b\bX").text).toBe("aXc");
    expect(renderTerminalText("abcdef\r\u001b[Kz").text).toBe("z");
    expect(renderTerminalText("bar 1\nbar 2\u001b[A\rBAR 1").text).toBe("BAR 1\nbar 2");
  });
});
