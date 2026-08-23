import { useEffect, useRef, useState } from "react";

import { ScientMarkdownSourceView } from "./ScientMarkdownSourceView";

export interface ScientMarkdownSourceDocumentProps {
  readonly source: string;
  readonly editable: boolean;
  readonly ariaLabel: string;
  readonly onUserSourceChange: (source: string) => void;
  readonly onSelectionOffsetChange?: (sourceOffset: number) => void;
  readonly revealLine?: number | null;
  readonly revealRequestId?: number;
  readonly revealOffset?: number | null;
  readonly revealOffsetRequestId?: number;
}

export function ScientMarkdownSourceDocument(props: ScientMarkdownSourceDocumentProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onUserSourceChangeRef = useRef(props.onUserSourceChange);
  const onSelectionOffsetChangeRef = useRef(props.onSelectionOffsetChange);
  onUserSourceChangeRef.current = props.onUserSourceChange;
  onSelectionOffsetChangeRef.current = props.onSelectionOffsetChange;
  const [controller] = useState(
    () =>
      new ScientMarkdownSourceView({
        source: props.source,
        editable: props.editable,
        ariaLabel: props.ariaLabel,
        onUserSourceChange: (source) => onUserSourceChangeRef.current(source),
        onSelectionOffsetChange: (sourceOffset) =>
          onSelectionOffsetChangeRef.current?.(sourceOffset),
      }),
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    controller.mount(host);
    return () => controller.destroy();
  }, [controller]);

  useEffect(() => controller.setEditable(props.editable), [controller, props.editable]);
  useEffect(() => controller.replaceExternalSource(props.source), [controller, props.source]);
  useEffect(() => {
    if (props.revealLine !== null && props.revealLine !== undefined) {
      controller.revealLine(props.revealLine);
    }
  }, [controller, props.revealLine, props.revealRequestId]);
  useEffect(() => {
    if (props.revealOffset !== null && props.revealOffset !== undefined) {
      controller.revealOffset(props.revealOffset);
    }
  }, [controller, props.revealOffset, props.revealOffsetRequestId]);

  return <div ref={hostRef} className="scient-markdown-source-document" />;
}
