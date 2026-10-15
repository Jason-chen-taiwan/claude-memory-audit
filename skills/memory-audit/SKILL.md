---
name: memory-audit
description: Use when the project's context or memory needs upkeep - "/memory-audit", "CLAUDE.md is too long", "too many memories", "clean up memory", "startup tokens are expensive", "is this memory still valid", "整理記憶", "CLAUDE.md 太長" - when the SessionStart budget warning fires, or when a rule is about to be added to CLAUDE.md and you need to decide which layer it belongs in.
---

# memory-audit - three-layer context hygiene

## The three layers

| Layer | What goes there | When it loads |
|---|---|---|
| **Constitution** - `CLAUDE.md` | Judgments needed every turn; red lines no machine check can catch | Every session |
| **Playbook** - `docs/`, `.claude/agents/`, any on-demand file | Procedures, word lists, location lists, worked examples, history | Read right before doing that task |
| **Ledger** - auto-memory (`~/.claude/projects/<encoded>/memory/`) | One fact per file | Recalled on demand |

**The one placement test:** is this rule needed **every turn**, or only **when doing one specific thing**?
The second kind moves to the playbook; the constitution keeps a single line: **trigger + path**
("Before touching the billing code, read `docs/rules/billing.md`"). A pointer with no trigger is no pointer:
the next session will not know when to open it.

## When to run what

| Check | Nature | Trigger |
|---|---|---|
| **Budget** (CLAUDE.md and MEMORY.md lines / tokens) | Hard check; normally green | SessionStart hook runs automatically, **silent unless over budget** |
| **Lifecycle & quality** (stale, superseded, overlap, isolated, unsourced) | Audit; never reaches zero | Weekly, or when the user asks |
| **Which layer does this rule belong in** | Judgment, not a check | Whenever a rule is about to be added to CLAUDE.md |

Do not make the budget a CI/build gate. A build that fails because CLAUDE.md grew one line has the wrong blast
radius. The SessionStart hook has the right one: only the author sees it, at the moment a rule is being added.

## How to run

