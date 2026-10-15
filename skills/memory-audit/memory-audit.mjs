#!/usr/bin/env node
// memory-audit — lifecycle audit for Claude Code auto-memory + startup context budget.
//
//   node memory-audit.mjs [--root <dir>] [--memory-dir <dir>] [--out <dir>]   full report
//   node memory-audit.mjs --hook                                              SessionStart: silent unless over budget
//   node memory-audit.mjs --self-test                                         asserts on the pure helpers
//
// Zero dependencies (Node built-ins only). Config: <root>/.claude/memory-audit.json (all keys optional).
// Env overrides: MEMORY_AUDIT_ROOT, MEMORY_DIR, MEMORY_AUDIT_OUT.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

// ---------- pure helpers ----------

// Claude Code's project-dir encoding: every non-alphanumeric char becomes '-' (underscores too).
// e.g. "C:\Users\me\proj_x" -> "C--Users-me-proj-x", "/home/me/proj" -> "-home-me-proj".
export const encodeProjectDir = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// Rough token estimate: CJK ~1 token per char, everything else ~4 chars per token.
export const estTokens = (s) => {
  const cjk = (s.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  return Math.round(cjk + (s.length - cjk) / 4);
};

// Defaults were calibrated on one real project (a ~450-page content site, ~90 memories):
// CLAUDE.md held all its every-turn rules in ~150 lines / ~4K tokens after a three-layer split,
// so 160 / 6000 leaves headroom; MEMORY.md is one line per memory, so its line cap tracks the
// memory count (115 at ~90 memories) and tokens (3500) are the real budget. Tune per project.
const DEFAULTS = {
  claudeMd: 'CLAUDE.md',
  memoryDir: null, // null = ~/.claude/projects/<encoded root>/memory
  reportDir: null, // null = reports/ if it exists, else .claude/
  budgets: {
    claudeMd: { lines: 160, tokens: 6000 },
    memoryIndex: { lines: 115, tokens: 3500 },
  },
  citePaths: ['CLAUDE.md', '.claude', 'docs', 'scripts'], // where a slug counts as "still referenced"
  gatePrefixes: ['lint', 'verify', 'audit', 'check', 'test'], // package.json scripts that count as machine checks
  archivePattern: '(-launch|-roadmap|roadmap-|-status)', // project-type slugs that are history logs
  staleDays: 90,
  archiveDays: 60,
  overlapThreshold: 0.08,
};

export function loadConfig(root) {
  const p = join(root, '.claude', 'memory-audit.json');
  let user = {};
  if (existsSync(p)) {
    try { user = JSON.parse(readFileSync(p, 'utf8')); }
    catch (e) { throw new Error(`invalid JSON in ${p}: ${e.message}`); }
  }
  return {
    ...DEFAULTS, ...user,
    budgets: {
      claudeMd: { ...DEFAULTS.budgets.claudeMd, ...user.budgets?.claudeMd },
      memoryIndex: { ...DEFAULTS.budgets.memoryIndex, ...user.budgets?.memoryIndex },
    },
  };
}

const abs = (root, p) => (isAbsolute(p) ? p : join(root, p));

export const memoryDirFor = (root, cfg, override) =>
  override || process.env.MEMORY_DIR || (cfg.memoryDir && abs(root, cfg.memoryDir)) ||
  join(homedir(), '.claude', 'projects', encodeProjectDir(root), 'memory');

export function budgets(root, cfg, memDir) {
  return [
    ['CLAUDE.md', abs(root, cfg.claudeMd), cfg.budgets.claudeMd],
    ['MEMORY.md', join(memDir, 'MEMORY.md'), cfg.budgets.memoryIndex],
  ].flatMap(([label, p, lim]) => {
    if (!existsSync(p)) return [];
    const text = readFileSync(p, 'utf8');
    const lines = text.split('\n').length;
    const tokens = estTokens(text);
    return [{ label, path: p, lines, lineLimit: lim.lines, tokens, tokenLimit: lim.tokens,
              over: lines > lim.lines || tokens > lim.tokens }];
  });
}

// ---------- args ----------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (flag('--self-test')) {
  const { strictEqual: eq } = await import('node:assert');
  eq(encodeProjectDir('C:\\Users\\me\\Desktop\\my_site'), 'C--Users-me-Desktop-my-site');
  eq(encodeProjectDir('/home/me/proj.x'), '-home-me-proj-x');
  eq(encodeProjectDir('C:\\Users\\\u65e5\u672c\\Desktop\\a'), 'C--Users----Desktop-a'); // each CJK char -> one '-'
  eq(estTokens('abcdefgh'), 2);
  eq(estTokens('\u8a18\u61b6'), 2);
  console.log('self-test ok');
  process.exit(0);
}

