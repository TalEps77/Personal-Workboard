---
name: workboard
description: The user's task board (Workboard) is the ONLY task system, covering work, personal and shared-home tasks, the schedule and the shared shopping lists. Use it for ANY task, to-do, reminder, schedule or shopping request on WhatsApp - capture tasks, "what's on my plate", update status, tick steps, set or snooze reminders, replies to reminders Workboard sent. Use the mcp_workboard_* tools; never write scripts or curl for normal work. Workboard owns reminders - never use agent cron or kanban for these.
version: 1.1.0
platforms: [linux]
metadata:
  hermes:
    tags: [Tasks, Productivity, Reminders, Shopping, Hebrew]
---

# Workboard: tasks, schedule and shopping lists

Your interface is the **`mcp_workboard_*` tools**. They answer in short Hebrew lines, resolve dates on the server,
and record your changes under your own name, with undo available on the dashboard. A task link is
`<dashboard url>/#/task/<id>`.

## The tools: one or two calls per request

| Tool | Use for |
| --- | --- |
| `board` | **Start here** for anything about time or the agenda: current local date/time, the next 8 days by name, statuses, projects, today's agenda, and **reminders recently sent to WhatsApp**. |
| `find_tasks` | Search by text, `#id`, person (`with`), project, status, `due`, `space`. `detail:true` for steps, notes, reminders. |
| `create_tasks` | One or many tasks in one call: project, status, dates, `with`, steps, `remind`. Warns about likely duplicates. |
| `update_tasks` | One or many changes in one call: fields, `done:true`, `append_note`, `check_steps:[1]`, `edit_steps`, `add_steps`. Per-item result plus an undo id. |
| `remind` | New reminder, move/snooze (`reminder_id` or `"latest"`), or `cancel`. Supports `repeat` and `nag`. |
| `focus` | The user has free time ("I have an hour", "what should I work on?"): their independent tasks ranked by urgency, with reasons and the next step. `minutes:30` when they say how long. |
| `calendar` | The schedule day by day, plus **free gaps**: "what do I have tomorrow", "when can I schedule X". |
| `add_events` / `update_events` | Put meetings and blocked work time on the schedule; move or cancel them. |
| `projects` | List projects, or create/update one (name, `add_aliases`, goal, due). |
| `shopping` | The shared household lists: add (many items in one call), check off, remove, move, claim, finish. Always returns the list. |
| `history` / `undo` | What changed (with ids) / revert one change. |

Rules for using them:

- **No `date`, no scripts, no arithmetic.** Pass the user's words in the server's vocabulary; it resolves them in
  the configured time zone and work week. Dates: `today`, `tomorrow`, `next-workday`, `sun`...`thu` or
  `ראשון`...`חמישי` (always the coming one, never today), `next-week`, `end-of-week`, `+3d`, `21.10`. Also
  `חמישי שאחרי`, `עוד 3 ימים`. Reminder times: `+90m`, `עוד שעה`, `בעוד חצי שעה`, `17:00`, `מחר ב-7:30`,
  `מחר 7:30 בערב` (= 19:30), `ראשון בשעה 9:30`. It is a fixed vocabulary, not free Hebrew: if a phrase is
  rejected, rephrase using these forms (the error lists them). Impossible dates are refused.
- Each result shows the resolved day and date. **Quote it in your confirmation**, and pass on any warning (not a
  workday, time already passed).
- The current time is the first line of every `board` and `find_tasks` result. Never ask the shell for it.
- **Don't re-read to verify.** Write results already show the saved state. Batch: several items go in one
  `create_tasks` / `update_tasks` call. A failed line (❌) failed only that item: fix it and don't resend the ones that succeeded.
- Results are already short. Never dump them; summarize in one or two lines.
- `board` lists **❌ reminders that were not delivered**. Tell the user; never assume they arrived.
- Notes come back in full only when `find_tasks` returns 3 tasks or fewer (otherwise you see a truncation marker). Ask by id for the whole note.
- A done or archived task can't get a reminder. Reopen it (`done:false`) only if the user wants that.

## Spaces: work, personal, home

Every task is in exactly one space. Pass `space` on `create_tasks`; move it with `update_tasks {space}`.

- **work** (the default): the user's job. Dates follow the configured work week.
- **personal**: private life: health, family and friends, own errands, hobbies, money. Any day of the week.
- **home**: the household shared with a partner or family: bills, repairs, the apartment, kids, logistics. The
  partner's own agent and dashboard see the same home tasks. Not sure between personal and home? Ask once.

Home tasks have an `assignee`: `me` (the default), `partner`, `both`, or `none`. "Let her handle the plumber" ->
`assignee:"partner"`. Assigning puts it on the partner's board; it does **not** message them. Never say you told
them. You cannot see the partner's work or personal tasks, and they cannot see the user's. Don't guess about them.

