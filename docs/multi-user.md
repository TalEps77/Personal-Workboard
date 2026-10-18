# Multi-user model

Workboard is a single-person board by default. Add `data/people.json` and the same instance serves a household: each person has private spaces, the household shares one, and every request is narrowed to what that person may see. This is a convenience boundary for people who trust each other, not a multi-tenant system (see [security.md](security.md)).

## Concepts

| Concept | Meaning |
|---|---|
| **Person** (`users[]`) | Someone with devices, an optional agent, and a webhook for messages. |
| **Space** (`spaces[]`) | A bucket of tasks. Every task lives in exactly one space (`space` in its file; none means `defaultSpace`). |
| **Kind** | `work`, `personal` or `home`. Drives colour, tabs and the automatic context. |
| **Owner** | A space with an `owner` is private to that person. |
| **Members** | A space with `members` and no owner is shared by them (the household's `home`). |
| **Default user / space** | Where credentials, tasks and history that predate multi-user belong. The default user alone sees and undoes structure changes. |

A caller is a **paired device** (cookie), a **person's agent token** or a **service token**. Devices and agent tokens belong to one person. Service tokens (`WORKBOARD_SERVICE_TOKENS`) have no person and see everything; give them only to tools you run yourself.

## Visibility rules

A thing outside your scope behaves exactly like a thing that does not exist (`404`, absent from lists, never pushed over the live stream).

| Data | Who sees it |
|---|---|
| Tasks | Members of the task's space. A private space is visible to its owner only. |
| Activity (history and undo) | Entries about tasks in your spaces. Schedule entries: the item's owner (shared items: members of home). |
| Structure-change history (statuses, fields, views, notification settings) | The default user only. Only they can undo such an entry, because an entry carries the whole `board.json`, including every person's project names. |
| Board structure itself (statuses, priorities, fields, views, notification rules) | Shared by everyone, and anyone can edit it. |
| Projects | Each belongs to a space (`project.space`, default space if unset). You see and edit only projects of your own spaces. You cannot take over a hidden project's id. |
| Schedule | Your own items, plus shared items (`owner: "home"`) if you are in a home space. |
| Live stream (SSE) | Each stream is filtered by the same rules: task and activity events only for people who can see them, notification events only to their recipient, shopping events only to the household. Revoking a device closes its stream at once. |
| Shopping lists | Household-wide: everyone who is a member of a `home` space sees and edits all lists (supermarket, pharmacy, house, personal, wish). Items show who added them on the personal and wish lists. A wish can be quietly claimed by someone else ("I'll buy it"); the person who made the wish never sees the claim. |
| Reminder delivery log | Messages that were sent to you. |
| Devices | You list and revoke only your own. |

A person with no home space sees no shopping lists.

## Assignee on shared tasks

A task in a shared space can carry `assignee`: a person id, or `both`.

- A new task created by a person in a shared space is assigned to them unless they say otherwise.
- **"Mine to do"** drives Today, the digest and `/api/summary`:
  - every task in your own (owned) spaces is yours;
  - a task in a shared space is yours if it is assigned to you, to `both`, or to nobody yet.
- Assigning a shared task to the other person removes it from your "mine" lists, but you can still see and edit it (you are a member).
- Assignee names are validated against `people.json` (`both` is always valid).

## Who gets a reminder

`recipientsOfReminder(task, reminder)` in `server/access.js`:

1. If the reminder has `to` (a person id), that person.
2. Else if the task's space has an owner, the owner.
3. Else if the task has an assignee other than `both`, the assignee.
4. Else every member of the space.

A reminder created by a person on a **shared** task is stamped `to: <that person>` automatically, so "remind me" reaches the one who asked, not the whole household, unless they name someone.

`recipientsOfEvent(event)`: a shared schedule item (`owner: "home"`) goes to every member of every home space; otherwise to the item's owner. The morning digest is one message per person: their "mine" tasks plus their own schedule for the day.

Delivery uses each person's own webhook (`WORKBOARD_WEBHOOK_*` for the default user, `WORKBOARD_WEBHOOKS` for the others). A person without a webhook gets no messages (the failure is logged and retried). If several people receive one reminder, it counts as delivered when at least one delivery succeeded.

## Contexts in the UI

A context is a mode of the whole app, like a phone's Focus: it filters every screen, colours the interface and picks the fourth tab (shopping at home and in personal context).

| Choice | Behaviour |
|---|---|
| **Automatic** (default) | Your work space during work days and work hours (`WORKBOARD_WORKWEEK`, `WORKBOARD_WORK_HOURS`), otherwise everything ("all"). |
| **All** | Every space you can see. |
| A specific space | Only that space. |

The choice is per device. The context chip in the header shows the current one, marked "auto" when automatic. Colour follows the space kind (work, personal, home), so you always know where you are. With only one person and one space, everything is "all" and there is nothing to choose.

## Per-person agents and pairing

- Each person has their own agent token (`WORKBOARD_AGENT_TOKENS=person:actor:token`) and their own webhook. The agent sees and changes only that person's scope. MCP tool descriptions use the person's name.
- The activity log shows the actor: `dashboard` for the default user's devices, `dashboard-<id>` for another person's devices, and the token's actor name (for example `hermes`, `nova`) for agents.
- **Pairing** is per person. With several people the pairing screen first asks "who is using this device?" (names only), then sends a 6-digit code to *that person's* webhook. Only someone who receives that person's messages can pair a device as them. The choice is remembered on the device.
- A device keeps the identity it was paired with. To switch, revoke it in Settings and pair again.

## Grammatical gender

Hebrew addresses people by gender. The interface copy is written in the masculine/neutral form; for a user with `"gender": "f"` a tagged template (`gx`) turns imperatives and "you" forms feminine. Only the literal interface text changes, never task titles or list items. Set `gender` per user in `people.json` (`m` is the default).

## Worked example: a household of two

`examples/people.json`:

| Space | Kind | Visible to | Typical content |
|---|---|---|---|
| `work` | work | alex | Alex's job tasks |
| `alex-life` | personal | alex | Alex's private errands |
| `home` | home | alex, sam | Groceries, repairs, bills, shared plans |
| `sam-work` | work | sam | Sam's job tasks |
| `sam-life` | personal | sam | Sam's private errands |

Walk-through:

1. Alex tells his agent "add 'fix the leaking tap' for the house, remind me Saturday at 9". The task is created in `home`, assigned to `alex` (the creator), with a reminder stamped `to: alex`.
2. Sam sees it in `home` and on the live stream immediately. It is not in Sam's "mine" list because it is assigned to Alex. Sam can still open it, edit it, or reassign it to `both`.
3. At 9:00 Saturday only Alex's webhook receives the reminder.
4. Sam asks her agent "what do I have today?". She gets her own work and personal tasks, home tasks assigned to her, to both, or to nobody, and her schedule. Nothing from `work` or `alex-life`.
5. Both add to the supermarket list; it is one shared list, ordered by department.
6. Only Alex (the default user) can see or undo "structure" entries in the history, such as adding a status.

## From one person to two

Single-user data keeps working: tasks without a `space` belong to `defaultSpace`, schedule items and devices from before belong to `defaultUser`.

1. **Keep the first person's id.** A single-user board names that person `me`. Schedule items, shopping items and history entries record `me`. Either keep `"id": "me"` for them, or rewrite those values in `events.json`, `shopping.json` and `runtime/activity.jsonl` before renaming. Set `name` to their real name.
2. Copy `examples/people.json` to `data/people.json` and edit it: the first user (`me`), the new user, and the spaces. Keep a space whose id is `work` (the old default) owned by the first user, or point `defaultSpace` at the one that should hold the old tasks.
3. Set `defaultUser` to the first person and `defaultSpace` to their work space.
4. Add the second person's agent token and webhook to `.env`:
   ```
   WORKBOARD_AGENT_TOKENS=sam:nova:<secret>
   WORKBOARD_WEBHOOKS=sam|http://agent-sam:8644/webhooks/workboard|<secret>
   ```
   The first person's existing `WORKBOARD_AGENT_TOKEN` and `WORKBOARD_WEBHOOK_*` stay as they are.
5. Restart the container (`people.json` and the environment are read at start-up). The server refuses to start on an invalid `people.json` and says why.
6. Move tasks that should be shared: `PATCH /api/tasks/<id>` with `{"space": "home"}`, or change the space in the app. Existing devices stay paired as the default user. The second person opens the app on their own device, taps their name and enters the code sent to their webhook.
7. Optionally move projects: set `space` on each project in Settings or `board.json`.
