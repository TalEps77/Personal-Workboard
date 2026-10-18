// The board's own automation loop: fires due reminders (one-off, repeating, "nag until done")
// and the optional morning digest. Lives inside the app — no cron, no Hermes scheduling.
import { join } from 'node:path';
import { readFile, rename, stat } from 'node:fs/promises';
import { appendLine, readLines, writeAtomic } from './fs-util.js';
import { categoryOf, digestText, reminderText } from './summary.js';
import { inQuietHours, local, nextOccurrence, quietEnd } from './time.js';
import { endMs, eventWhen, leadOf, remindMs, startMs } from './events.js';

const RETRY_MS = 2 * 60_000;
const LATE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 8;
const GIVE_UP_MS = 24 * 3600_000;
const CONCURRENCY = 3;
const LOG_MAX_BYTES = 1_000_000;

const isDue = (r, now) => !r.done && (Number.isNaN(Date.parse(r.at)) || (Date.parse(r.at) <= now.getTime() && !(r.retry_at && Date.parse(r.retry_at) > now.getTime())));

export function createScheduler({ root, taskStore, schemaStore, eventStore = null, notifier, access = null, onEvent = () => {}, interval = 20_000 }) {
  const defaultUser = access?.people.defaultUser || 'me';
  const reminderTo = (task, r) => (access ? access.recipientsOfReminder(task, r) : [defaultUser]);
  const eventTo = (e) => (access ? access.recipientsOfEvent(e) : [defaultUser]);
  const configuredFor = (user) => (notifier.configuredFor ? notifier.configuredFor(user) : notifier.configured);
  const runtime = join(root, 'data', 'runtime');
  const statePath = join(runtime, 'scheduler.json');
  const logPath = join(runtime, 'notifications.jsonl');
  let running = false;
  let timer = null;

  const readState = async () => { try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return {}; } };

  async function deliver(message, meta) {
    try { if ((await stat(logPath)).size > LOG_MAX_BYTES) await rename(logPath, `${logPath}.1`); } catch { /* no log yet */ }
    const record = { at: new Date().toISOString(), ...meta, message: message.slice(0, 400) };
    try {
      await notifier.send(message, meta);
      await appendLine(logPath, { ...record, ok: true });
      onEvent({ type: 'notification', ok: true, ...meta });
      return { ok: true };
    } catch (error) {
      await appendLine(logPath, { ...record, ok: false, error: error.message });
      onEvent({ type: 'notification', ok: false, error: error.message, ...meta });
      return { ok: false, error: error.message, definite: Boolean(error.definite) };
    }
  }

  /** Sends to several people (a shared task for both of us); ok when it reached at least one of them. */
  async function deliverAll(recipients, build) {
    let last = { ok: false, error: 'no recipient' };
    let any = false;
    for (const to of recipients) {
      const result = await deliver(...build(to));
      if (result.ok) any = true; else last = result;
    }
    return any ? { ok: true } : last;
  }

  /** Bookkeeping for after a successful send; computed BEFORE sending so a bad reminder can't loop. */
  function afterSend(r, now) {
    const patch = { sent_count: (r.sent_count || 0) + 1, last_sent_at: now.toISOString(), last_error: null, retry_at: null, attempts: 0 };
    if (r.nag) patch.at = new Date(now.getTime() + r.nag * 60_000).toISOString();
    else if (r.repeat) patch.at = nextOccurrence(r.at, r.repeat, now, r.anchor);
    else patch.done = true;
    return patch;
  }

  async function fireOne(task, r, now, schema) {
    // Compare-and-set guard: skip our bookkeeping if the reminder was edited while we were delivering.
    const expect = { at: r.at, done: r.done, repeat: r.repeat, nag: r.nag, anchor: r.anchor };
    if (Number.isNaN(Date.parse(r.at))) {
      await taskStore.markReminder(task.id, r.id, { done: true, last_error: `זמן לא תקין: ${r.at}` }, expect);
      return;
    }
    if (categoryOf(schema, task.status) === 'done') { await taskStore.markReminder(task.id, r.id, { done: true }, expect); return; }
    // Follow-up nags wait for the morning; an explicit reminder time is always honoured.
    if (r.nag && r.sent_count > 0 && inQuietHours(schema.notifications.quietHours, now)) {
      await taskStore.markReminder(task.id, r.id, { at: quietEnd(schema.notifications.quietHours, now) }, expect);
      return;
    }
    let patch;
    try { patch = afterSend(r, now); } catch (error) {
      await taskStore.markReminder(task.id, r.id, { done: true, last_error: `לא ניתן לחשב חזרה: ${error.message}` }, expect);
      return;
    }
    const late = now.getTime() - Date.parse(r.at) > LATE_MS;
    // Stable per occurrence (+ number of definite rejections): a crash or timeout followed by a retry reuses the
    // id, and the agent's webhook drops the duplicate instead of messaging the person twice.
    const requestId = `wb-${task.id}-${r.id}-${Date.parse(r.at)}-${r.fail_seq || 0}`;
    const result = await deliverAll(reminderTo(task, r), (to) => [reminderText(task, r, schema, { late, now }), { event_type: 'workboard.reminder', task: task.id, reminder: r.id, title: task.title, to, request_id: to === defaultUser ? requestId : `${requestId}-${to}` }]);
    if (result.ok) {
      await taskStore.markReminder(task.id, r.id, { ...patch, fail_seq: 0 }, expect);
      return;
    }
    const attempts = (r.attempts || 0) + 1;
    const giveUp = attempts >= MAX_ATTEMPTS || now.getTime() - Date.parse(r.at) > GIVE_UP_MS;
    if (giveUp) {
      // Terminal: shown in red on the dashboard; a repeating reminder moves on to its next occurrence.
      const next = r.repeat ? { at: patch.at, done: false, attempts: 0, retry_at: null } : { done: true };
      await taskStore.markReminder(task.id, r.id, { ...next, delivery_failed: true, last_error: `לא נמסר אחרי ${attempts} ניסיונות: ${result.error}` }, expect);
      return;
    }
    // Exponential backoff: 2, 4, 8 … minutes, capped at an hour.
    const wait = Math.min(RETRY_MS * 2 ** (attempts - 1), 60 * 60_000);
    await taskStore.markReminder(task.id, r.id, { last_error: result.error, attempts, fail_seq: (r.fail_seq || 0) + (result.definite ? 1 : 0), retry_at: new Date(now.getTime() + wait).toISOString() }, expect);
  }

  async function fireReminders(now, schema) {
    const due = [];
    for (const task of await taskStore.list()) for (const r of task.reminders) if (isDue(r, now)) due.push({ task, r });
    // A few deliveries in parallel, so one slow webhook call doesn't hold up everything behind it.
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const { task, r } = due[next++];
        // One broken reminder must never block the others.
        try {
          // Re-read right before sending: while this entry waited in the queue the task may have been snoozed,
          // completed, archived or deleted — never deliver from the stale snapshot.
          const fresh = await taskStore.get(task.id).catch(() => null);
          const fr = fresh?.reminders.find((x) => x.id === r.id);
          const current = await schemaStore.get();
          if (!fresh || !fr || fresh.archived || !current.notifications.enabled || !isDue(fr, now)) continue;
          await fireOne(fresh, fr, now, current);
        } catch (error) { console.error(`[scheduler] task ${task.id} reminder ${r.id}:`, error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  }

  /** Schedule heads-up: "בעוד 10 דק׳: …" before each item; explicit times, so quiet hours don't apply. */
  async function fireEvents(now, schema) {
    if (!eventStore) return;
    for (const e of await eventStore.list({ from: local(new Date(now.getTime() - 86400_000)).date })) {
      const at = remindMs(e);
      if (at === null || e.reminded_at || at > now.getTime()) continue;
      if (e.retry_at && Date.parse(e.retry_at) > now.getTime()) continue;
      const expect = { date: e.date, start: e.start, remind: e.remind };
      // Past the start by more than 10 minutes (server was down): a late "starts soon" is noise — record and skip.
      if (now.getTime() > startMs(e) + 10 * 60_000) { await eventStore.mark(e.id, { reminded_at: now.toISOString(), remind_error: 'missed: the item had already started' }, expect); continue; }
      const task = e.task ? await taskStore.get(e.task).catch(() => null) : null;
      const mins = Math.max(0, Math.round((startMs(e) - now.getTime()) / 60_000));
      const nextStep = task?.steps.find((x) => !x.done)?.text;
      const text = [
        `${e.kind === 'work' ? '🎯' : '📅'} *${mins ? `בעוד ${mins} דק׳` : 'עכשיו'}: ${e.title}*`,
        `🕐 ${eventWhen(e)}${e.location ? ` · 📍 ${e.location}` : ''}`,
        e.with ? `👥 ${e.with}` : null,
        task ? `📌 משימה #${task.id}: ${task.title}${nextStep ? ` — הצעד הבא: ${nextStep}` : ''}` : null,
        e.notes ? `📝 ${e.notes.slice(0, 200)}` : null,
        task && schema.publicUrl ? `🔗 ${schema.publicUrl}/#/task/${task.id}` : null,
      ].filter(Boolean).join('\n');
      const rid = `wb-ev-${e.id}-${startMs(e)}-${leadOf(e)}`;
      const result = await deliverAll(eventTo(e), (to) => [text, { event_type: 'workboard.event', event: e.id, task: e.task, title: e.title, to, request_id: to === defaultUser ? rid : `${rid}-${to}` }]);
      if (result.ok) await eventStore.mark(e.id, { reminded_at: now.toISOString(), remind_error: null, retry_at: null }, expect);
      else {
        const attempts = (e.attempts || 0) + 1;
        const giveUp = now.getTime() > endMs(e);
        await eventStore.mark(e.id, giveUp ? { reminded_at: now.toISOString(), remind_error: `לא נמסר: ${result.error}` } : { attempts, remind_error: result.error, retry_at: new Date(now.getTime() + RETRY_MS).toISOString() }, expect);
      }
    }
  }

  async function maybeDigest(now, schema) {
    const d = schema.notifications.digest;
    if (!d.enabled) return;
    const l = local(now);
    if (!d.days.includes(l.dow) || l.time < d.time) return;
    // One digest per person, each with what is theirs (their spaces + shared tasks on them) and their schedule.
    const people = access ? access.users.map((u) => u.id) : [defaultUser];
    for (const user of people) {
      if (!configuredFor(user)) continue;
      const key = user === defaultUser ? '' : `:${user}`;
      const state = await readState();
      if (state[`lastDigest${key}`] === l.date) continue;
      if (state[`digestRetryAt${key}`] && Date.parse(state[`digestRetryAt${key}`]) > now.getTime()) continue;
      // Don't send a stale digest if the server was down (or Hermes unreachable) all morning.
      const [h, m] = d.time.split(':').map(Number);
      if (l.hh * 60 + l.mm - (h * 60 + m) > 180) { await writeAtomic(statePath, JSON.stringify({ ...state, [`lastDigest${key}`]: l.date, [`digestRetryAt${key}`]: null })); continue; }
      const sc = access?.scope(user);
      const tasks = (await taskStore.list()).filter((t) => !sc || sc.isMine(t));
      const events = eventStore ? (await eventStore.list({ from: l.date, to: l.date })).filter((e) => !sc || sc.canSeeEvent(e)) : [];
      const result = await deliver(digestText(tasks, schema, now, events, { spaces: access && sc ? sc.spaces : null, defaultSpace: access?.people.defaultSpace }), { event_type: 'workboard.digest', to: user, request_id: `wb-digest-${l.date}${key}-${now.getTime()}` });
      const fresh = await readState();
      await writeAtomic(statePath, JSON.stringify(result.ok ? { ...fresh, [`lastDigest${key}`]: l.date, [`digestRetryAt${key}`]: null } : { ...fresh, [`digestRetryAt${key}`]: new Date(now.getTime() + 10 * 60_000).toISOString() }));
    }
  }

  async function tick(now = new Date()) {
    if (running) return;
    running = true;
    try {
      const schema = await schemaStore.get();
      if (!schema.notifications.enabled) return;
      await fireReminders(now, schema);
      await fireEvents(now, schema);
      await maybeDigest(now, schema);
    } catch (error) {
      console.error('[scheduler]', error);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    deliver,
    start() { timer = setInterval(() => tick(), interval); timer.unref?.(); setTimeout(() => tick(), 3000).unref?.(); },
    stop() { clearInterval(timer); },
    /** Sent messages, newest first; with `user`, only the ones that went to that person. */
    async log(limit = 20, user = undefined) { return (await readLines(logPath)).filter((e) => user === undefined || user === null || (e.to || defaultUser) === user).slice(-limit).reverse(); },
    status: (user) => ({ configured: user === undefined ? notifier.configured : configuredFor(user) }),
  };
}