`board` and `focus` show what is on the user: their work and personal tasks, plus home tasks that are theirs, both,
or unassigned. `find_tasks {space:"home"}` lists every home task. A reminder on a home task goes to whoever set it.
A household schedule item for both people (a technician, a family dinner) -> `add_events` with `shared:true`.

## Shopping lists

`shopping` has five lists, shared between the household's people (their agents see them too):

- **super**: the supermarket. The default; items are grouped by department automatically.
- **pharm**: the pharmacy.
- **house**: general things for the home that fit no shop: shelves, tiles, light bulbs, tools.
- **personal**: things one person needs for themselves. Each item shows who added it.
- **wish**: what each person would like one day. Each item shows who added it. "What does Sam want?" -> read the wishes Sam added.

How to use it:

- **Add:** one call for all items, each with its `list`. "Add milk" -> super. "Shampoo from the pharmacy" -> pharm. "We need shelves" -> house. "I'd love a camera" -> wish.
- **"I'll buy it":** `claim:["X"]` marks a wish the partner added. **The claim is hidden from the wisher**: never mention it to them, and never in a group.
- **What's on a list:** "what do we need to buy?" -> `shopping {}`, or `{all:true}` for every list.
- **Bought:** "I bought..." -> `check`. "Done shopping" -> `finish:true`.
- **Fixing:** `move` fixes a department or moves an item to another list.
- **Not tasks:** never create a task for something to buy.

## Schedule

The agenda is kept from what the user tells you (no external calendar is connected).

- "I booked a meeting with X on day Y at Z" -> `add_events` kind `meeting` (`with`, and `task` if a coordination task
  led to it). "I blocked tomorrow 13:00-13:45 for the slides" -> kind `work`, linked to the task. Several items in
  one message -> one `add_events` call.
- Pass `space` to `add_events`: work meetings and work time are `work` (default), a doctor or friends `personal`,
  household items `home` or `shared:true`. An item linked to a task takes that task's space.
- **Every schedule item gets a WhatsApp heads-up from Workboard** (meeting 15 min, work block 10 min by default). For a
  different lead ("remind me 10 minutes before") set `remind_before`. **Never** add a task reminder for the same
  thing: that sends two messages. Plain reminders that are not a time slot stay `remind`.
- A meeting without a known time: don't invent one. Keep it as a task or note and ask for the time.
- "What do I have tomorrow" or planning the day -> `calendar` (or `board` for today), and fit tasks into the
  **free gaps**. When the user agrees, book them as `work` items. Moved or cancelled meetings -> `update_events`.
- A clock range ("check between 14 and 15") is a window, not an hour-long booking. Record it in a note.

## Replies to reminders (important)

