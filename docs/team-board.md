# Team board link

Optional. A team board (a Workboard server for a whole unit, with responsible/reviewer roles and approvals along the org
chart) can be linked to each person's **work space** here. Configuration: [configuration.md › Team board](configuration.md#team-board-optional).

## What happens

| On the team board | Here |
|---|---|
| A task you are **responsible** for or **review** (or chose to mirror) | appears in your work space, marked **ארגוני** |
| It changes (status, title, description, due date) | the change lands here — the team board is the source of truth |
| It is reassigned away from you | the copy here is archived, marked "no longer yours" |
| Waiting for your acceptance | sits in the inbox, marked "ממתין לאישורך"; accept or reject on the team board or through your agent |

| Here | On the team board |
|---|---|
| You change status, title, notes or the deadline of a team task | the change is sent back (status by category: done → done, waiting → blocked, other active → doing, the rest → open) |
| The team board refuses it (no permission; a due date moved without a reason) | the value here is put back, and the activity log says why |
| You move a team task's deadline | the dashboard asks for the reason; the agent passes `reason` in `update_tasks` |
| "העלאה ללוח הצוות" on a personal work task (or `expose_to_org` in `update_tasks`) | it becomes a team task (one way), linked to this one |

Personal tasks, other spaces, steps, reminders and tags never leave this board. The token stays on the server; the
browser never sees it. Changes from the team board arrive within `WORKBOARD_ORG_POLL_SECONDS`.

## The link in a task file

```yaml
org: {"id":12,"user":"me","url":"https://team-board.example/#/t/12","role":"responsible","status":"doing","rev":4,"responsible":"…","reviewer":"…","slips":1,"snap":{…}}
```

`snap` is the last synced state; a field that differs from it changed on one side since then. Deleting the `org` line
unlinks the task (it becomes an ordinary personal task).