const ROOT = resolve(opt('--root') || process.env.MEMORY_AUDIT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());

// ---------- SessionStart hook: silent unless over budget; never blocks the session ----------

if (flag('--hook')) {
  try {
    const cfg = loadConfig(ROOT);
    const over = budgets(ROOT, cfg, memoryDirFor(ROOT, cfg)).filter((b) => b.over);
    if (over.length) {
      const msg = `Context startup budget exceeded: ${over
        .map((b) => `${b.label} ${b.lines}/${b.lineLimit} lines, ~${b.tokens}/${b.tokenLimit} tokens`)
        .join('; ')}. Run /memory-audit to move situational sections out of the always-loaded layer.`;
      console.log(JSON.stringify({
        systemMessage: msg,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
      }));
    }
  } catch { /* silent: a startup check must never break the session */ }
  process.exit(0);
}

// ---------- full audit ----------

let cfg;
try { cfg = loadConfig(ROOT); } catch (e) { console.error(e.message); process.exit(1); }
const MEMORY_DIR = memoryDirFor(ROOT, cfg, opt('--memory-dir'));
const DAY = 86400000;
const today = new Date().toISOString().slice(0, 10);
const hasMemory = existsSync(MEMORY_DIR);

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', '.git', 'dist', 'build', 'reports'].includes(e.name)) walk(p, out);
    } else if (/\.(md|mjs|cjs|js|ts|tsx|py|sh|json|astro)$/.test(e.name)) out.push(p);
  }
  return out;
};

const memFiles = hasMemory ? readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md') : [];

// Citation pool. MEMORY.md index lines do not count (every memory has one, so it carries no signal).
const citePool = [
  ...cfg.citePaths.map((p) => abs(ROOT, p)).filter(existsSync)
    .flatMap((p) => (statSync(p).isDirectory() ? walk(p) : [p])),
  ...memFiles.map((f) => join(MEMORY_DIR, f)),
];
const haystack = citePool.map((f) => readFileSync(f, 'utf8')).join('\n');

// Machine checks that exist in this repo: package.json scripts with a gate prefix, and check-* script files.
const pkgPath = join(ROOT, 'package.json');
const scriptNames = new Set();
if (existsSync(pkgPath)) {
  try {
    for (const n of Object.keys(JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {}))
      if (cfg.gatePrefixes.some((p) => n === p || n.startsWith(p + ':') || n.startsWith(p + '-'))) scriptNames.add(n);
  } catch { /* unreadable package.json: no npm gates */ }
}
const scriptFiles = new Set(existsSync(join(ROOT, 'scripts'))
  ? readdirSync(join(ROOT, 'scripts')).filter((f) => /^check-.*\.(mjs|cjs|js|sh|py)$/.test(f)) : []);

