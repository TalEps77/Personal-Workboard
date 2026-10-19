// One task = one readable Markdown file:
//
//   ---
//   status: "doing"            ← every value is JSON, which is also valid YAML
//   tags: ["לקוח"]
//   ---
//   # כותרת
//
//   ## שלבים
//   - [x] שלב שבוצע
//   - [ ] שלב פתוח
//
//   ## הערות
//   טקסט חופשי
//
// Parsing is tolerant (unquoted values, English headings) so hand edits by people or agents keep working.

export const FRONTMATTER_ORDER = ['space', 'assignee', 'status', 'priority', 'project', 'tags', 'when', 'deadline', 'reminders', 'fields', 'order', 'archived', 'source', 'org', 'seen', 'created_at', 'updated_at', 'completed_at', 'version'];
const STEP_HEADINGS = ['שלבים', 'Steps'];
const NOTES_HEADINGS = ['הערות', 'Notes'];

export const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
// A body line starting with "## " would be read back as a new section.
const safeBlock = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim().replace(/^## /gm, '\\## ');

function parseValue(raw) {
  const text = raw.trim();
  if (text === '' || text === '~') return null;
  try { return JSON.parse(text); } catch { /* fall through to YAML-ish */ }
  if (/^\[.*\]$/.test(text)) return text.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return text.replace(/^["']|["']$/g, '');
}

export function splitFrontmatter(markdown) {
  const text = markdown.replace(/\r\n?/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (kv) meta[kv[1]] = parseValue(kv[2]);
  }
  return { meta, body: text.slice(match[0].length) };
}

function sections(body) {
  const result = { title: '', parts: {} };
  let current = null;
  for (const line of body.split('\n')) {
    const h1 = line.match(/^# (.+)$/);
    if (h1 && !result.title) { result.title = h1[1].trim(); current = null; continue; }
    const h2 = line.match(/^## (.+)$/);
    if (h2) { current = h2[1].trim(); result.parts[current] = []; continue; }
    if (current) result.parts[current].push(line);
  }
  return result;
}

const pick = (parts, names) => {
  for (const name of names) if (parts[name]) return parts[name].join('\n').trim();
  return '';
};

export function parseSteps(text) {
  return text.split('\n').flatMap((line) => {
    const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s?(.*)$/);
    return m ? [{ text: m[2].trim(), done: m[1] !== ' ' }] : [];
  });
}

export function parseTask(markdown, id) {
  const { meta, body } = splitFrontmatter(markdown);
  const { title, parts } = sections(body);
  return {
    id,
    title,
    // Which space the task lives in (null = the original work board) and, in a shared space, whose it is.
    space: meta.space || null,
    assignee: meta.assignee || null,
    status: meta.status ?? 'inbox',
    priority: meta.priority ?? null,
    project: meta.project || null,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    when: meta.when || null,
    deadline: meta.deadline || null,
    reminders: Array.isArray(meta.reminders) ? meta.reminders : [],
    fields: meta.fields && typeof meta.fields === 'object' && !Array.isArray(meta.fields) ? meta.fields : {},
    order: Number.isFinite(meta.order) ? meta.order : 0,
    archived: meta.archived === true || meta.archived === 'true',
    source: meta.source || 'dashboard',
    // Linked to a team board (server/org-sync.js): { id, user, url, role, status, snap, … } — absent on personal tasks.
    org: meta.org && typeof meta.org === 'object' && !Array.isArray(meta.org) ? meta.org : null,
    seen: meta.seen !== false && meta.seen !== 'false',
    created_at: meta.created_at || null,
    updated_at: meta.updated_at || null,
    completed_at: meta.completed_at || null,
    // Bumped on every save: lets clients drop a response that is older than what they already have.
    version: Number.isFinite(meta.version) ? meta.version : 0,
    steps: parseSteps(pick(parts, STEP_HEADINGS)),
    notes: pick(parts, NOTES_HEADINGS).replace(/^\\## /gm, '## '),
  };
}

export function serializeTask(task) {
  // space/assignee only when set: tasks on the original work board keep their files exactly as before.
  const meta = FRONTMATTER_ORDER.filter((key) => !(['space', 'assignee', 'org'].includes(key) && !task[key])).map((key) => `${key}: ${JSON.stringify(task[key] ?? null)}`).join('\n');
  const steps = task.steps.map((s) => `- [${s.done ? 'x' : ' '}] ${oneLine(s.text)}`).join('\n');
  return `---\n${meta}\n---\n\n# ${oneLine(task.title)}\n\n## שלבים\n${steps}\n\n## הערות\n${safeBlock(task.notes)}\n`;
}
