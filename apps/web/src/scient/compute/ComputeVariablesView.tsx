import type { ComputeVariableSnapshot } from "@t3tools/contracts";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";

function Centered(props: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-40 items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
      {props.children}
    </div>
  );
}

export function ComputeVariablesView(props: {
  readonly snapshot: ComputeVariableSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly available: boolean;
  readonly hasLiveSession: boolean;
  readonly busy: boolean;
  readonly selectedIsLive: boolean;
  readonly onShowLive: () => void;
  readonly onRefresh: () => void;
}) {
  if (!props.hasLiveSession) return <Centered>No running session</Centered>;
  if (!props.selectedIsLive) {
    return (
      <Centered>
        <Button size="xs" variant="outline" onClick={props.onShowLive}>
          Show running session
        </Button>
      </Centered>
    );
  }
  if (!props.available) return <Centered>Not available for this language</Centered>;
  if (props.busy) {
    return (
      <Centered>
        <LoaderCircle className="size-3 animate-spin" /> Running…
      </Centered>
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-3">
        <div className="mb-2 flex items-center justify-end">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh variables"
            disabled={props.loading}
            onClick={props.onRefresh}
          >
            {props.loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
        {props.error !== null ? (
          <div className="rounded-[6px] border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
            {props.error}
          </div>
        ) : props.snapshot === null && props.loading ? (
          <p className="flex min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
          </p>
        ) : props.snapshot === null || props.snapshot.variables.length === 0 ? (
          <p className="flex min-h-32 items-center justify-center text-xs text-muted-foreground">
            No variables yet
          </p>
        ) : (
          <div className="min-w-0 overflow-hidden rounded-[6px] border border-border/70">
            <ScrollArea className="h-auto" aria-label="Current variables">
              <table className="w-full min-w-[32rem] table-fixed text-left text-xs">
                <thead className="border-b border-border/60 bg-muted/30 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="w-1/4 px-2 py-1.5 font-medium">
                      Name
                    </th>
                    <th scope="col" className="w-1/5 px-2 py-1.5 font-medium">
                      Type
                    </th>
                    <th scope="col" className="w-1/5 px-2 py-1.5 font-medium">
                      Shape / size
                    </th>
                    <th scope="col" className="px-2 py-1.5 font-medium">
                      Preview
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {props.snapshot.variables.map((variable) => (
                    <tr
                      key={variable.name}
                      className="border-b border-border/50 align-top last:border-b-0"
                    >
                      <th
                        scope="row"
                        className="break-words px-2 py-1.5 font-mono font-medium text-foreground"
                      >
                        {variable.name}
                      </th>
                      <td className="break-words px-2 py-1.5 text-muted-foreground">
                        {variable.typeName}
                      </td>
                      <td className="break-words px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {variable.shape ?? (variable.size === null ? "" : String(variable.size))}
                      </td>
                      <td className="break-words px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {variable.preview ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
            {props.snapshot.truncated ? (
              <p className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
                First 200 variables
              </p>
            ) : null}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
