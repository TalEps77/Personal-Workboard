// Pocket (heypocketai.com, an AI voice recorder) → proposed tasks.
// When a recording's summary is ready Pocket POSTs a signed webhook. Its action items become tasks in the
// "awaiting approval" status (the `review` status if the board has one, else the inbox) with source "pocket", and the
// person gets one WhatsApp message with the summary and the new task ids. Nothing is filed for real until the person
// approves — their agent does that from the reply (the `board` tool lists these proposals separately).
//
// Config: WORKBOARD_POCKET="person|secret,…" — the signing secret Pocket shows once when you create a webhook in the
// Pocket app. Webhook URL: POST <public url>/hooks/pocket/<person>. The transcript is never stored.
// Signature (Pocket docs): X-HeyPocket-Signature = hex HMAC-SHA256(secret, `${X-HeyPocket-Timestamp}.${rawBody}`).
// Delivery is at-least-once, so every action item is remembered per recording (data/pocket.json) and never filed twice.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLock, writeAtomic } from './fs-util.js';
import { WORKDAYS, WORK_HOURS } from './locale.js';
import { heDate, heDateTime, local } from './time.js';

export const POCKET_SOURCE = 'pocket';
export const POCKET_MAX_BODY = 8_000_000; // payloads carry the full transcript (a 3-hour meeting is well under 1 MB)
const WINDOW_MS = 15 * 60_000; // accepted clock skew / replay window for the signed timestamp
const KEEP_RECORDINGS = 1000;
const INGEST = new Set(['summary.completed', 'summary.regenerated', 'action_items.regenerated']);

export function parsePocketSpec(spec = '') {
  const map = new Map();
  for (const part of String(spec).split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('|');
    const user = part.slice(0, i).trim();
    const secret = part.slice(i + 1).trim();
    if (i > 0 && secret) map.set(user, secret);
  }
  return map;
}

