# Chat scrolling and motion

How the chat timeline scrolls and moves, in every situation, as it behaves
on main. Use it to decide what to change: each section
states the rule in plain words, then the numbers and the code that owns it.
Paths are under `apps/web/src/components/` unless they start with `scient/`
(under `apps/web/src/`), `apps/` or `packages/`. The scrolling and motion
modules named `chat/…` are Scient-only files inside upstream's
`components/chat/` directory. Open questions and candidates for change are
collected at the end.

## First principles

The timeline does two jobs that pull against each other:

1. **Show what the agent is doing now.** While it works, the reader at the
   bottom wants to see its live activity, not a stale screen.
2. **Never move text while the reader is reading it.**

Everything in this document resolves that tension the same way:

- **Work is watched; answers are read.** Thinking, tool steps, compaction and
  short progress notes ("Checking the logs next.") go by like a status
  display, so the view keeps up with them. A real answer, a plan or a card is
  read line by line, so the view stops before its start passes the top
  margin. "A real answer" is the same rule that keeps an answer visible when
  its turn folds (`keepsSettledAnswerVisible`, in
  `scient/threadTimeline/keptAnswers.ts`): structure, an image, or at least
  400 characters. A message still arriving counts as read until it is
  finished, because it cannot be judged yet. Work the reader opened (an
  expanded tool group or reasoning) counts as read too.
- **The reader decides.** Being at the bottom while the agent works means
  following it, whoever started the run. Scrolling up leaves; coming back to
  the bottom, or Scroll to end, rejoins. What the reader has scrolled past is
  read and no longer stops the view, except an answer still arriving: an
  answer is never followed down.
- **Nothing else moves the view.** New rows below a reader who is not at the
  bottom, footer status, and messages arriving while the reader is away stay
  where they land; the Scroll to end control says what is below. The one
  exception is keeping the end in view when something above it resizes while
  the thread is idle.
