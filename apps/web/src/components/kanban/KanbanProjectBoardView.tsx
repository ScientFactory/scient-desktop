// FILE: KanbanProjectBoardView.tsx
// Purpose: Full 3-column board for one project — drag a Draft card onto In Progress to
//          dispatch its prompt, or reorder drafts; other moves are derived-only.
// Layer: UI component (owns the board DndContext)
// Exports: KanbanProjectBoardView

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getProviderStartOptions,
  resolveAssistantDeliveryMode,
  useAppSettings,
} from "~/appSettings";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { dispatchKanbanDraftCard } from "../../lib/kanbanDispatch";
import { KanbanCardView } from "./KanbanCardView";
import { KanbanColumn, parseKanbanColumnDropId } from "./KanbanColumn";
import { KanbanInlineFeedback, type KanbanFeedback } from "./KanbanInlineFeedback";
import {
  reorderDraftCardIds,
  type KanbanCard,
  type KanbanColumnKey,
  type KanbanProjectBoard,
} from "./kanban.logic";
import { useKanbanUiStore } from "../../kanbanUiStore";

function resolveDropColumn(board: KanbanProjectBoard, overId: string): KanbanColumnKey | null {
  const columnDrop = parseKanbanColumnDropId(overId);
  if (columnDrop) {
    return columnDrop.projectId === board.projectId ? columnDrop.column : null;
  }
  // Sortable draft cards are the only non-column droppables on this board.
  return board.draft.some((card) => card.cardId === overId) ? "draft" : null;
}

