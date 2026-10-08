import { convertLatexToMarkup } from "mathlive/ssr";
import { mathLiveFontDeclarations } from "./mathLiveFontDeclarations";
import { mathTextFormattingInput } from "./mathTextFormatting";
import { latexColorCss } from "./latexColorBoxes";
import type { MathPreviewContext, MathPreviewRequest } from "./mathReadingPreviewProtocol";

const contexts = new Map<number, MathPreviewContext>();

self.addEventListener("message", (event: MessageEvent<MathPreviewRequest>) => {
  const { id, source, display, contextId, context } = event.data;
  if (event.data.resetContexts) contexts.clear();
  if (context) contexts.set(contextId, context);
  const current = contexts.get(contextId);
  if (!current) {
    send({ id, markup: null });
    return;
  }
  const { macros, documentMacros, colors } = current;
  try {
    let markup = convertLatexToMarkup(
      mathTextFormattingInput(mathLiveFontDeclarations(source), documentMacros),
      { defaultMode: display ? "math" : "inline-math", macros },
    );
    // The static converter does not consult the interactive color hooks.
    if (colors)
      markup = markup.replace(
        /((?:background-)?color\s*:\s*)([^;"<>]+)/gu,
        (token, property: string, name: string) => {
          const expression = latexColorCss(name.trim(), { ...colors });
          return expression
            ? property +
                expression.replace(
                  /var\(--scient-color-([A-Za-z0-9-]+)\)/gu,
                  (_variable, color: string) => colors[color]!,
                )
            : token;
        },
      );
    // Avoid transferring a runaway expansion into the renderer's DOM.
    send({ id, markup: markup.length <= 2_000_000 ? markup : null });
  } catch {
    send({ id, markup: null });
  }
});
function send(message: unknown) {
  (
    self as unknown as { postMessage: (value: unknown, transfer: Transferable[]) => void }
  ).postMessage(message, []);
}
send({ ready: true });
