# Chat scrolling and motion

How the chat timeline scrolls and moves, in every situation, as it behaves
today on the PR #462 branch (on T3 Orchestration V2). Use it to decide what to change: each section
states the rule in plain words, then the numbers and the code that owns it.
Paths are under `apps/web/src/components/` unless they start with
`packages/`. Open questions and candidates for change are collected at the end.

## The few ideas everything rests on

- **Nothing moves the view on its own,** with two exceptions: the reveal after
  a send (and its follow), and keeping the end in view when something above
  it resizes while the thread is idle. Agent activity never pulls the view
  down by itself otherwise.
- **The reading area** is the timeline minus the composer that floats over its
  bottom. "The top margin" is 24px below the timeline's top
  (`CHAT_TIMELINE_ANCHOR_OFFSET`, matching the titlebar fade).
- **"At the end"** is one rule used everywhere: the Scroll to end control,
  sending, saved positions and the composer. It decides what "the end" is,
  then lets a little of it hide behind the composer (see the next section).
- **The follow** is what moves the view after a send. It never scrolls past
  the point where your sent message's text reaches the top margin.
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

Owner: the restore effect in `chat/MessagesTimeline.tsx`; storage in
`chat/timelineScrollAnchoring.ts`; return position in `chat/liveFollowOffset.ts`.

- **First open (nothing saved):** the view goes to the true bottom and holds
  there until the list stops growing (two stable frames, at most 60).
- **Coming back after scrolling up:** you land exactly where you were. The
  saved spot is the row at the top of the view plus your offset into it. If
  that row is gone, it falls back to the same turn, then to nearby messages,
  after loading up to 2 pages of older history.
