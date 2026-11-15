import { createFileRoute } from "@tanstack/react-router";

import { GuestPage } from "../components/guest/GuestPage";
// SCIENT-FORK: Room invites share the guest route's shell-free entry point.
import { ROOM_PAGE_PARAM } from "@t3tools/contracts";
import { RoomPage } from "../scient/room/guest/RoomPage";

export const Route = createFileRoute("/guest")({
  // SCIENT-FORK: The presence of ?room selects a room, including unspent invites.
  component: () =>
    new URLSearchParams(window.location.search).has(ROOM_PAGE_PARAM) ? <RoomPage /> : <GuestPage />,
});