export function KanbanProjectBoardView({
  board,
  onOpenCard,
  onCardContextMenu,
  onNewTask,
  nowMs,
}: {
  board: KanbanProjectBoard;
  onOpenCard: (card: KanbanCard) => void;
  onCardContextMenu?: ((card: KanbanCard, event: React.MouseEvent) => void) | undefined;
  onNewTask: () => void;
  nowMs?: number;
}) {
  const { settings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const setDraftOrder = useKanbanUiStore((state) => state.setDraftOrder);
  const [activeCard, setActiveCard] = useState<KanbanCard | null>(null);
  const [feedback, setFeedback] = useState<KanbanFeedback | null>(null);
  // A completed drag still emits a click on the source card; swallow exactly that one
  // so dropping a card never also opens its chat.
  const suppressClickRef = useRef(false);

  useEffect(() => {
    setActiveCard(null);
    setFeedback(null);
  }, [board.projectId]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  useEffect(() => {
    if (feedback?.tone !== "info" && feedback?.tone !== "success") {
      return;
    }
    const timeoutId = window.setTimeout(() => setFeedback(null), 3_000);
    return () => window.clearTimeout(timeoutId);
  }, [feedback]);
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }
    return closestCorners(args);
  }, []);

  const handleOpenCard = useCallback(
    (card: KanbanCard) => {
      if (suppressClickRef.current) {
        return;
      }
      onOpenCard(card);
    },
    [onOpenCard],
  );

  const handleDispatchDrop = useCallback(
    async (card: KanbanCard) => {
      const targetProvider = card.provider ?? settings.defaultProvider;
      const sendAvailability = await resolveProviderSendAvailabilityWithRefresh({
        provider: targetProvider,
        statuses: providerStatuses,
        refreshStatuses: () => refreshProviderStatuses({ silent: true }),
      });
      if (!sendAvailability.usable) {
        setFeedback({
          tone: "error",
          title: sendAvailability.unavailableReason,
          description: "Reconnect the provider, then drag the task to In Progress again.",
        });
        return;
      }
      // The dispatch marks the optimistic overlay synchronously, so the card jumps
      // to In Progress before any round-trip; failure results revert it.
      const result = await dispatchKanbanDraftCard({
        card,
        defaultProvider: settings.defaultProvider,
        assistantDeliveryMode,
        providerOptions: providerOptionsForDispatch,
      });
      if (result.kind === "dispatched") {
        setFeedback(null);
        return;
      }
      if (result.kind === "open-thread") {
        setFeedback(null);
        onOpenCard(card);
        return;
      }
      if (result.kind === "unavailable") {
        setFeedback({
          tone: "error",
          title: "Not connected",
          description: "Reconnect to the server before sending drafts.",
        });
        return;
      }
      setFeedback({
        tone: "error",
        title: "Could not send draft",
        description: result.message,
      });
    },
    [
      assistantDeliveryMode,
      onOpenCard,
      providerOptionsForDispatch,
      providerStatuses,
      refreshProviderStatuses,
      settings.defaultProvider,
    ],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const card = board.draft.find((candidate) => candidate.cardId === event.active.id) ?? null;
      setActiveCard(card);
      suppressClickRef.current = true;
    },
    [board.draft],
  );

  const releaseClickSuppression = useCallback(() => {
    // The trailing click (if any) fires synchronously after dragend; release on the
    // next tick so regular clicks keep working when the drop happens off-card.
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveCard(null);
    releaseClickSuppression();
  }, [releaseClickSuppression]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveCard(null);
      releaseClickSuppression();
      const { active, over } = event;
      if (!over) {
        return;
      }
      const activeId = String(active.id);
      const card = board.draft.find((candidate) => candidate.cardId === activeId);
      if (!card) {
        return;
      }
      const overId = String(over.id);
      const targetColumn = resolveDropColumn(board, overId);
      if (targetColumn === "draft") {
        const visibleCardIds = board.draft.map((draftCard) => draftCard.cardId);
        const nextOrder =
          overId === activeId
            ? null
            : board.draft.some((draftCard) => draftCard.cardId === overId)
              ? reorderDraftCardIds(visibleCardIds, activeId, overId)
              : // Dropped on the column body itself: move to the end.
                reorderDraftCardIds(visibleCardIds, activeId, visibleCardIds.at(-1) ?? activeId);
        if (nextOrder) {
          setDraftOrder(board.projectId, nextOrder);
        }
        return;
      }
      if (targetColumn === "inProgress") {
        // A drag that started before the board re-derived could re-drop a card whose
        // dispatch is still settling; a second drop must not queue another turn.
        if (useKanbanUiStore.getState().optimisticDispatchByThreadId[card.threadId]) {
          return;
        }
        void handleDispatchDrop(card).catch((error: unknown) => {
          setFeedback({
            tone: "error",
            title: "Could not send draft",
            description: error instanceof Error ? error.message : "Unexpected error.",
          });
        });
        return;
      }
      if (targetColumn === "done") {
        setFeedback({
          tone: "info",
          title: "Done is derived automatically",
          description: "Cards move here when their runs complete.",
        });
      }
    },
    [board, handleDispatchDrop, releaseClickSuppression, setDraftOrder],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex h-full min-h-0 flex-col">
        <DisclosureRegion open={feedback !== null} className="shrink-0 px-4">
          <div className="pb-2">
            {feedback ? (
              <KanbanInlineFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />
            ) : null}
          </div>
        </DisclosureRegion>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4">
          <KanbanColumn
            projectId={board.projectId}
            columnKey="draft"
            cards={board.draft}
            onOpenCard={handleOpenCard}
            onCardContextMenu={onCardContextMenu}
            sortable
            droppable
            activeCard={activeCard}
            onNewCard={onNewTask}
            {...(nowMs !== undefined ? { nowMs } : {})}
          />
          <KanbanColumn
            projectId={board.projectId}
            columnKey="inProgress"
            cards={board.inProgress}
            onOpenCard={handleOpenCard}
            onCardContextMenu={onCardContextMenu}
            droppable
            activeCard={activeCard}
            {...(nowMs !== undefined ? { nowMs } : {})}
          />
          <KanbanColumn
            projectId={board.projectId}
            columnKey="done"
            cards={board.done}
            onOpenCard={handleOpenCard}
            onCardContextMenu={onCardContextMenu}
            droppable
            activeCard={activeCard}
            {...(nowMs !== undefined ? { nowMs } : {})}
          />
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <KanbanCardView card={activeCard} isOverlay {...(nowMs !== undefined ? { nowMs } : {})} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
