import { MATH_COMMANDS } from "./catalog";

export interface MathBinding {
  readonly keys: string;
  readonly command: string;
}
const aliases: readonly [string, string][] = [
  ["o s", "math.symbol.sin"],
  ["o c", "math.symbol.cos"],
  ["o t", "math.symbol.tan"],
  ["o l", "math.symbol.log"],
  ["o n", "math.symbol.ln"],
  ["o e", "math.symbol.exp"],
  ["o d", "math.symbol.det"],
  ["o m", "math.symbol.min"],
  ["o x", "math.symbol.max"],
  ["o k", "math.symbol.ker"],
  ["q l", "math.symbol.leq"],
  ["q g", "math.symbol.geq"],
  ["q n", "math.symbol.neq"],
  ["q a", "math.symbol.approx"],
  ["q e", "math.symbol.equiv"],
  ["q i", "math.symbol.in"],
  ["q s", "math.symbol.subseteq"],
  ["q p", "math.symbol.supseteq"],
  ["q f", "math.symbol.forall"],
  ["q x", "math.symbol.exists"],
  ["a r", "math.symbol.rightarrow"],
  ["a l", "math.symbol.leftarrow"],
  ["a b", "math.symbol.leftrightarrow"],
  ["a shift+r", "math.symbol.Rightarrow"],
  ["a shift+l", "math.symbol.Leftarrow"],
  ["a shift+b", "math.symbol.Leftrightarrow"],
  ["a m", "math.symbol.mapsto"],
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
    { keys: "alt+=", command: "math.inline" },
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
