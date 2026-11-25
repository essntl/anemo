# Home task board

Status: built in `feat/home-task-board` (one PR). Screenshots in `14-home-task-board/`.

## 1. Goal

A quick overview of where everything stands, on the page the app opens with: a kanban of
tasks by status on Home. Moving a card changes the task's status (or its place in the
column); a click opens the task. It is the same board as the Tasks page and the board
layout of saved views, so the three behave alike and are fixed in one place.

## 2. What it does

- **Columns**: To do, In progress, Waiting, Blocked, Done. Cancelled tasks are not shown.
  On Home, Done holds the tasks finished in the last 7 days (latest first, at most 30) and
  ends with a "Show all" link to the Tasks page; the Tasks page keeps its latest 30.
- **Cards**: title with the project's colour dot; one line with the due date (red when
  overdue, a muted "No date" when there is none), priority, checklist progress (3/5),
  subtasks done (1/2), "Waits on n" when it is blocked by open tasks, and the task it is a
  subtask of.
- **Moving**: drag with the mouse; on a touch screen press and hold a card (400 ms), then
  drag; with the keyboard focus a card, Space picks it up, the arrows move it, Space puts it
  down, Esc puts it back. A live region tells screen readers what happened ("Picked up …",
  "Waiting, position 2 of 3", "… moved to Waiting, position 2."). Within a column cards can
  be put in order (not in Done, which sorts itself). The move shows at once; when the server
  refuses, the card goes back and a toast says why. Finishing a task with open subtasks still
  asks whether to finish them too.
- **Filters (Home)**: project (follows the project switcher until one is picked in the
  widget), tag, due (any time / overdue / this week), and "a lane per project" (one board per
  project, the tasks of none last). They are kept with the widget, so the board opens as it
  was left.
- **Opening**: a click (or Enter) opens the task editor right on Home; "+" in a column
  header starts a new task in that status (and, in a lane, that project).
- **Layout**: a Home widget like the others (moved, resized, hidden, added back in "Edit
  layout"); 3 × 2 by default. Its height sets how tall a column gets before it scrolls. On a
  narrow screen the columns scroll sideways one at a time (scroll snapping); while a card is
  dragged the board scrolls near its edges, and the page near the window's top and bottom.
- Theme tokens only (light/dark and accent follow Settings), density through `--list-row-y`,
  reduced motion turns the transitions and the tilt of the dragged card off.

## 3. Decisions and why

| Decision | Alternatives considered | Why |
| --- | --- | --- |
| **One board component** (`features/board/Board.tsx`), generic over the card, used by the Tasks page, Home and saved views | A Home-only kanban; the Tasks board copied | The Tasks page and saved views each had a board already, with their own drag code. One component means touch, keyboard and screen reader support exist everywhere at once. It sits in `features/` (not `components/ui`) because it reads its keys from the shortcut registry, which is feature code. |
| **Pointer events, not HTML drag and drop** (`usePointerDrag`) | Keep `draggable`; add a drag-and-drop library | HTML drag and drop does nothing on touch screens. A small hook covers mouse and long press with no new dependency; the board decides what a drop means. A non-passive `touchmove` listener on the board stops the page from scrolling only while a card is dragged. |
| **Long press (400 ms) on touch** | Drag from a grip | Cards stay clean and the whole card is the target; a swipe still scrolls the board, since a finger that moves before the long press is over is scrolling. |
| **Keyboard: Space to pick up, arrows, Space/Enter to put down, Esc** | Alt+arrows moving at once | Alt+← is the browser's Back on Windows. The pick-up pattern is the one screen reader users know from other boards, and it lets a move be cancelled. Enter on a card that isn't picked up opens it. The keys are in the shortcut registry (area "Boards"). |
| **Reuse `sort_order` and `POST /api/tasks/reorder`** | A new position field | Tasks already have both; no migration and no API change. |
| **Send the whole column's order** | Only the cards shown (as before) | With a filter on, only the visible cards were renumbered, so hidden tasks of that column ended up in any order among them (a bug, fixed here with a test). The hidden tasks keep their places; past 500 tasks (what the endpoint takes) only the shown order is sent. Done sorts itself by completion time, so only the moved task is sent for it. |
| **Optimistic update in `useReorderTasks`** (and in `useSetRowProperty` for views) | Wait for the server | A dropped card should stay where it was dropped. The previous cache is restored on an error, then the queries refresh either way. |
| **Filters in the widget's `options`** (Home layout settings) | A new settings section; browser storage | That is where Home keeps per-widget choices (the Briefing's automation). No backend change: `WidgetLayout.id` is a free string and `options` takes string values. As with the rest of the layout, phones keep their own copy once Home is edited on a phone. |
| **"This week" = due within the next 7 days, overdue included** | The calendar week | Matches the Tasks widget's "Due this week". "Overdue" shows open tasks only. |
| **Saved views: the property board uses `Board` with columns that sort themselves** | Leave it as it was | View rows have no order of their own, so a card can be moved to another value but not placed. The select on each card stays as a second way. |
| **`focusOnTask` became `useFocusOnTask`** (separate refactor commit) | Leave it | It imported the app's router, which put every page with a task menu in an import loop with the router; the Home widget opening the task editor added new loops that `lint:imports` rejects. It now navigates with `useNavigate()`; the dependency-cruiser baseline lost the loops that are gone. |

