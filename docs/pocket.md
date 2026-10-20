# Pocket recorder: meeting action items as proposals

[Pocket](https://heypocketai.com) is an AI voice recorder. When a recording's summary is ready, Pocket can POST a
signed webhook. Workboard turns its **action items into proposals**, one task each, and sends the person one WhatsApp
message through their agent with the summary and the task ids. Nothing counts as filed until the person approves:
their agent sees the proposals in `board` (a separate "awaiting approval" section) and files or archives them from
the reply.

- **Status:** a status with id `review` and category `inbox` (e.g. label "לאישור") if the board has one. Otherwise
  the first inbox status. Add it in Settings → Statuses.
- **Source:** `pocket`, shown as a pill in the task drawer. The notes say which recording the task came from and who
  the recording named as responsible.
- **Space:** a recording made in work hours on a work day goes to the person's work space. Otherwise it goes to
  their personal space. The agent moves it if the content says otherwise.
- **Deadline / priority:** taken from Pocket when it has them.
- **Exactly once:** Pocket delivers at least once, so every action item is remembered per recording in
  `data/pocket.json`. Retries, and `summary.regenerated` / `action_items.regenerated`, only add items that are new.
  Items already completed in Pocket are skipped.
- **`recording.deleted`:** proposals from that recording that were never approved are archived.
- **Privacy:** the transcript is never stored or forwarded. The last payload without the transcript is kept in
  `data/runtime/pocket-last.json` for troubleshooting, because Pocket doesn't document the inside of a summary.

## Two ways in: webhook and polling

Both are optional, and they can run together because they share the same ledger, so nothing is filed twice.

- **Webhook** (`WORKBOARD_POCKET`): instant, but Workboard needs a public URL (below).
- **Polling** (`WORKBOARD_POCKET_API_KEYS`): no public URL needed. Every `WORKBOARD_POCKET_POLL_MINUTES` (10)
  Workboard lists the last three days of recordings and reads any that are new or changed, without their
  transcripts. **The first run imports the whole history**, or the last `WORKBOARD_POCKET_BACKFILL_DAYS`. It does
  this quietly: one message gives the totals, instead of one per recording. Later runs send the usual message per
  recording. A recording whose summary is still being processed is picked up once it is ready. The state (and the
  last error) is in `data/pocket.json` under `poll`.

## Setup (webhook)

1. Workboard must be reachable from the internet at `/hooks/pocket/<person>` **only**. With Tailscale:

   ```bash
   sudo tailscale funnel --bg --https=8443 --set-path=/hooks/pocket http://127.0.0.1:3000/hooks/pocket
   ```

   Requests that arrive through Funnel carry `Tailscale-Funnel-Request`, and Workboard answers them on `/hooks/*`
   only. Add the Funnel host name to `WORKBOARD_HOSTS` if it isn't there yet.
2. In the Pocket app → Integrations → Webhooks, add `https://<host>:8443/hooks/pocket/<person>` and choose the events
   `summary.completed`, `summary.regenerated`, `action_items.regenerated` and `recording.deleted`. Copy the signing
   secret. Pocket shows it once.
3. Set `WORKBOARD_POCKET=<person>|<secret>` (comma-separate one entry per person) and restart.
4. Make a short recording. The message arrives once Pocket finishes the summary.

Signature check: `X-HeyPocket-Signature` must be the hex HMAC-SHA256 of `<X-HeyPocket-Timestamp>.<raw body>`, and
the timestamp must be within 15 minutes. Unsigned deliveries are refused, so recreate an old webhook that has no
secret.
