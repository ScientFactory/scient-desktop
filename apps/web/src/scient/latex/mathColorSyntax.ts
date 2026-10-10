import { latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";
import { latexPackageInventory } from "./latexPackages";

function hexColor(value: string): string | null {
  const hex = /^#([a-fA-F0-9]{3}|[a-fA-F0-9]{6})$/u.exec(value.trim())?.[1];
  if (!hex) return null;
  return (hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex).toUpperCase();
}

/** MathLive uses CSS color arguments; xcolor uses optional models and literals. */
function convertMathColors(
  source: string,
  direction: "source" | "input",
  customCommands?: Readonly<Record<string, unknown>>,
  preferRgb = false,
): string {
  for (const command of latexSourceCommands(source).toReversed()) {
    if (
      !["color", "textcolor", "colorbox", "fcolorbox"].includes(command.name) ||
      customCommands?.[command.name]
    )
      continue;
    const firstModel = latexSourceArgument(source, command.to, "[", "]");
    const first = latexSourceArgument(source, firstModel?.end ?? command.to);
    if (!first) continue;
    const secondModel =
      command.name === "fcolorbox" ? latexSourceArgument(source, first.end, "[", "]") : null;
    const second =
      command.name === "fcolorbox"
        ? latexSourceArgument(source, secondModel?.end ?? first.end)
        : null;
    if (command.name === "fcolorbox" && !second) continue;
    const colors = [
      { model: firstModel?.value.trim() ?? "", value: first.value },
      ...(second
        ? [{ model: (secondModel ?? firstModel)?.value.trim() ?? "", value: second.value }]
        : []),
    ];
    let changed = false;
    const converted = colors.map(({ model, value }) => {
      if (direction === "source") {
        const hex = (!model || model === "named" || model === "HTML") && hexColor(value);
        if (hex) {
          changed = true;
          if (preferRgb && !second)
            return `[rgb]{${[0, 2, 4]
              .map((from) => Number((parseInt(hex.slice(from, from + 2), 16) / 255).toFixed(8)))
              .join(",")}}`;
          return `[HTML]{${hex}}`;
        }
        return `${model ? `[${model}]` : second ? "[named]" : ""}{${value}}`;
      }
      if (model === "HTML" && /^[a-fA-F0-9]{6}$/u.test(value.trim())) {
        changed = true;
        return `{#${value.trim()}}`;
      }
      if (model === "rgb" || model === "RGB" || model === "gray") {
        const parts = value.split(",").map((part) => part.trim());
        const maximum = model === "RGB" ? 255 : 1;
        if (
          parts.length === (model === "gray" ? 1 : 3) &&
          parts.every(
            (part) =>
              /^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(part) &&
              Number(part) >= 0 &&
              Number(part) <= maximum,
          )
        ) {
          changed = true;
          const rgb = model === "gray" ? [parts[0]!, parts[0]!, parts[0]!] : parts;
          return `{#${rgb
            .map((part) =>
              Math.round((Number(part) / maximum) * 255)
                .toString(16)
                .padStart(2, "0"),
            )
            .join("")}}`;
        }
      }
      if (model === "named") {
        changed = true;
        return `{${value}}`;
      }
      return model ? null : `{${value}}`;
    });
    // Leave unsupported model expressions intact rather than guessing their color.
    if (!changed || converted.includes(null)) continue;
    const from = firstModel?.open ?? first.open;
    const to = second?.end ?? first.end;
    source = source.slice(0, from) + converted.join("") + source.slice(to);
  }
  return source;
}

export function mathColorSource(
  source: string,
  customCommands?: Readonly<Record<string, unknown>>,
  documentSource?: string,
): string {
  const loaded = documentSource && latexPackageInventory(documentSource).loaded;
  return convertMathColors(
    source,
    "source",
    customCommands,
    Boolean(loaded && loaded.has("color") && !loaded.has("xcolor")),
  );
}

export function mathColorInput(
  source: string,
  customCommands?: Readonly<Record<string, unknown>>,
): string {
  return convertMathColors(source, "input", customCommands);
}