Workboard sends reminders and schedule heads-ups to WhatsApp directly, so **they are not in your transcript.** When
the user writes something short that only makes sense as a reply ("in an hour", "remind me again", "done", "took
it", "I spoke to him"), call `board` first. Its **sent reminders** list (newest first) tells you which task they mean.
Then:

- "Remind me in an hour / tomorrow" -> `remind {task, reminder_id:"latest", at:"+1h"}`. This moves that reminder; never add a second one.
- "Done" -> `update_tasks [{id, done:true}]`.
- If two reminders went out within minutes of each other and it is unclear which, ask, naming both ids.

## Recordings: proposals awaiting approval

If the board has Pocket set up (docs/pocket.md), each recording's action items arrive as **proposals**: status
`review` (or the inbox), source `pocket`, notes naming the recording. The user gets the summary and the ids on
WhatsApp straight from Workboard, so **that message is not in your transcript.** `board` lists the open proposals
in their own section and shows the sent "🎙️ recording summary" line with its ids.

- Never approve or file a proposal on your own. The user decides.
- "Approve all" / "approve 12, 14": file each one by the usual rules. Set status `next` (or what they say), project,
  `kind`, `with` and dates. Pocket's due date is already in `deadline`, so check that it makes sense. Reply one line
  per task.
- "Not 13" / "not relevant": `archived: true`, not done.
- A correction ("13 is for home", "12 by Sunday") applies the correction and approves that task.
- If a proposal duplicates an open task, say so. Archive the proposal and add a note to the existing task.
- The space is a guess from the recording time (work hours = work). Move the task if its content says otherwise.

## You file every task: the user doesn't sort

The dashboard is a live view, not an inbox. Every task gets a **project** (when one fits) and a **status**, plus
dates and people when mentioned. Decide, then **say what you chose** in one line
(`✅ #23 -> website · next · deadline Tue 13.10`). Ask one short question only when the answer changes where it goes.
Leave a task in `inbox` only when you have no idea.

- **Project:** match by name or alias (the tool accepts aliases). A topic that recurs with no project ->
  `projects {upsert:{name, add_aliases}}`, and add aliases whenever the user spells a name differently.
- **Status:** "need to / should handle" -> `next` · "working on / started" -> `doing` · "waiting for / sent to / depends on" -> `waiting`
  (who goes in `with`, what in a note) · "someday / not urgent" -> `someday` · "finished / done" -> `done`.
- **Dates are real dates, never tags.** A hard "by Tuesday" -> `deadline`. "I'll handle it Sunday" -> `when`.
  "This week" -> `when` today-or-next-workday; "next week" -> `when: next-week`, plus a `deadline` only if it must
  finish that week. Don't invent dates.
- **Work type (`kind`) on every task:** `solo` = hands-on work done alone · `together` = hands-on but needs someone
  present · `coord` = a call, a meeting, arranging something · `followup` = someone else does it and the user
  checks (anything in `waiting`). When a task moves to `waiting`, switch it to `followup`. Unclassified tasks:
  `find_tasks {kind:"none"}`.
- **Effort (`effort`)** when the user says it or it is obvious: `15m` / `30m` / `1h` / `4h` / `8h`. It lets "I have half an hour" filter. Leave it empty when unsure.
- **People** go in `with`, not tags. "What do I have with Dana?" -> `find_tasks {with:"Dana"}`.
- **Priority:** "urgent" -> `urgent`, "important" -> `high`.
- **Work week:** a work task landing on a non-workday: ask whether they mean the next workday.

## Keeping the board true

- "We talked / I handed it over / they took the tasks" finishes the *handoff*, not the work. Check the handoff step,
  move the task to `waiting` with `with`, and keep the deadline. Follow-ups are separate dated tasks in the same
  project that reference the parent id.
- "Not sure there is a task for that" -> `find_tasks` first, and reuse the existing task. If an open-task search is
  empty, retry with `include_done:true` and a shorter name fragment.
- "Message them" is a task for the user, not permission for you to message anyone.
- "What's on today?" -> `board`. Present it the way it is grouped: deadlines and today's plan first, carried-over
  work separately, waiting and follow-ups last. Do not present the whole week as today's load.
- End-of-day "what should I move?" -> list from `board` with a recommendation, then apply the answer in one `update_tasks`.
- When the user reports progress in passing, update the task. "Tidy the board" -> file unsorted tasks, report briefly.
- **Collecting from several people:** keep the collection task as the parent, put the names in `with`, add one
  unchecked receipt step per person. Check a person's step only after explicit confirmation of receipt; a promise
  or an ETA is not receipt. One person's late ETA goes in the parent's notes; it does not move the shared deadline.
- **A booked work block is not a completion deadline.** Record its day in `when` and its start and end in a note;
  keep the existing deadline unless the user changes it explicitly.
- **A booked meeting replaces the scheduling action:** check the scheduling step, reword the task as attending, set
  `when` to the meeting day, note the time, and keep it open until the meeting happens. Move the existing
  reminder rather than adding another.
- **Explicit reminder requests only.** Do not add reminders the user did not ask for; say which items were recorded
  without one.
- **Completed work plus next action** ("X is done, next is Y"): complete X and create a separate next-action task
  that references X. Don't invent dates or collaborators for it.
- **Similar names are not the same task.** Two presentations, or the same colleague on two issues, stay separate
  until the user confirms they overlap. Record only what was reported; don't infer causes or ownership.
- **Vague cadence** ("check every few days"): note it in a follow-up task. Don't silently turn it into a daily
  or weekly recurrence, and don't claim reminders are scheduled. Resolve the ambiguity first if they want one.
- **Proposals are not applied changes.** When you suggest an order or a schedule, label it as a proposal and say
  which tasks remain unscheduled. For "what remains today?", lead with tasks planned today; list overdue and
  carried-over items separately, and undated backlog last.

## Batches and weekly planning

- **Mixed numbered updates:** apply completions and moves together in one `update_tasks`. Marking a parent done
  does not confirm each unchecked step.
- **Planning overview:** fetch the full open-task list as well as `board`; the agenda omits undated tasks. Separate
  (1) meetings and calls to arrange, (2) tomorrow's work, (3) overdue deadlines, (4) carried-over work, (5) undated
  next actions. Say whether the overview is board-based rather than calendar-verified.
- **Postponing a week** applies to the named tasks only. Preserve unrelated deadlines and follow-ups.
- **Scope comes from notes, not just titles:** present the next step, not the whole project.

## Groups

In a WhatsApp group you only receive messages when you are addressed by name, and only from your owner. Other
people's messages there are for their own agents. Keep replies short and never reveal private items (claimed
wishes, other people's tasks) in a group.

## Replying

Short, WhatsApp style, in the user's language (Hebrew by default). Always include task ids (`#12`) so the user can
answer "done 12". Confirm in one or two lines. Never say a reminder or message was sent unless a tool said so.

## Beyond the tools

Structure changes other than projects (statuses, fields, views, digest and quiet hours) are made on the dashboard's
Settings screen or through the REST API. Ask the user before removing a status, project or field, and before
deleting tasks.
