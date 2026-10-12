import { describe, expect, it } from "vite-plus/test";
import { MATH_COMMANDS } from "../math/input/catalog";
import { labelKeys } from "../keyboard/keys";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  effectiveSurfaceBindings,
  type SurfaceBinding,
} from "../keyboard/preferences";
import { MATH_SYMBOLS } from "./mathSymbols";
import { mathSymbolShortcuts } from "./mathSymbolShortcuts";

describe("indexed symbol shortcut hints", () => {
  it("preserves the existing completion hints across the whole symbol catalog", () => {
    const aliases: Record<string, string> = {
      "\\to": "\\rightarrow",
      "\\le": "\\leq",
      "\\ge": "\\geq",
      "\\ne": "\\neq",
    };
    const canonical = (text: string) => {
      const command = /^\\[A-Za-z]+/u.exec(text)?.[0] ?? text;
      return aliases[command] ?? command;
    };
    for (const mac of [false, true]) {
      const bindings = effectiveSurfaceBindings(DEFAULT_KEYBOARD_PREFERENCES, mac);
      // Differential qualification against the previous catalog scan. Structural
      // actions use a separate label-to-command mapping, checked below.
      for (const symbol of MATH_SYMBOLS.filter((entry) => entry.category !== "structures")) {
        const ids = MATH_COMMANDS.filter(
          (entry) =>
            entry.completion && canonical(`\\${entry.completion}`) === canonical(symbol.command),
        ).map((entry) => entry.id);
        const expected = [
          ...new Set(
            bindings
              .filter((binding) => ids.includes(binding.command))
              .map((binding) => labelKeys(binding.keys)),
          ),
        ];
        expect(mathSymbolShortcuts(symbol, bindings), symbol.id).toEqual(expected);
      }
    }
  });

  it("keeps alias binding order and removes duplicate labels", () => {
    const arrow = MATH_SYMBOLS.find((symbol) => symbol.command === "\\rightarrow")!;
    const bindings: readonly SurfaceBinding[] = [
      { command: "math.symbol.rightarrow", keys: "alt+r", scope: "math" },
      { command: "math.symbol.to", keys: "alt+t", scope: "math" },
      { command: "math.symbol.rightarrow", keys: "alt+r", scope: "math" },
    ];
    expect(mathSymbolShortcuts(arrow, bindings)).toEqual([labelKeys("alt+r"), labelKeys("alt+t")]);
    expect(mathSymbolShortcuts(arrow, [])).toEqual([]);
    const replacement = [{ ...bindings[0]!, keys: "alt+x" }];
    expect(mathSymbolShortcuts(arrow, replacement)).toEqual([labelKeys("alt+x")]);
    expect(mathSymbolShortcuts(arrow, bindings)).toEqual([labelKeys("alt+r"), labelKeys("alt+t")]);
  });

  it("retains structural overrides and disabled bindings", () => {
    const symbol = MATH_SYMBOLS.find((entry) => entry.label === "Text in math")!;
    const custom = effectiveSurfaceBindings(
      { ...DEFAULT_KEYBOARD_PREFERENCES, overrides: { "math.text": ["alt+x"] } },
      false,
    );
    expect(mathSymbolShortcuts(symbol, custom)).toEqual([labelKeys("alt+x")]);
    const disabled = effectiveSurfaceBindings(
      { ...DEFAULT_KEYBOARD_PREFERENCES, overrides: { "math.text": [] } },
      false,
    );
    expect(mathSymbolShortcuts(symbol, disabled)).toEqual([]);
  });
});