The script sits next to this file (this skill's base directory). Run it from the project root:

```
node "<this skill's base directory>/memory-audit.mjs"
```

Options: `--root <dir>`, `--memory-dir <dir>`, `--out <dir>` (env: `MEMORY_AUDIT_ROOT`, `MEMORY_DIR`, `MEMORY_AUDIT_OUT`).
Limits and paths come from `.claude/memory-audit.json` in the project (see the plugin README); defaults apply otherwise.
The report lands in `reports/` if that folder exists, else `.claude/`.

Score 0-8:

```
score   = recency(0-3) + min(citations, 3) + type weight (user/feedback 2, reference 1, project 0)
recency = <=30 days 3; <=90 2; <=180 1; else 0
```

"Citations" = how often the slug appears in `CLAUDE.md`, `.claude/`, `docs/`, `scripts/` (configurable) and in
**other** memory files. **MEMORY.md index lines do not count**: every memory has one, so they carry no signal.
Age comes from frontmatter `lastVerified` when present, else file mtime (shown with `~`). Auto-memory is not in git,
so there is no commit date to use.

## Four dispositions

| Verdict | Action |
|---|---|
| `archive` | May be done without asking: move to `memory/archive/`, collapse its MEMORY.md lines into one. It is a move, not a delete. Only history-log slugs (`-launch`, `-roadmap`, `-status`...) of type project qualify. |
| `superseded` | **Ask the user.** A gate script/npm check named in the memory exists and nothing cites the memory. On approval, delete the file and put the rule into that gate's comments. |
| `stale` | **Ask the user.** Idle > 90 days and uncited. List score and reason, wait for a ruling. |
| `active` | Leave it. |

**Never auto-delete `superseded` or `stale`.** Deleting a memory that is still valid is worse than keeping one that expired.

## Reading the quality section

All four items are lists only. Nothing is auto-fixed.

1. **Drifting values with no pointer to their source.** A memory that stores a value (price, percentage, limit) is an
   unguarded copy. Rewrite it as "the authority lives at X + how to recognize it"; the value stays in the repo,
   the script, or the official page. Only money and percentages are matched, **not dates**: "user decided on
   2026-01-05" is a timestamp of a decision and never drifts. Matching dates turned this list from 13 real hits
   into 33 hits, 30 of them noise.
2. **No `lastVerified`.** mtime means "the file was touched", not "the fact was checked"; fixing a typo makes an
   expired memory look fresh. Add `lastVerified: YYYY-MM-DD` to the frontmatter.
3. **Overlap candidates** - character 4-gram Jaccard >= 8%. Calibrated on CJK-heavy notes where the highest real pair
   was ~10.5%, so 8% means "worth a look", not "duplicate". Overlapping memories can contradict each other, and recall
   only pulls one of them. For English-heavy memories you may want a higher threshold.
4. **Isolated** - no `[[link]]` in or out. Link graphs tend to be dense, so connectivity is **not** part of the score.

## Lessons from the first real cleanup

1. **Verify the detector before you trust the list.** The first "unsourced value" list had 13 entries; 4 were false
   positives because the detector recognized `` `lint:x` `` but not `` `npm run lint:x` ``. When a list is red, first
   ask whether the detector is wrong.
2. **Overlap candidates are candidates, not verdicts.** Of 7 pairs, 1 was a real conflict (an old decision quietly
   superseded by a newer one). The top-ranked pair was a **deliberate complementary pair**: one memory said "a failed
   attempt hardens into 'impossible'", the other "a successful attempt hardens into an unverified cause". Merging would
   have lost the general lesson. What actually needed fixing was a **description**: the general lesson was buried in a
   file whose description said "overturned", so recall would never surface it at the moment it mattered.
3. **Do not backfill `lastVerified` from mtime** - that writes the mtime lie into a field. Take the **last date in the
   body that is not later than today** (decision date, incident date, verification date). If there is none, leave it
   empty. In practice ~90% of memories had one.
4. **Turn memories into pointers.** Move the data into a playbook doc; keep in memory only the judgment needed at the
   moment of recall. One memory went from 29 KB to 1.7 KB (a recall had cost ~10K tokens): the big lookup table moved
   to `docs/rules/`, the memory kept the five signs for recognizing the situation. Test: **does the person opening
   this memory need a judgment or a dataset right now?** Move the dataset, keep the judgment.

**Do not add a relevance field or a vector index.** Relevance is query-dependent, and the harness already does recall
by matching the current task against each memory's `description`. A separate retrieval path would never be used at
recall time; it would only serve the audit, which does not need it. The one place similarity helps here is overlap
detection, and n-grams are enough.

## When the context budget is over

The report lists the five largest `## ` sections of CLAUDE.md. To move one:

1. Copy the section **verbatim** to `docs/rules/<topic>.md` (or wherever the project keeps on-demand docs), with a
   header line: "moved from CLAUDE.md on <date>; read when <trigger>".
2. In CLAUDE.md, leave one line: **trigger + path**. A "before doing X, read Y" table works well.
3. Prove nothing was lost. Keep a copy of the pre-move CLAUDE.md and check every substantial line still exists somewhere:

```
node -e "
const fs=require('fs'),path=require('path');
const old=fs.readFileSync(process.argv[1],'utf8').split('\n');
const walk=(d,o=[])=>{if(!fs.existsSync(d))return o;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,o);else if(e.name.endsWith('.md'))o.push(p);}return o;};
const hay=['CLAUDE.md',...walk('docs'),...walk('.claude')].filter(f=>fs.existsSync(f)).map(f=>fs.readFileSync(f,'utf8')).join('\n');
old.filter(l=>l.trim().length>=15&&!hay.includes(l.trim())).forEach(l=>console.log('MISS |',l.trim().slice(0,100)));
" <path-to-pre-move-copy>
```

Read every `MISS` line yourself: deliberate rewording is fine, a dropped line must be restored.
Leave tool-managed blocks in CLAUDE.md (marked by HTML comments or other tools' markers) untouched.

## Out of scope

- **No vector store, no external memory service.** Below roughly 2,000 hand-curated memories, files plus grep win
  (a plain filesystem agent scored 74.0% on LoCoMo vs 68.5% for Mem0's graph variant) and you avoid a single point of failure.
- **The audit is not a build gate.** It is an audit: run by hand, produces a work list, never reaches zero.
- **Large docs that are never auto-loaded** (history logs, changelogs) are not a budget problem. Leave them.

---

## 繁體中文摘要

- **三層**：憲法層 `CLAUDE.md`（每一輪都要用的判準）／操作層 `docs/`、`.claude/agents/`（做那件事之前才讀）／帳本層 auto-memory（一則一事實，按需 recall）。
- **分層判準一句話**：這條規則是每一輪都要用，還是只在做某件特定事情時才要用？後者搬操作層，`CLAUDE.md` 只留「觸發條件 ＋ 路徑」。
- **預算**由 SessionStart hook 檢查，超標才出聲；不要做成 build gate（炸的範圍不對）。
- **四種處置**：`archive` 可直接搬（搬家不是刪除）；`superseded`、`stale` **一律先問用戶，不自動刪**。
- **先驗偵測器，再信清單**；重疊候選是候選不是判決；`lastVerified` 不要用 mtime 回填，從內文最後一個不晚於今天的日期抓；把記憶變成指標（資料搬走、判準留下）；不引向量庫。