const indexText = hasMemory && existsSync(join(MEMORY_DIR, 'MEMORY.md')) ? readFileSync(join(MEMORY_DIR, 'MEMORY.md'), 'utf8') : '';
const archiveRe = new RegExp(cfg.archivePattern);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rows = memFiles.map((f) => {
  const path = join(MEMORY_DIR, f);
  const body = readFileSync(path, 'utf8');
  const slug = basename(f, '.md');
  const type = (body.match(/^\s*type:\s*(\w+)/m) || [, 'project'])[1];

  // mtime is "file was touched", not "fact was checked". Prefer frontmatter lastVerified.
  const verified = (body.match(/^\s*lastVerified:\s*(\d{4}-\d{2}-\d{2})/m) || [])[1];
  const ageSource = verified ? 'lastVerified' : 'mtime';
  const ageDays = Math.floor((Date.now() - (verified ? Date.parse(verified) : statSync(path).mtimeMs)) / DAY);

  const citedIn = Math.max(0, (haystack.match(new RegExp(esc(slug), 'g')) || []).length - 1); // minus its own file

  // Mentions a gate that really exists -> a machine already enforces this rule.
  // Accept both `name` and `npm run name` (missing the space form caused false positives once).
  const mentioned = [
    ...(body.match(/`(?:npm run )?([\w:-]+)`/g) || []).map((m) => m.replace(/`|npm run /g, '')),
    ...(body.match(/npm run ([\w:-]+)/g) || []).map((m) => m.slice(8)),
    ...(body.match(/(check-[\w-]+\.(?:mjs|cjs|js|sh|py))/g) || []),
  ];
  const supersededBy = [...new Set(mentioned.filter((m) => scriptNames.has(m) || scriptFiles.has(m)))];

  const typeWeight = type === 'user' || type === 'feedback' ? 2 : type === 'reference' ? 1 : 0;
  const recency = ageDays <= 30 ? 3 : ageDays <= 90 ? 2 : ageDays <= 180 ? 1 : 0;
  const score = recency + Math.min(citedIn, 3) + typeWeight;

  const verdict = type === 'project' && archiveRe.test(slug) && ageDays > cfg.archiveDays ? 'archive'
    : supersededBy.length && ageDays > cfg.archiveDays && citedIn === 0 ? 'superseded'
    : ageDays > cfg.staleDays && citedIn === 0 ? 'stale'
    : 'active';

  // Drifting values (money, percentages) stored without a pointer to their authority.
  // Dates are deliberately NOT matched: "user decided on 2026-01-05" is a timestamp that never drifts.
  const frozen = (body.match(/(¥|€|£|NT\$|US\$|\$)\s?[\d,]{2,}|[\d.]+\s?%/g) || []).slice(0, 4);
  const hasAuthority = /`[a-z]+:[a-z]|npm run [a-z]|\.(mjs|js|py|sh)\b|src\/|scripts\/|docs\/|\.claude\/|https?:\/\/|source of truth|authoritative|權威來源/i.test(body);

  const outLinks = [...new Set((body.match(/\[\[([\w-]+)\]\]/g) || []).map((m) => m.slice(2, -2)))];

  return { slug, type, ageDays, ageSource, citedIn, supersededBy, score, verdict, frozen, hasAuthority, outLinks,
           text: body.replace(/^---[\s\S]*?---/, ''), bytes: Buffer.byteLength(body), indexed: indexText.includes(`(${f})`) };
});

// Near-duplicates: character 4-gram Jaccard. No embeddings needed at this scale.
const grams = (s) => { const t = s.replace(/\s+/g, ''); const set = new Set(); for (let i = 0; i + 4 <= t.length; i++) set.add(t.slice(i, i + 4)); return set; };
const gramSets = rows.map((r) => grams(r.text));
const dupes = [];
for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) { // ponytail: O(n^2), fine below ~2000 memories
  const [a, b] = [gramSets[i], gramSets[j]];
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  const jac = shared / (a.size + b.size - shared || 1);
  if (jac >= cfg.overlapThreshold) dupes.push({ a: rows[i].slug, b: rows[j].slug, pct: Math.round(jac * 100) });
}
dupes.sort((x, y) => y.pct - x.pct);

const linkedTo = new Set(rows.flatMap((r) => r.outLinks));
const isolated = rows.filter((r) => !r.outLinks.length && !linkedTo.has(r.slug));
const unsourced = rows.filter((r) => r.frozen.length && !r.hasAuthority);
const noVerifyDate = rows.filter((r) => r.ageSource === 'mtime');
const orphans = rows.filter((r) => !r.indexed);

const budget = budgets(ROOT, cfg, MEMORY_DIR);
const claudeMdPath = abs(ROOT, cfg.claudeMd);
const sections = existsSync(claudeMdPath)
  ? readFileSync(claudeMdPath, 'utf8').split(/^## /m).slice(1)
    .map((s) => ({ title: s.split('\n')[0].trim(), lines: s.split('\n').length, tokens: estTokens(s) }))
    .sort((a, b) => b.lines - a.lines)
  : [];

// ---------- report ----------

const order = { superseded: 0, stale: 1, archive: 2, active: 3 };
rows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.score - b.score);
const count = (v) => rows.filter((r) => r.verdict === v).length;
const table = (list) => list.length ? ['| slug | type | days idle | cited | score | gate |', '|---|---|---:|---:|---:|---|',
  ...list.map((r) => `| \`${r.slug}\` | ${r.type} | ${r.ageDays}${r.ageSource === 'mtime' ? '~' : ''} | ${r.citedIn} | ${r.score} | ${r.supersededBy.join(', ') || '-'} |`)].join('\n') : 'None.';
const claudeOver = budget.find((b) => b.label === 'CLAUDE.md')?.over;

const report = `# Memory audit ${today}

Project root: \`${basename(ROOT)}\`
${hasMemory ? `${rows.length} memories, ${(rows.reduce((s, r) => s + r.bytes, 0) / 1024).toFixed(0)} KB.` : `No memory directory found (looked in \`${MEMORY_DIR}\`). Only the context budget is checked.`}
Score = recency(0-3) + min(citations, 3) + type weight (user/feedback 2, reference 1, project 0); max 8.
Recency: <=30 days 3, <=90 2, <=180 1, else 0. Days marked \`~\` come from mtime (no \`lastVerified\`).

## Context startup budget

| file | lines | line cap | ~tokens | token cap | |
|---|---:|---:|---:|---:|---|
${budget.map((b) => `| ${b.label} | ${b.lines} | ${b.lineLimit} | ~${b.tokens} | ${b.tokenLimit} | ${b.over ? 'OVER' : 'ok'} |`).join('\n') || '| (no CLAUDE.md or MEMORY.md found) | | | | | |'}
${claudeOver ? `\n### Largest CLAUDE.md sections (move candidates)\n\n${sections.slice(0, 5).map((s, i) => `${i + 1}. **${s.title}** - ${s.lines} lines / ~${s.tokens} tokens`).join('\n')}\n\nKeep what every turn needs; move what only one task needs to an on-demand doc and leave a one-line "trigger + path" pointer.\n` : ''}
## Dispositions

- archive ${count('archive')} (move to \`memory/archive/\`; history logs, kept for lookup)
- superseded ${count('superseded')} (**ask the user** - a gate already enforces it and nothing cites it)
- stale ${count('stale')} (**ask the user** - idle > ${cfg.staleDays} days and uncited)
- active ${count('active')}

### superseded
${table(rows.filter((r) => r.verdict === 'superseded'))}

### stale
${table(rows.filter((r) => r.verdict === 'stale'))}

### archive
${table(rows.filter((r) => r.verdict === 'archive'))}

### active
${table(rows.filter((r) => r.verdict === 'active'))}

## Quality: can this memory still be trusted?

### Drifting values with no pointer to their source (${unsourced.length})

A stored value is an unguarded copy. Replace it with "where the authority lives + how to recognize it".

${unsourced.length ? unsourced.map((r) => `- \`${r.slug}\` - found ${r.frozen.map((v) => `\`${v}\``).join(', ')}`).join('\n') : 'None.'}

### No \`lastVerified\` - age falls back to mtime (${noVerifyDate.length}/${rows.length})

Add \`lastVerified: YYYY-MM-DD\` to the frontmatter. Do not backfill it from mtime.

### Overlap candidates (4-gram Jaccard >= ${Math.round(cfg.overlapThreshold * 100)}%, ${dupes.length} pairs)

Candidates, not verdicts. Overlapping memories can contradict each other, and recall pulls only one.

${dupes.length ? ['| A | B | overlap |', '|---|---|---:|', ...dupes.slice(0, 15).map((d) => `| \`${d.a}\` | \`${d.b}\` | ${d.pct}% |`)].join('\n') : 'None.'}

