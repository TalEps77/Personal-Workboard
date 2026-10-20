# Changelog

## Unreleased

- Pocket recorder intake (`WORKBOARD_POCKET`, `POST /hooks/pocket/<person>`): action items from a recording's summary
  become proposals in the `review` status and the summary goes to WhatsApp. `board` lists the proposals separately so
  the agent waits for approval. Signed and exactly-once, and the transcript is never stored. See docs/pocket.md.
- Requests that arrive through Tailscale Funnel can reach only `/hooks/*`.
- Optional team-board link (`WORKBOARD_ORG_URL` + per-person sync tokens): tasks you are responsible for or review on a
  team board are mirrored into your work space and edits go back; a deadline move carries a reason; a personal task
  can be put on the team board. See docs/team-board.md.
- `update_tasks` takes `reason` (for team-board deadlines) and `expose_to_org`.

## 1.0.0 — first public release

- Spaces: work, personal and a shared home space; people with their own agents and devices; server-side scoping
  of tasks, schedule, activity, projects and the live stream.
- Contexts in the UI (automatic by work hours), with per-context colour, tabs and Today.
- Schedule with WhatsApp heads-ups, coloured by space; free-gap finder for agents.
- Shopping: supermarket (by department, learned), pharmacy, house, personal and wish lists; store mode; swipe
  actions; quiet "I'll buy this" claims on wishes.
- 13 MCP tools with server-side Hebrew/English date resolution, batch writes and undo.
- Two-step device pairing by WhatsApp code; per-person grammatical gender in the UI.
- Configurable time zone, work week and work hours; agent-agnostic token and webhook configuration.
- Safe self-hosted update pipeline (fast-forward + green CI + local tests + health check + rollback);
  open apps update themselves.
