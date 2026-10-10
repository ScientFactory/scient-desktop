import { useAtomMount, useAtomSet } from "@effect/atom-react";
import {
  type ControlledHtmlPdfRenderResult,
  type EnvironmentId,
  type ScientDocumentHostOperation,
  type ScientDocumentHostRequest,
} from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { previewBridge } from "~/components/preview/previewBridge";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironments, useEnvironmentHttpBaseUrl } from "~/state/environments";
import { scientDocumentPdfEnvironment } from "~/state/scientDocumentPdf";
import { useAtomCommand } from "~/state/use-atom-command";
import { scientGeneratedPdfSurface } from "../rightPanel/surfaces";
import { renderDocumentPagePdfForHost } from "./documentPagePdf";
import {
  createScientDocumentHostRequestConsumerAtom,
  ScientDocumentHostExecutionError,
  type ScientDocumentRequestHandler,
} from "./documentHostRequestConsumer";

/** Four controlled document operations; none needs or creates an interactive browser tab. */
export async function executeScientDocumentHostRequest(
  environmentId: EnvironmentId,
  httpBaseUrl: string | null,
  request: ScientDocumentHostRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const threadRef = { environmentId, threadId: request.threadId };
  switch (request.operation) {
    case "documentPdfRender": {
      const bridge = previewBridge;
      if (!bridge || httpBaseUrl === null)
        throw new ScientDocumentHostExecutionError("The desktop document renderer is unavailable.");
      const sourceUrl = resolveAssetUrl(httpBaseUrl, request.input.assetRelativeUrl);
      if (sourceUrl === null)
        throw new ScientDocumentHostExecutionError("The signed HTML source URL is invalid.");
      const artifact = await bridge.renderHtmlPdf(sourceUrl);
      signal?.throwIfAborted();
      return {
        title: artifact.title,
        sourceUrl: artifact.sourceUrl,
        profile: artifact.profile,
        media: artifact.media,
        warnings: artifact.warnings,
        sourceSignals: artifact.sourceSignals,
        blockedRequestCount: artifact.blockedRequestCount,
        bytesBase64: Base64Url.encode(artifact.data),
      } satisfies ControlledHtmlPdfRenderResult;
    }
    case "documentPagePdfRender": {
      if (httpBaseUrl === null)
        throw new ScientDocumentHostExecutionError("The environment connection is unavailable.");
      const rendered = await renderDocumentPagePdfForHost(httpBaseUrl, request.input);
      signal?.throwIfAborted();
      return rendered;
    }
    case "documentPdfPresent":
      if (request.input.source._tag !== "generated-pdf")
        throw new ScientDocumentHostExecutionError(
          "The document build returned an unsupported PDF source.",
        );
      useRightPanelStore
        .getState()
        .openScient(threadRef, scientGeneratedPdfSurface(request.input.source));
      return {};
    case "documentLatexPresent":
      useRightPanelStore.getState().openFile(threadRef, request.input.sourcePath, undefined, {
        latexPreviewMode: "split",
        latexRootRelativePath: request.input.rootSourcePath,
      });
      return {};
  }
}

function ScientDocumentEnvironmentHost(props: {
  readonly environmentId: EnvironmentId;
  readonly supportedOperations: ReadonlyArray<ScientDocumentHostOperation>;
}) {
  const { environmentId } = props;
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const [clientId] = useState(() => `scient-documents-${randomUUID()}`);
  const requestsAtom = scientDocumentPdfEnvironment.hostRequests({
    environmentId,
    input: { clientId, environmentId, supportedOperations: [...props.supportedOperations] },
  });
  const respond = useAtomCommand(scientDocumentPdfEnvironment.respondToHost, {
    reportFailure: false,
  });
  const handle = useCallback(
    (request: ScientDocumentHostRequest, signal: AbortSignal) =>
      executeScientDocumentHostRequest(environmentId, httpBaseUrl, request, signal),
    [environmentId, httpBaseUrl],
  );
  const [requestHandlerAtom] = useState(() => Atom.make<ScientDocumentRequestHandler>({ handle }));
  const setRequestHandler = useAtomSet(requestHandlerAtom);
  useEffect(() => {
    setRequestHandler({ handle });
  }, [handle, setRequestHandler]);
  const consumerAtom = useMemo(
    () =>
      createScientDocumentHostRequestConsumerAtom({
        requestsAtom,
        clientId,
        environmentId,
        requestHandlerAtom,
        respond: (response) => respond({ environmentId, input: response }),
      }),
    [clientId, environmentId, requestHandlerAtom, requestsAtom, respond],
  );
  useAtomMount(consumerAtom);
  return null;
}

/** Host lifetime follows desktop environment connections, including background document builds. */
export function ScientDocumentHosts() {
  const { environments } = useEnvironments();
  if (typeof window === "undefined" || !window.desktopBridge) return null;
  const supportedOperations: ScientDocumentHostOperation[] = [
    "documentPdfPresent",
    "documentLatexPresent",
  ];
  if (previewBridge?.renderHtmlPdf) supportedOperations.push("documentPdfRender");
  if (window.desktopBridge.renderDocumentPagePdf) supportedOperations.push("documentPagePdfRender");
  return (
    <>
      {environments.map((environment) => (
        <ScientDocumentEnvironmentHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
          supportedOperations={supportedOperations}
        />
      ))}
    </>
  );
}