### Isolated (no [[links]] in or out, ${isolated.length})

${isolated.length ? isolated.map((r) => `- \`${r.slug}\``).join('\n') : 'None.'}
${orphans.length ? `\n## Not listed in MEMORY.md (${orphans.length})\n\n${orphans.map((r) => `- \`${r.slug}\``).join('\n')}\n` : ''}`;

const outDir = abs(ROOT, opt('--out') || process.env.MEMORY_AUDIT_OUT || cfg.reportDir ||
  (existsSync(join(ROOT, 'reports')) ? 'reports' : '.claude'));
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `memory-audit-${today}.md`);
writeFileSync(out, report);

if (!hasMemory) console.log(`no memory dir at ${MEMORY_DIR} (override with --memory-dir or MEMORY_DIR)`);
else console.log(`${rows.length} memories - archive ${count('archive')} / superseded ${count('superseded')} / stale ${count('stale')} / active ${count('active')}`);
for (const b of budget) console.log(`${b.over ? 'OVER' : 'ok  '} ${b.label}: ${b.lines}/${b.lineLimit} lines, ~${b.tokens}/${b.tokenLimit} tokens`);
if (hasMemory) console.log(`quality: ${unsourced.length} unsourced values / ${noVerifyDate.length} without lastVerified / ${dupes.length} overlap pairs / ${isolated.length} isolated${orphans.length ? ` / ${orphans.length} not indexed` : ''}`);
console.log(`-> ${out}`);
