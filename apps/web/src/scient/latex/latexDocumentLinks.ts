import { latexColorCss, latexDocumentColors } from "./latexColorBoxes";
import {
  latexPreambleEnd,
  latexSourceArgument,
  latexSourceCommands,
  latexWithoutComments,
} from "./latexSourceSyntax";

/** Read literal hyperref ink settings without executing preamble commands. */
export function latexDocumentLinkColors(source: string) {
  const preamble = latexWithoutComments(source.slice(0, latexPreambleEnd(source)));
  const settings = { colorlinks: false, linkcolor: "red", citecolor: "green", urlcolor: "magenta" };
  const apply = (options: string) => {
    for (const token of options.split(",")) {
      const [name, ...rest] = token.trim().split("=");
      const value = rest
        .join("=")
        .trim()
        .replace(/^\{(.*)\}$/u, "$1");
      if (name === "hidelinks" && (!value || value === "true")) settings.colorlinks = false;
      else if (name === "colorlinks" && (!value || value === "true" || value === "false"))
        settings.colorlinks = value !== "false";
      else if (name === "linkcolor" || name === "citecolor" || name === "urlcolor")
        settings[name] = value;
    }
  };
  for (const command of latexSourceCommands(preamble)) {
    if (command.depth !== 0) continue;
    if (command.name === "usepackage" || command.name === "RequirePackage") {
      const options = latexSourceArgument(preamble, command.to, "[", "]");
      const names = latexSourceArgument(preamble, options?.end ?? command.to);
      if (names?.value.split(",").some((name) => name.trim() === "hyperref"))
        apply(options?.value ?? "");
    } else if (command.name === "hypersetup") {
      const options = latexSourceArgument(preamble, command.to);
      if (options) apply(options.value);
    }
  }
  const colors = latexDocumentColors(source);
  const ink = (name: "linkcolor" | "citecolor" | "urlcolor") =>
    settings.colorlinks ? (latexColorCss(settings[name], colors) ?? undefined) : undefined;
  return { link: ink("linkcolor"), citation: ink("citecolor"), url: ink("urlcolor") };
}
