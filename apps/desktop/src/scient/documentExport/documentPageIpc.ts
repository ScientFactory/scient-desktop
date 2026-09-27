import {
  DesktopDocumentPageRenderInput,
  DesktopDocumentPageRenderOutcome,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { getDesktopScheme } from "../../electron/ElectronProtocol.ts";
import {
  createDocumentPagePdfRenderer,
  type DocumentPageSource,
} from "./DocumentPagePdfRenderer.ts";

let renderer: ReturnType<typeof createDocumentPagePdfRenderer> | undefined;

/** The page is served the same way as the app window: the built client, or Vite in development. */
function documentPageSourceFor(
  environment: Pick<
    DesktopEnvironment.DesktopEnvironment["Service"],
    "isDevelopment" | "devServerUrl" | "clientAssetsDir"
  >,
): DocumentPageSource {
  const scheme = getDesktopScheme(environment.isDevelopment);
  return environment.isDevelopment && Option.isSome(environment.devServerUrl)
    ? { scheme, files: { _tag: "development", targetOrigin: environment.devServerUrl.value } }
    : { scheme, files: { _tag: "packaged", assetDirectory: environment.clientAssetsDir } };
}

export const renderDocumentPagePdf = Effect.fn("desktop.scient.renderDocumentPagePdf")(function* (
  input: DesktopDocumentPageRenderInput,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  renderer ??= createDocumentPagePdfRenderer({ page: documentPageSourceFor(environment) });
  return yield* renderer(input);
});

export const renderDocumentPagePdfSchemas = {
  payload: DesktopDocumentPageRenderInput,
  result: DesktopDocumentPageRenderOutcome,
} as const;
