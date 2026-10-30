import type {
  ComputeSessionGeneration,
  ComputeSessionId,
  ComputeVariableSnapshot,
  DataTableQuery,
  EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { DataGrid } from "./DataGrid";
import { computeTablePage } from "./dataTableState";

type ComputeVariable = ComputeVariableSnapshot["variables"][number];

/** Data frames, series and one- or two-dimensional arrays open as a table. */
export function isTableVariable(variable: ComputeVariable): boolean {
  if (variable.typeName === "DataFrame" || variable.typeName === "Series") return true;
  if (variable.typeName !== "ndarray" || variable.shape === null) return false;
  const dimensions = variable.shape.replace(/[(),\s]+$/, "").split(",").length;
  return dimensions === 1 || dimensions === 2;
}

/** A live variable as a table, paged from the kernel without entering its history. */
export function ComputeVariableTableDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sessionId: ComputeSessionId;
  readonly generation: ComputeSessionGeneration;
  readonly name: string | null;
  readonly onClose: () => void;
}) {
  const readPage = useAtomCommand(computeTablePage, { reportFailure: false });
  const name = props.name;
  const loadPage = async (query: DataTableQuery) => {
    const result = await readPage({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: props.sessionId,
        expectedGeneration: props.generation,
        name: name ?? "",
        query,
      },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  };
  return (
    <Dialog open={name !== null} onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup bottomStickOnMobile={false} layout="visual" padding="none" gap="none">
        <DialogHeader layout="visual">
          <DialogTitle size="compact" className="min-w-0">
            <span className="block truncate font-mono">{name}</span>
          </DialogTitle>
        </DialogHeader>
        {name === null ? null : (
          <DataGrid
            label={name}
            revision={`${props.sessionId}:${props.generation}:${name}`}
            loadPage={loadPage}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
