import { MATH_COMMANDS } from "./catalog";

export interface MathBinding {
  readonly keys: string;
  readonly command: string;
}
const aliases: readonly [string, string][] = [
  ["u", "math.symbol.sum"],
  ["i", "math.symbol.int"],
  ["y", "math.symbol.oint"],
  ["p", "math.symbol.partial"],
  ["8", "math.symbol.infty"],
  ["+", "math.symbol.pm"],
  ["=", "math.symbol.neq"],
  ["m", "math.inline"],
  ["d", "math.display"],
  ["c i", "math.matrix.addColumn"],
  ["c d", "math.matrix.deleteColumn"],
  ["c c", "math.matrix.copyColumn"],
  ["c s", "math.matrix.swapColumn"],
  ["w i", "math.matrix.addRow"],
  ["w d", "math.matrix.deleteRow"],
  ["w c", "math.matrix.copyRow"],
  ["w s", "math.matrix.swapRow"],
];

export function defaultMathBindings(mac: boolean): readonly MathBinding[] {
  const prefix = mac ? "ctrl+m" : "alt+m";
  return [
    { keys: "mod+m", command: "math.inline" },
    { keys: "mod+shift+m", command: "math.display" },
    { keys: "ctrl+space", command: "math.palette" },
    ...MATH_COMMANDS.flatMap((command) =>
      (command.lyx ?? []).map((sequence) => ({
        keys: `${prefix} ${sequence}`,
        command: command.id,
      })),
    ),
    ...aliases.map(([sequence, command]) => ({ keys: `${prefix} ${sequence}`, command })),
    // The portable prefix is also available on macOS, where Cmd+M may be reserved by the host.
    ...(mac
      ? [
          ...MATH_COMMANDS.flatMap((command) =>
            (command.lyx ?? []).map((sequence) => ({
              keys: `alt+m ${sequence}`,
              command: command.id,
            })),
          ),
          ...aliases.map(([sequence, command]) => ({ keys: `alt+m ${sequence}`, command })),
        ]
      : []),
  ];
}