## 4. Data and API

No migration, no new endpoint, no API change. Used as they are:

- `GET /api/tasks?status=all`, `POST /api/tasks/reorder` (`{status, ordered_ids, subtasks}`),
  `PATCH /api/tasks/{id}` and the task editor's calls.
- `PUT /api/settings/home`: the widget `{ id: "board", w, h, options: { project, tag, due, lanes } }`.

## 5. Code

- `frontend/src/features/board/`: `Board.tsx` (columns, cards, keyboard, live region, the
  dragged card's ghost), `usePointerDrag.ts` (mouse and long press, edge scrolling),
  `placement.ts` (pure: order after a move, merging into the whole column, arrow-key steps).
- `frontend/src/features/tasks/`: `board.ts` (columns, Done window, order to save),
  `components/TaskBoard.tsx` (the status board), `components/TaskCard.tsx`,
  `api.ts` (`reorderedTasks`, optimistic `useReorderTasks`).
- `frontend/src/features/home/`: `taskBoard.ts` (filters, lanes), `widgets/TaskBoardWidget.tsx`,
  `layout.ts` (the `board` widget), `HomePage.tsx`.
- `frontend/src/features/views/`: `ViewPage.tsx` (board layout on `Board`), `api.ts` (`withProperty`).

## 6. Tests

- Unit: `board/placement.test.ts`, `tasks/board.test.ts` (columns, Done window, the whole
  column's order with hidden tasks, the optimistic change), `home/taskBoard.test.ts`
  (filters, kept options, lanes), `views/withProperty.test.ts`.
- Components: `board/Board.test.tsx` (keyboard pick-up/move/drop/cancel with announcements,
  mouse drag, long press versus swipe, the click after a drop not opening the card),
  `tasks/components/TaskBoard.test.tsx` (columns, a move shown at once and the request it
  sends, reordering with a filter on, Done, rollback and toast on an error),
  `home/widgets/TaskBoardWidget.test.tsx` (Done window and link, kept filters, choosing a
  filter, lanes, project).
- e2e: `e2e/tests/home.spec.ts` "move, reorder and open tasks on the Home board" (keyboard
  and mouse moves, reorder, opening, the kept filter); `subtasks.spec.ts` moves its card with
  the keyboard now. Both were run locally against a dev stack in Edge (not the Docker stack).

## 7. Follow-ups

- Dragging between lanes to change a task's project (each lane is its own board now).
- A "Cancelled" column or filter for those who want to see them.
- Reordering cards in saved views would need an order field on view rows.
- Touch drag on iOS Safari was not tried on a device (it is built on standard pointer and
  touch events; Edge's touch emulation was used).