export function verifyPocket(secret, raw, headers, now = Date.now()) {
  const sig = String(headers['x-heypocket-signature'] || '').trim().replace(/^sha256=/i, '').toLowerCase();
  const ts = String(headers['x-heypocket-timestamp'] || '').trim();
  if (!secret || !/^[0-9a-f]{64}$/.test(sig) || !/^\d{10,16}$/.test(ts)) return false;
  const ms = ts.length <= 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(now - ms) > WINDOW_MS) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.`).update(raw).digest();
  return timingSafeEqual(Buffer.from(sig, 'hex'), expected);
}

// Pocket documents the envelope but not the inside of a summary, so read it tolerantly.
const text = (v, depth = 0) => {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v) && depth < 2) return v.map((x) => text(x, depth + 1)).filter(Boolean).join('\n');
  if (v && typeof v === 'object' && depth < 2) for (const k of ['text', 'markdown', 'content', 'value', 'summary', 'title']) { const t = text(v[k], depth + 1); if (t) return t; }
  return '';
};
const first = (...vs) => { for (const v of vs) { const t = text(v); if (t) return t; } return ''; };
const firstArray = (...vs) => vs.find((v) => Array.isArray(v)) || [];
const norm = (s) => s.toLowerCase().replace(/[\s"'״׳.,!?:;()-]+/g, ' ').trim();

function toDate(v) {
  const s = text(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : local(t).date;
}

function normalizeItem(x) {
  if (typeof x === 'string') x = { title: x };
  if (!x || typeof x !== 'object') return null;
  // Pocket's real items repeat most fields under `metadata` (and keep some only there, e.g. dueDate, context).
  if (x.metadata && typeof x.metadata === 'object') x = { ...x.metadata, ...Object.fromEntries(Object.entries(x).filter(([, v]) => v !== null && v !== undefined && v !== '')) };
  const title = first(x.title, x.text, x.task, x.label, x.action, x.content, x.name, x.description).replace(/\s+/g, ' ').slice(0, 200);
  if (!title) return null;
  const context = first(x.context, x.details, x.description, x.notes);
  const status = String(x.status || '').toLowerCase();
  return {
    key: x.id ? `id:${x.id}` : `t:${createHash('sha1').update(norm(title)).digest('hex').slice(0, 12)}`,
    title,
    done: x.completed === true || x.done === true || x.isCompleted === true || x.is_completed === true || ['done', 'completed', 'complete', 'closed'].includes(status),
    due: toDate(x.dueDate ?? x.due_date ?? x.due ?? x.deadline),
    priority: String(x.priority || '').toLowerCase() || null,
    assignee: ((a) => (/^(me|self|i|אני)$/i.test(a) ? '' : a))(first(x.assignee, x.owner, x.assignedTo, x.assigned_to)), // "me" = the recorder's owner
    context: context && norm(context) !== norm(title) ? context.slice(0, 600) : '',
  };
}

/** The parts of a Pocket payload we use: the recording, the latest summary text and its action items. */
export function extractPocket(payload = {}) {
  const rec = payload.recording || {};
  const raw = payload.summarizations || {};
  const all = (Array.isArray(raw) ? raw : Object.entries(raw).map(([id, s]) => ({ id, ...s }))).filter((s) => s && typeof s === 'object');
  const finished = all.filter((s) => !s.processingStatus || /^(completed|complete|done|success)/i.test(s.processingStatus));
  const stamp = (s) => Date.parse(s.updatedAt || s.completedAt || s.createdAt || 0) || 0;
  const latest = (finished.length ? finished : all).sort((a, b) => stamp(b) - stamp(a))[0] || {};
  const v2 = latest.v2 && typeof latest.v2 === 'object' ? latest.v2 : latest;
  const items = firstArray(v2.actionItems, v2.action_items, v2.actions, v2.tasks, v2.summary?.actionItems, v2.summary?.action_items, latest.actionItems, payload.actionItems, payload.action_items)
    .map(normalizeItem).filter(Boolean);
  const seen = new Set();
  return {
    id: rec.id ? String(rec.id) : null,
    title: first(rec.title, v2.title, latest.title) || 'הקלטה',
    at: rec.recordingAt || rec.createdAt || null,
    minutes: Number.isFinite(rec.duration) ? Math.max(1, Math.round(rec.duration / 60)) : null,
    summary: first(v2.summary, v2.overview, v2.shortSummary, v2.brief, v2.tldr, latest.summary),
    items: items.filter((x) => (seen.has(x.key) ? false : seen.add(x.key))),
  };
}

/** Work hours on a work day → the person's work space; otherwise their personal space. The agent can move it. */
export function pocketSpace(people, user, at) {
  const own = people.spaces.filter((s) => s.owner === user);
  const work = own.find((s) => s.kind === 'work');
  const personal = own.find((s) => s.kind === 'personal');
  let atWork = true;
  if (at && !Number.isNaN(Date.parse(at))) { const l = local(at); atWork = WORKDAYS.includes(l.dow) && l.time >= WORK_HOURS.start && l.time < WORK_HOURS.end; }
  return ((atWork ? work : personal) || work || personal || own[0])?.id || null;
}

const PRIORITY = { urgent: 'urgent', critical: 'urgent', high: 'high', medium: 'normal', normal: 'normal', low: 'low' };
export const reviewStatus = (schema) => schema.statuses.find((s) => s.id === 'review' && s.category === 'inbox') || schema.statuses.find((s) => s.category === 'inbox');

export function createPocketIntake({ root, taskStore, schemaStore, scheduler, people, spec = process.env.WORKBOARD_POCKET || '', retryMs = 90_000 }) {
  const secrets = parsePocketSpec(spec);
  const path = join(root, 'data', 'pocket.json');
  const lock = createLock();
  const load = async () => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return { recordings: {} }; } };
  const save = (state) => {
    const ids = Object.keys(state.recordings);
    if (ids.length > KEEP_RECORDINGS) for (const id of ids.sort((a, b) => (state.recordings[a].received || '').localeCompare(state.recordings[b].received || '')).slice(0, ids.length - KEEP_RECORDINGS)) delete state.recordings[id];
    return writeAtomic(path, JSON.stringify(state, null, 2));
  };

  function message(info, created, firstTime) {
    const when = info.at ? heDateTime(info.at) : '';
    const head = `🎙️ *${info.title}*${when ? ` — ${when}` : ''}${info.minutes ? ` · ${info.minutes} דק׳` : ''}`;
    const lines = created.map((t) => `• #${t.id} ${t.title}${t.deadline ? ` · עד ${heDate(t.deadline)}` : ''}`);
    if (!firstTime) return [`${head}\nמשימות חדשות מההקלטה, ממתינות לאישורך:`, ...lines, '', 'לאשר? אפשר לענות כאן.'].join('\n');
    const summary = info.summary.length > 900 ? `${info.summary.slice(0, 897)}…` : info.summary;
    return [head, summary && `\n${summary}`,
      created.length ? `\n*משימות לאישור* (${created.length}):\n${lines.join('\n')}\n\nלענות כאן: "מאשר הכל", "מאשר ${created[0].id}", "בלי #…", או לתקן פרויקט/תאריך.` : '\nלא זוהו משימות בהקלטה.',
    ].filter(Boolean).join('\n');
  }

  async function notify(user, info, created, firstTime) {
    const meta = { event_type: 'workboard.pocket', to: user, title: info.title, recording: info.id, tasks: created.map((t) => t.id), request_id: `pocket-${info.id}-${created.map((t) => t.id).join('.') || 'summary'}` };
    const text = message(info, created, firstTime);
    let result = await scheduler.deliver(text, meta);
    if (!result.ok && !result.definite && retryMs) {
      await new Promise((r) => { setTimeout(r, retryMs).unref?.(); });
      result = await scheduler.deliver(text, meta);
    }
    if (result.ok) await lock(async () => { const s = await load(); if (s.recordings[info.id]) { s.recordings[info.id].notified = new Date().toISOString(); await save(s); } });
    return result;
  }

  async function ingest(user, payload) {
    const info = extractPocket(payload);
    if (!info.id) throw Object.assign(new Error('Payload has no recording id'), { status: 400, code: 'invalid' });
    return lock(async () => {
      const state = await load();
      const rec = state.recordings[info.id] ||= { user, items: {}, received: new Date().toISOString() };
      const firstTime = !rec.summarized;
      Object.assign(rec, { title: info.title, at: info.at, summarized: true });
      const schema = await schemaStore.get();
      const status = reviewStatus(schema).id;
      const space = pocketSpace(people, user, info.at);
      const stamp = info.at ? `${local(info.at).d}.${local(info.at).m} ${local(info.at).time}` : '';
      const created = [];
      for (const item of info.items) {
        if (item.done || rec.items[item.key]) continue;
        const notes = [`🎙️ מתוך ההקלטה "${info.title}"${stamp ? ` (${stamp})` : ''}`, item.context, item.assignee && `אחראי לפי ההקלטה: ${item.assignee}`].filter(Boolean).join('\n');
        const priority = PRIORITY[item.priority] && schema.priorities.some((p) => p.id === PRIORITY[item.priority]) ? PRIORITY[item.priority] : undefined;
        const task = await taskStore.create({ title: item.title, status, space, source: POCKET_SOURCE, notes, ...(item.due && { deadline: item.due }), ...(priority && { priority }) }, { actor: POCKET_SOURCE });
        rec.items[item.key] = task.id;
        created.push(task);
      }
      await save(state);
      return { info, created, firstTime };
    });
  }

  /** recording.deleted: proposals from that recording that were never approved go to the archive. */
  async function forget(payload) {
    const id = payload.recording?.id && String(payload.recording.id);
    if (!id) return [];
    const rec = (await load()).recordings[id];
    if (!rec) return [];
    const status = reviewStatus(await schemaStore.get()).id;
    const archived = [];
    for (const taskId of Object.values(rec.items)) {
      const task = await taskStore.get(taskId).catch(() => null);
      if (task && !task.archived && task.status === status && task.source === POCKET_SOURCE) { await taskStore.update(taskId, { archived: true }, { actor: POCKET_SOURCE }); archived.push(taskId); }
    }
    return archived;
  }

  return {
    configured: secrets.size > 0,
    /**
     * Handles one delivery. Returns the HTTP answer plus `after` — the WhatsApp message, sent once Pocket has its
     * 200 (Pocket waits at most 30 s and retries).
     */
    async receive(user, raw, headers) {
      const secret = secrets.get(user);
      if (!secret) return { status: 404, body: { error: 'Not found', code: 'not_found' } };
      if (!verifyPocket(secret, raw, headers)) return { status: 401, body: { error: 'Bad signature', code: 'unauthorized' } };
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, body: { error: 'Invalid JSON', code: 'invalid_json' } }; }
      const event = String(payload.event || '');
      // The last payload (minus the transcript) is kept for troubleshooting: Pocket's summary format is undocumented.
      const { transcript, speakers, ...kept } = payload;
      await writeAtomic(join(root, 'data', 'runtime', 'pocket-last.json'), JSON.stringify({ received: new Date().toISOString(), user, payload: kept }, null, 2)).catch(() => {});
      if (event === 'recording.deleted') return { status: 200, body: { ok: true, archived: await forget(payload) } };
      if (!INGEST.has(event)) return { status: 200, body: { ok: true, ignored: event || 'unknown' } };
      const { info, created, firstTime } = await ingest(user, payload);
      const after = firstTime || created.length ? () => notify(user, info, created, firstTime) : null;
      return { status: 200, body: { ok: true, created: created.map((t) => t.id) }, after };
    },
  };
}