- **Coming back to a thread you left while the follow was still going** (saved
  as the followed prompt's id; resting at the end alone is not following): you
  land where the follow would be now, not where you left.
  - **Everything since your message fits:** the end of its response (the
    bottom, unless a later message was sent from elsewhere meanwhile).
  - **It doesn't fit:** your message at the top margin.
  - **Your message is at the top but its latest answer's first lines would still be below the screen:** that answer's start goes at the top margin instead.
  - **A later message sent from elsewhere** while you were away, and what
    follows it, never move it further, whether your message's run is still
    working or has finished.
  - **Never** past the bottom. While that prompt's run still works, the follow carries on from there.
- **Any scroll, key, touch or click** during a restore cancels it and leaves
  you where you are.
- **When positions are saved:**
  - on every scroll, synchronously;
  - in each bookkeeping frame;
  - when you switch threads;
  - on page hide, with an immediate flush.
- **Where they are kept:** session storage (`scient:timeline-reading-position:v1`). Writes are debounced 120ms, at most 100 threads are kept, and only identifiers are stored, never text.
- **What else is saved:** expanded tool groups, reasoning and folds are saved with the position and re-applied.
- **The Scroll to end control** shows immediately on open if you had left away from the end.

## Sending a message

Owner: `chat/responseFollow.ts` (the one owner of the follow, called from
`ChatView.tsx`'s `frameSubmittedMessage`), `chat/useBoundedAnswerFollow.ts`.

- **Sent while away from the end:** nothing moves. The Scroll to end control
  stays available.
- **The thread's first message** (from the centered draft):
  1. The composer glides from the center to the bottom: 260ms, fast start,
     soft landing (`chat/timelineEntranceMotion.ts`, curve in
     `chat/draftHeroTransition.ts`). This always animates, not only when the
     opt-in panel animation setting is on.
  2. Room is reserved below the message, and it is placed at the top margin
     (LegendList anchored end space, from upstream T3).
  3. The message fades in, revealed from the top down: 300ms, starting 100ms
     in.
  4. The reserved room stays until real content fills the screen below it.
     Scroll to end or scrolling away releases it.
- **A later message sent at the end,** and a queued message delivered while
  you are at the end:
  1. No reserved room. The view glides to the normal bottom, with the usual
     16px gap above the composer.
  2. It then follows everything the agent produces (thinking, tool steps,
     text), staying at the bottom, until your message's text reaches the top
     margin.
  3. After that it only shows the first lines (48px) of a newer message
     pushed below the screen, and never follows an answer down to its end.
- **A queued message counts as "delivered"** when V2 marks the delivered
  prompt so (`queued_turn`, or `promoted_queued_to_steer`). It keeps its
  message id, so this window's own queued send counts too, even when the
  delivery arrives before the send's receipt. A message promoted to a steer
  is followed with the run it went into. A message sent directly from
  another window is never followed.

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
  - **Scrolling up** by any means cancels the follow for good.
  - **Clicks and text selection** never cancel it.
- **Far behind** (more than a screen to go): it skips all but the last screen
  at once, then glides.
- **When it ends:** once the prompt's own V2 run has ended and its last
  message has been revealed; or when you scroll up, click Scroll to end, or
  switch threads; or when the send fails. While the run is queued,
  preparing or starting, it waits rather than ending.
- **At rest:** with nothing to reveal it does nothing until the content, the
  view or an answer's reveal changes.

## While the agent works

Owners: `chat/timelineWorkingState.ts`, `chat/workingRowExit.ts`,
`chat/ThinkingRowFade.tsx` (seams in `chat/MessagesTimeline.tsx`).

- **"Working for…" header:** a label and a separator line under it.
  - The label carries the same live shine as the thinking traces (a 4.5rem
    band, 2.2s, looping) for as long as the turn works.
  - The line simply appears and stays.
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
- **Active tool labels** use a stepped shine (2.2s). All shines pause off
  screen, in hidden tabs, and under reduced motion.

## How an answer appears

`chat/useStreamingBlockEntrance.ts`, the `.streamed-reveal` rule in `index.css`.

Providers send an answer a paragraph at a time. It is shown as one continuous
flow:

1. **The first lines wait 1s,** so the next paragraphs are usually in hand.
2. **Lines then appear top to bottom at about 4 lines a second.** The newest
   line shows at 65% strength, and the full tone follows one line behind.
   Nothing below the newest line shows yet, and each line fades in through a
   soft edge.
3. **The blank space between paragraphs is crossed 5× faster,** so there's no
   pause at a paragraph break.
4. **If more than 8 lines are waiting,** the pace rises gently to catch up.
   When the answer finishes, the rest plays out; nothing is cut off.
5. **The answer is clipped to the lines shown so far.** It grows line by line,
   and whatever follows it stays right below the newest line.
6. **No replays:**
   - A row that scrolls away and back, or a thread you switch away from and
     back to, continues where it was (progress is kept for 100 messages).
   - A finished answer that was never revealed in this window simply shows.
7. **Caught up with an answer still streaming,** the reveal rests until the
   answer's text, width or images change.

Only masking and clipping are used, so nothing slides. List bullets are not
clipped.

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
  - It reacts only to crossing the end, never to repeated events.
- **Clicking it** jumps to the true bottom with an animation. It also releases
  any reserved room and restores a scroll-collapsed composer.
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

`ChatComposer.tsx`, `chat/composerFooterLayout.ts`

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
  (16px on wider windows).
- **Nested tool lists:** up to 18rem tall, with 1.5rem fades at the edges
  once scrolled. They follow new calls only if already at their bottom.

## Numbers in one place

| What                                      | Value                                               | Where                                                           |
| ----------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| Top margin for placed messages            | 24px                                                | `chat/timelineScrollAnchoring.ts`                               |
| End allowance                             | 3 lines, at least 40px (40px for your own message)  | `chat/readerScrollPolicy.ts`                                    |
| Gap kept above the composer at the bottom | 16px (12px narrow)                                  | `chat/useBoundedAnswerFollow.ts`, footer                        |
| Scroll to end show delay                  | 150ms (hide instant)                                | `chat/useTimelineEndControl.ts`                                 |
| Follow top speed / acceleration           | 1px/ms / 0.004px/ms²                                | `chat/useBoundedAnswerFollow.ts`                                |
| Follow yields after your scroll           | 250ms                                               | `chat/useBoundedAnswerFollow.ts`                                |
| First lines shown of a message below      | 48px                                                | `chat/useBoundedAnswerFollow.ts`, `chat/liveFollowOffset.ts`    |
| Answer reveal wait / pace / catch-up      | 1s / 4 lines a second / above 8 waiting lines       | `chat/useStreamingBlockEntrance.ts`                             |
| Gap speed-up / newest-line strength       | 5× / 65%                                            | `chat/useStreamingBlockEntrance.ts`, `index.css`                |
| Composer glide (first send)               | 260ms, cubic-bezier(0.2, 0, 0, 1)                   | `chat/timelineEntranceMotion.ts`, `chat/draftHeroTransition.ts` |
| First message entrance                    | 300ms after 100ms                                   | `chat/timelineEntranceMotion.ts`                                |
| Working header exit                       | 320ms, cubic-bezier(0.45, 0, 0.55, 1)               | `chat/workingRowExit.ts`                                        |
| Thinking fade                             | 300ms                                               | `chat/ThinkingRowFade.tsx`                                      |
| Shines                                    | 4.5rem band, 2.2s                                   | `index.css`                                                     |
| Interaction settle / disclosure settle    | 400ms / 2 frames                                    | `chat/MessagesTimeline.tsx`                                     |
| Position storage                          | 120ms debounce, 100 threads                         | `chat/timelineScrollAnchoring.ts`                               |
| Restore history                           | up to 2 pages; citations up to 20                   | `chat/MessagesTimeline.tsx`, citations                          |
| Page keys                                 | screen − 36px in 150ms; hold ramps to 2× over 400ms | `chat/pageScrollController.ts`                                  |
| Citation offset / pulse                   | min(120px, ⅓ view) / 3s                             | `chat/AssistantCitationSource.tsx`                              |

## Where Scient differs from upstream T3

Recorded in `UPSTREAM.md`:

- **Later sends:** they follow the whole response (T3 only reveals the
  answer's growth).
- **The draft composer:** it always animates, instead of following the opt-in
  setting.
- **Motion added by Scient:**
  - the first-message entrance;
  - the working header shine and exit;
  - the Thinking fade;
  - the line-by-line answer reveal;
  - the working-row timing (waits for your message);
  - the return-to-following position.
- **Unchanged from T3:** the first-message reserved room, and the shared
  `resolveChatListAnchoredEndSpace`, which mobile also uses.

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
- **Long code blocks and tables** in a streaming answer are revealed by height
  like text. Each takes as long as its number of lines.
- **`data-scroll-anchor-ignore`** markers in several rows have no effect any more.
- **Tests:** ChatView itself has no browser harness. The follow is tested
  through its controller, wired as ChatView wires it
  (`chat/responseFollow.browser.test.tsx`), on a controlled motion clock.
