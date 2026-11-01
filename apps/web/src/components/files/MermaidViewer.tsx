import { useTheme } from "~/hooks/useTheme";
import { MermaidDiagramCard } from "~/scient/diagrams/MermaidDiagramCard";

export default function MermaidViewer(props: { readonly text: string }) {
  const { resolvedTheme } = useTheme();
  return (
    <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto p-6">
      {/* SCIENT-FORK:START — standalone diagrams share chat's policy, recovery and exports. */}
      <MermaidDiagramCard
        source={props.text}
        language="mermaid"
        title={null}
        theme={resolvedTheme}
      />
      {/* SCIENT-FORK:END */}
    </div>
  );
}