- **The reader's own queued messages are part of the end.** They are what the
  reader acts on next, so they are kept reachable (see "Your queued
  messages").

Terms used below:

- **The reading area** is the timeline minus the composer that floats over its
  bottom. "The top margin" is 24px below the timeline's top
  (`CHAT_TIMELINE_ANCHOR_OFFSET`, matching the titlebar fade).
- **"At the end"** is one rule used everywhere: the Scroll to end control,
  sending, joining the follow, saved positions and the composer. It decides
  what "the end" is, then lets a little of it hide behind the composer (see
  the next section).
- **The follow** is what moves the view while the reader follows a run.
- **Reduced motion** (the system setting) turns every animation in this
  document into an instant change.

## What "at the end" means

`chat/readerScrollPolicy.ts` (`readerAtReadingEnd`, `readingEndRowIndex`)

| Situation                                                | The end is                                                                                               | Allowed hidden behind the composer                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A turn is running, or ended interrupted or with an error | that turn's latest row (busy indicators like Working/Thinking excluded)                                  | 3 lines of that row, at least 40px                         |
| The latest turn completed                                | its answer (assistant message or plan); trailing tool rows, files and your own later message don't count | 3 lines of the answer (its own line height), at least 40px |
| A completed turn wrote no answer                         | its latest content row                                                                                   | as above                                                   |
| No answer exists yet                                     | your latest message's text                                                                               | a flat 40px                                                |

The Scroll to end button jumps to the true bottom of the list, not to this end.

## Opening a thread and coming back to one

Owner: `useReadingRestoreTarget` and `useReadingPositionRestore` in
`chat/readerScrolling.ts` (mounted in `chat/MessagesTimeline.tsx`); saving in
`useSaveReadingPosition` (same file); session storage in
`chat/readingPositionStore.ts`, called from upstream's in-memory map in
`chat/timelineScrollAnchoring.ts`; return position in `chat/liveFollowOffset.ts`.

- **First open (nothing saved):** the view goes to the true bottom and holds
  there until the list stops growing (two stable frames, at most 60).
- **Coming back after scrolling up:** you land exactly where you were. The
  saved spot is the row at the top of the view plus your offset into it. If
  that row is gone, it falls back to the same turn, then to nearby messages,
  after loading up to 2 pages of older history.
- **Coming back after resting at the end** (not following): you land on the
  same row and offset, not at the new end. If new content arrived below, the
  Scroll to end control shows.
- **Opening a working thread, or coming back to one, at its end** joins its
  follow (see "Who follows").
- **Coming back to a thread you left while the follow was still going** (saved
  as the followed prompt's id): you land where the follow would be now, not
  where you left.
  - **Nothing in the response since you left is read content:** the end of
    its response (the bottom, unless a later message was sent meanwhile).
  - **Otherwise:** the first answer, plan or card of that response at the top
    margin, or its end if that comes first.
  - **That answer is at the top but a later answer's first lines would still be below the screen:** the later answer's start goes at the top margin instead.
  - **A later message sent from elsewhere** while you were away, and what
    follows it, never move it further, whether your message's run is still
    working or has finished.
  - **Rows not rendered yet** (a long response grew while you were away) are
    scrolled into view and measured first, within the same bounded settling.
    If your message itself is not in the loaded history, you land at the end.
  - **Never** past the bottom. While that prompt's run still works, the follow carries on from there.
- **Any scroll, key, touch or click** during a restore cancels it and leaves
  you where you are.
- **When positions are saved** (one writer, `useSaveReadingPosition`; it
  skips while a placement, citation jump or restore is in progress, so a
  saved record always names its message):
  - on every scroll, synchronously;
  - in each bookkeeping frame;
  - when you switch threads;
  - on page hide, with an immediate flush.
- **Where they are kept:** session storage (`scient:timeline-reading-position:v1`). Writes are debounced 120ms, at most 100 threads are kept, and only identifiers are stored, never text.
- **What else is saved:** expanded tool groups, reasoning and folds are saved with the position and re-applied.
- **The Scroll to end control** shows immediately on open if you had left away from the end.

## Who follows

Owner: `chat/responseFollow.ts` (the one owner of the follow: `start`, `join`,
`useArrivedPromptFollow`), called from `chat/useTimelineFollow.ts`;
`MessagesTimeline.tsx` reports arriving at the end.

The follow belongs to one prompt's V2 run. A reader at the end starts or
rejoins it:

- **You send a message at the end** (`frameSubmittedMessage`). Sent while away
  from the end, nothing moves; Scroll to end stays available.
- **A prompt arrives while you are at the end,** from anywhere: your queued
  message delivered (V2's `queued_turn` or `promoted_queued_to_steer` intent,
  which keeps its message id, so it counts even when the delivery arrives
  before the send's receipt), another window, your phone, a schedule, another
  agent or a guest. A thread's first listing is not an arrival.
- **You arrive at the end while its latest prompt's run works:** scrolling
  down to it, Scroll to end, or opening the thread there. Joining a follow
  already running only marks what you scrolled past as read.
- **A follow you ended stays ended** while you stay at the end: you have to
  leave the end and come back. Scrolling a little up within the end's
  allowance ends it but does not leave the end.

**The thread's first message** (from the centered draft) keeps its entrance:

1. The composer glides from the center to the bottom: 260ms, fast start, soft
   landing (`chat/timelineEntranceMotion.ts`, curve in
   `chat/draftHeroTransition.ts`). This always animates, not only when the
   opt-in panel animation setting is on.
2. Room is reserved below the message, and it is placed at the top margin
   (LegendList anchored end space, from upstream T3).
3. The message fades in, revealed from the top down: 300ms, starting 100ms in.
4. The reserved room stays until real content fills the screen below it.
   Scroll to end or scrolling away releases it.
5. Then the follow carries on as for any message. Later messages get no
   reserved room: the view glides to the normal bottom, with the usual 16px
   gap above the composer.

## Where the follow stops

`followLimitIndex` and `boundedAnswerScrollDelta` in
`chat/useBoundedAnswerFollow.ts`; `chat/liveFollowOffset.ts` places a returning
reader with the same rule.

- **It follows the response to its live end:** thinking, tool steps, short
  progress notes, your own prompt scrolling away above, and your queued
  messages after the latest response.
- **It stops at the first read row** of the response whose start would pass
  the top margin: an answer, a plan, a card, a message still arriving, or work
  you expanded. Rows you had already scrolled past when you joined do not
  stop it, unless still arriving.
- **After it stops** it only shows the first lines (48px) of a newer message
  pushed below the screen, never past that message's start. Everything else
  below is announced by Scroll to end.
- **A response ends at the next prompt.** A later prompt and what follows it
  belong to that prompt's own follow.

## How the follow moves

`chat/useBoundedAnswerFollow.ts`

- **It has a speed of its own that only changes gradually.** It speeds up
  gently (about 250ms to top speed), cruises at most 1px per ms, and brakes
  into place. Bursts of new content become one drift instead of hops.
- **While an answer is being revealed line by line,** the follow simply goes
  to the real bottom. The answer only takes the room of the lines shown, so
  the bottom is the newest line plus the row after it.
- **Your own scrolling:**
  - **Scrolling toward the end** (wheel, trackpad, ArrowDown/PageDown/End/Space,
    touch, or a scrollbar drag): the follow stops writing the scroll
    position, and picks up from rest 250ms after your input stops. It used
    to fight your scroll and feel hesitant.
  - **Scrolling up** by any means ends the follow until you come back to the
    end (see "Who follows").
  - **Keys count only when they scroll the timeline:** focus in it or
    nowhere, no modifier, not typing in a field. Arrow keys in a menu or a
    shortcut such as ⌘↑ leave the follow be.
  - **Clicks** never cancel it. **Selecting text** in the timeline holds the
    view still; the follow resumes once the selection is cleared.
- **Far behind** (more than a screen to go): it skips all but the last screen
  at once, then glides.
- **When it ends:** once the prompt's own V2 run has ended and its last
  message has been revealed; or when you scroll up or switch threads; or when
  the send fails. Scroll to end ends it and rejoins at the bottom. While the
  run is queued, preparing or starting, it waits rather than ending.
- **At rest:** with nothing to reveal it does nothing until the content, the
  view or an answer's reveal changes.

## While the agent works

Owners: `chat/timelineWorkingState.ts`, `chat/workingRowExit.ts`,
`chat/ThinkingRowFade.tsx`, `chat/liveActivity.tsx` and
`scient/presentation/scient-live-activity.css` (seams in `chat/MessagesTimeline.tsx`).

- **One sweep, on the current activity only.** The current activity is the
  latest live row: Thinking, the running-tool bar, an active compaction, or the
  latest running worktree setup stage. Only it carries the moving light. Other
  work in progress (earlier groups still running, entries in an expanded group,
  the setup popover) stays still, so the page never shimmers all over.
  - **The light:** a band 7rem wide with a full-strength core about a word wide
    (2.5rem), passing at 160px per second for any label length, looping
    continuously: each pass ends as the light leaves the label and the next
    begins as it enters, with no pause. The pace is measured again between
    passes, so a new tool label keeps it (the next pass then starts cleanly
    from the left).
  - **The resting text:** while a row sweeps, its own text rests at 55%, so the
    light (full color) is clearly seen.
  - **Pausing:** it pauses off screen and in hidden tabs.
- **A running step that has run 10s** shows how long it has been running
  ("Running vp · 12s"), ticking every second (`LiveStepElapsed` in
  `chat/liveActivity.tsx`).
- **"Working for…" header:** a small breathing dot (6px, fading between 40% and
  100% every 1.6s), then the label, then a separator line under it. The line
  simply appears and stays. The dot fades out with the header's exit.
  - **Compacting, or preparing a worktree before its setup card has a running
    stage:** the header's own label ("Compacting…", "Setting up worktree…") is
    the current activity and sweeps.
- **It appears only once your message is in the list,** so it never shows
  under the previous answer and then jumps below your message. The exception
  is a worktree being set up, which shows at once.
- **It doesn't flicker out** between the server accepting your message and
  the agent starting its run: it stays while that message's own run is
  preparing or starting.
- **When the turn finishes,** the header fades out while its space closes
  (320ms, even ease), so the answer slides up instead of snapping up about 43px.
  If the next run starts first, or motion is reduced, the exit stops at once.
- **"Thinking" row** (below the content):
  - It fades out over 300ms, keeping its 28px place, while the answer
    right above it is appearing.
  - It shows again when the agent goes back to thinking. With tools, the
    live tool row (e.g. "Running command") takes its place.
  - During the 1s wait before an answer's first line, it stays visible.
- **Reduced motion:** no sweep and no dimming; the working header's dot stays,
  still, so the working state stays visible. In high-contrast mode the dot
  takes the system text color.

## How an answer appears

`chat/useStreamingBlockEntrance.ts`, the `.streamed-reveal` rule in
`scient/presentation/scient-streamed-reveal.css`.

Providers stream tokens; the server releases the answer in complete blocks
(paragraphs, lists, code blocks), at most every 400ms, under Settings ▸
Response streaming ("paragraph", the default;
`apps/server/src/orchestration-v2/assistantStreaming.ts`). In "turn" mode the
answer arrives finished and simply shows, with no reveal. In paragraph mode it
is shown as one continuous flow:

1. **The first lines wait 1s,** so the next paragraphs are usually in hand.
2. **Lines then appear top to bottom at about 4 lines a second.** The newest
   line shows at 65% strength, and the full tone follows one line behind.
   Nothing below the newest line shows yet, and each line fades in through a
   soft edge.
3. **The blank space between paragraphs is crossed 5× faster,** so there's no
   pause at a paragraph break.
4. **If more than 8 lines are waiting,** the pace rises gently to catch up.
   When the answer finishes, the rest plays out; nothing is cut off. When
   the reader presses Stop, everything that has arrived shows at once
   (`showStreamedAnswersNow`, called by `scient/chat/useStopGeneration.ts`).
5. **The answer is clipped to the lines shown so far.** It grows line by line,
   and whatever follows it stays right below the newest line.
6. **No replays:**
   - A row that scrolls away and back, or a thread you switch away from and
     back to, continues where it was (progress is kept for 100 messages).
   - A finished answer that was never revealed in this window simply shows.
7. **Caught up with an answer still streaming,** the reveal rests until the
   answer's text, width or images change.

Only masking and clipping are used, so nothing slides. List bullets are not
clipped. Upstream's 600ms per-block fade (`.chat-markdown[data-streaming] > *`
in `index.css`) still runs underneath; on an answer the mask mostly hides it,
and it is the only entrance effect on streaming reasoning.

**Rich content** waits for what it needs:

- Diagrams and charts (Mermaid, Vega-Lite, Plotly) stay as source
  while the answer streams and become cards once it settles.
- Math typesets as soon as its closing delimiter arrives.
- Inline workspace image cards wait for the settled answer.

## When a turn settles

Owners: `deriveTurnFolds` in `chat/MessagesTimeline.logic.ts` (upstream's
rule), with one marked call to `scient/threadTimeline/keptAnswers.ts`; the
rule itself is `isSubstantiveAnswer` in
`packages/scient-conversation/src/answerVisibility.ts`.

- **The work folds** behind one "Worked for…" row at the start of the turn:
  tool steps, reasoning and short progress notes. The turn's last answer
  stays visible.
- **Earlier real answers stay visible too,** in place. A message counts as a
  real answer when it has structure (a heading, a list of two or more items,
  a table, fenced code, display math, an image) or at least 400 characters.
- **A kept answer** gets the final answer's copy button, time and spacing.
  The turn's other roles stay with its last message: forking, the trailing
  tool footer, the unread count, fork baselines and export.
- **Find in thread and citations** see the same rows, because the rule lives
  in the fold itself.

## Keeping the end in view while idle

`keepReadingEndInView` and `idleEndKeeping` in `chat/readerScrolling.ts`

- **When you rest at the end** (by the rule above) and content above the end
  grows (an image or diagram finishes loading, the window or a panel resizes),
  the view moves down by exactly the growth.
- **It only ever moves down.** It never reacts to new or removed rows, and
  never to your own scrolling.
- **It is off while:**
  - the thread is working;
  - a send's reveal is active;
  - you are interacting (any click or key in the timeline, then 400ms);
  - a disclosure toggle is settling (two frames);
  - a placement, citation or restore is in progress;
  - the first-message reserved room exists.
- **Your scrolling counts as input** until three still frames pass (and the
  scrollbar is released): wheel, touch, scrollbar drag, and arrow, Page,
  Home, End and Space keys (not when typing in the composer).

## The Scroll to end control and the unread count

`chat/useTimelineEndControl.ts`, `chat/unreadTimelineMessages.ts`

- **Showing and hiding:**
  - It shows 150ms after you leave the end, and repeated scroll events don't
    restart that delay. It hides at once when you reach the end.
  - It also shows, at once, while your queued messages are below the reading
    area, even when the reading end is in view. Its label then says how many
    are queued ("Scroll to end · 1 queued").
  - It reacts only to crossing the end, never to repeated events. ChatView
    hands every end report to it unfiltered: the timeline never pins itself
    to the end, so content growing below you (for example after a follow has
    stopped at the top margin) always brings the control back.
- **Clicking it** jumps to the true bottom with an animation. It also releases
  any reserved room and restores a scroll-collapsed composer. While the thread
  works, you then follow it again.
- **The unread count** counts new final answers below the reading area.
  - **What counts:** the latest assistant message of each response. Progress
    notes a later message supersedes don't count.
  - **When something becomes read:** once any part of it has been on screen.
  - **When it resets:** when you reach the end, or switch thread.
  - **Display:** it shows only with the control, up to "99+".
  - **Limits:** messages in folded turns and messages above the view are not
    counted.
- **Position:** the control floats 4px above the composer area, skipping
  docked banners that don't overlap it.

## Your queued messages

`chat/queuedRunsInView.ts`; the queue itself is upstream's `QueuedRunsControl`
at the end of the timeline, after the thread's status rows.

Your queued messages carry actions (Send now, Edit, Remove), so they are kept
reachable rather than treated as status:

- **While you follow a run,** the queue is part of the end the follow keeps in
  view.
- **Queuing a message while at the end** brings it, and its Send now, into
  view above the composer.
- **A queue wholly in view stays in view** when it grows (another message,
  Show all) or the composer grows over it (editing a queued message).
- **Otherwise nothing moves:** a message queued from another window or by a
  guest while you are away from it, or a queue below where you are reading.
  Scroll to end shows and names it instead.
- **Other footer rows** (the thread's status, background work, guest messages
  waiting, sign-in requests) never move the view.

## Moving through the conversation

- **Citations** (`chat/useAssistantCitationTarget.ts`,
  `chat/AssistantCitationSource.tsx`):
  - **The scroll:** opening a cited answer loads older history if needed (up
    to 20 pages) and unfolds its turn. It then scrolls so the quote sits
    min(120px, a third of the view) below the top, animated.
  - **The highlight:** the quote pulses twice and holds, over 3s in total.
  - **Dismissing it:** Escape. Any scroll or click before it lands cancels it.
- **Minimap** (mouse/trackpad only, two or more of your messages):
  - **What it shows:** ticks on the left for each of your messages, darker
    for those in view, with a preview card on hover.
  - **Navigating:** clicking a tick, or the previous/next chevrons, scrolls
    that message to the top margin with an animation. Arrow keys, Home and
    End move within it, and Enter or Space jumps.
- **Older history:** a "Load earlier turns" button at the top, with no
  automatic loading at the top. The first window shows 10 of your turns, and
  each older page adds 20. Loading keeps what you see in place.
- **Page Up / Page Down from the composer** (`chat/pageScrollController.ts`):
  - **One press:** scrolls a screen minus 36px and the composer, in 150ms.
  - **Holding:** after 150ms it scrolls continuously, speeding up to 2× over
    400ms.
  - **Page Up** also cancels a send's placement or follow. Page Down never
    does.
- **Disclosures** (turn folds, tool groups, reasoning, tool entries): only the
  toggled row holds its place while the content changes size. A new turn
  folds the previous one.

## The composer and scrolling

`chat/ChatComposer.tsx`, `chat/composerScrollGesture.ts` (thresholds in
`chat/ChatComposer.tsx`), `composerFooterLayout.ts`

- **Collapse on scroll** (setting "composerCollapseOnScroll", off by default;
  desktop, existing threads):
  - **Wheel:** collapses after 24px of wheel movement (the gesture resets
    after 120ms idle).
  - **Keys:** Page Up or Home, or Page Down or End away from the end.
  - **On mobile,** the composer is collapsed whenever it isn't focused and
    holds a single line.
- **It comes back when you:**
  - reach the end while scrolling toward it;
  - scroll down at the end;
  - press Page Down, End or ArrowDown at the end;
  - click Scroll to end;
  - collapse tool output or reasoning while at the end.

## Edges of the timeline

- **Top:** a 24px graded fade under the titlebar (the scrollbar lane stays
  solid). It is off while an error or provider-status banner shows at the top.
- **Bottom:** no fade. The list ends with the composer's height plus 12px
  (16px on wider windows). The follow aims for a fixed 16px gap; on narrow
  windows its clamp to the scroll range absorbs the 4px difference.
- **Nested tool lists:** up to 18rem tall, with 1.5rem fades at the edges
  once scrolled. They follow new calls only if already at their bottom.

## Numbers in one place

| What                                      | Value                                                                      | Where                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Top margin for placed messages            | 24px                                                                       | `chat/timelineScrollAnchoring.ts`                                       |
| End allowance                             | 3 lines, at least 40px (40px for your own message)                         | `chat/readerScrollPolicy.ts`                                            |
| Gap kept above the composer at the bottom | follow: 16px (`END_GAP`); list footer: 12px narrow, 16px wide              | `chat/useBoundedAnswerFollow.ts`, `chat/MessagesTimeline.tsx` footer    |
| Scroll to end show delay                  | 150ms (hide instant)                                                       | `chat/useTimelineEndControl.ts`                                         |
| Follow top speed / acceleration           | 1px/ms / 0.004px/ms²                                                       | `chat/useBoundedAnswerFollow.ts`                                        |
| Follow yields after your scroll           | 250ms                                                                      | `chat/useBoundedAnswerFollow.ts`                                        |
| First lines shown of a message below      | 48px                                                                       | `chat/useBoundedAnswerFollow.ts`, `chat/liveFollowOffset.ts`            |
| Answer reveal wait / pace / catch-up      | 1s / 4 lines a second / above 8 waiting lines                              | `chat/useStreamingBlockEntrance.ts`                                     |
| Gap speed-up / newest-line strength       | 5× / 65%                                                                   | `chat/useStreamingBlockEntrance.ts`, `scient-streamed-reveal.css`       |
| Composer glide (first send)               | 260ms, cubic-bezier(0.2, 0, 0, 1)                                          | `chat/timelineEntranceMotion.ts`, `chat/draftHeroTransition.ts`         |
| First message entrance                    | 300ms after 100ms                                                          | `chat/timelineEntranceMotion.ts`                                        |
| Working header exit                       | 320ms, cubic-bezier(0.45, 0, 0.55, 1)                                      | `chat/workingRowExit.ts`                                                |
| Thinking fade                             | 300ms                                                                      | `chat/ThinkingRowFade.tsx`                                              |
| Live sweep / working dot                  | 7rem band (2.5rem core), 160px/s, continuous loop, text at 55% / 6px, 1.6s | `chat/liveActivity.tsx`, `scient/presentation/scient-live-activity.css` |
| Interaction settle / disclosure settle    | 400ms / 2 frames                                                           | `chat/readerScrolling.ts` / `chat/MessagesTimeline.tsx`                 |
| Position storage                          | 120ms debounce, 100 threads                                                | `chat/readingPositionStore.ts`                                          |
| Restore history                           | up to 2 pages; citations up to 20                                          | `chat/readerScrolling.ts`, citations                                    |
| Kept answer                               | structure, or at least 400 characters                                      | `packages/scient-conversation/src/answerVisibility.ts`                  |
| Live step timer                           | after 10s, ticking every second                                            | `chat/liveActivity.tsx`                                                 |
| Page keys                                 | screen − 36px in 150ms; hold ramps to 2× over 400ms                        | `chat/pageScrollController.ts`                                          |
| Citation offset / pulse                   | min(120px, ⅓ view) / 3s                                                    | `chat/AssistantCitationSource.tsx`                                      |

## Where Scient differs from upstream T3

Recorded in `UPSTREAM.md`:

- **How T3 scrolls:** it pins the list to the live end
  (`maintainScrollAtEnd`, smooth while working) until the reader scrolls
  away. While the reader follows, it also places each new run's prompt at
  the top, including runs started from another window. Scroll to end
  re-arms the pinning.
- **How Scient scrolls:** pinning is off (`maintainScrollAtEnd={false}`).
  A reader at the end of a working thread follows it, whoever started the
  run, but the follow stops before an answer, plan or card's start passes the
  top margin (work and short notes are followed through). Scroll to end, or
  coming back to the end, rejoins. Footer status never moves the view; the
  reader's queued messages are kept reachable instead of upstream's
  footer-growth follow.
- **Other reading differences:**
  - the reading-end rule for "at the end" (T3: a flat 40px band at the true
    bottom);
  - keeping the end in view while idle;
  - reading positions by message identity, kept in session storage, with
    history paging (T3: in memory, by row id and offset);
  - coming back to the saved row even when it was saved at the end (T3 goes
    to the end);
  - the unread count on Scroll to end;
  - no reserved room for later sends or for runs started elsewhere.
- **The draft composer:** it always animates, instead of following the opt-in
  setting.
- **Motion added by Scient:**
  - the first-message entrance;
  - the working header's dot and exit, and the single live sweep, kept
    smooth (linear) where T3 #18191 steps it (`steps(30)`);
  - the live step timer;
  - the Thinking fade;
  - the line-by-line answer reveal, which shows everything at once on Stop;
  - the working-row timing (waits for your message);
  - the return-to-following position.
- **Kept answers:** earlier real answers stay visible when a turn folds (T3
  keeps only the last message).
- **Kept from T3:** the reserved room, for the first message only; the shared
  `resolveChatListAnchoredEndSpace`, which mobile also uses; upstream's
  per-block streaming fade.

## Open questions and candidates for change

Ideas we discussed but haven't built:

- **Tie the scroll to the reveal 1:1** once caught up, so the page and the text
  move as one motion instead of two smoothers.
- **Match the reveal's pace to how fast the model actually writes,** instead of
  a fixed 4 lines a second with a catch-up rule.
- **Let the newest line write in from left to right** (a typing feel), with the
  line above darkening behind it.

Known rough edges, found while mapping this:

- **Interrupted or failed turns:** idle end keeping judges the end the way it
  does for a completed turn, while the Scroll to end control uses the turn's
  latest row. The two can disagree after a stopped turn.
- **The first-message reserved room** is released only once content reaches
  the very bottom of the viewport, including the strip behind the composer.
  It also comes back when you return to the thread.
- **A restore in progress restarts** whenever new rows stream in.
- **The answer jumps when its turn folds.** When a run settles, its work
  folds behind "Worked for…" above the final answer. Measured with a long run
  and the answer's start at the top margin, the answer moves by 200–400px
  instead of holding still, with or without the follow. Holding only message
  rows as LegendList's anchor does not fix it; the list repositions wrongly
  when many rows above are replaced at once. Not yet investigated further.
- **Long code blocks and tables** in a streaming answer are revealed by height
  like text. Each takes as long as its number of lines.
- **A streaming answer first seen mid-stream** (entering the thread, or
  scrolling to a long answer that was never mounted) hides what is already
  written for 1s, then reveals it from the top at the catch-up pace.
- **The reveal sets the answer's height every frame** (`max-height` follows
  the front), so a long reveal re-lays out its row each frame.
- **`data-scroll-anchor-ignore`** markers in several rows are upstream's own
  markup and have no effect; there is nothing for Scient to change.
- **Tests:** ChatView itself has no browser harness. The follow is tested
  through its controller, wired as ChatView wires it
  (`chat/responseFollow.browser.test.tsx`), on a controlled motion clock.
