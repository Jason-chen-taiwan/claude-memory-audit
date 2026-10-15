# claude-memory-audit

A Claude Code plugin that keeps `CLAUDE.md` and auto-memory lean and trustworthy.

- **Three-layer method** (skill): constitution (`CLAUDE.md`, every turn) / playbook (on-demand docs) / ledger (auto-memory, one fact per file), with a one-question test for where a rule belongs.
- **SessionStart budget check** (hook): measures `CLAUDE.md` and `MEMORY.md` lines and estimated tokens. Prints nothing unless a limit is exceeded; never blocks a session.
- **Lifecycle audit** (script): scores every memory and sorts it into `archive` / `superseded` / `stale` / `active`, then lists quality issues: drifting values with no source pointer, missing `lastVerified`, overlapping memories, isolated memories, memories missing from the index.

Zero dependencies: one Node script using only built-in modules (Node 18+).

## Install

In a Claude Code session:

```
/plugin marketplace add Jason-chen-taiwan/claude-memory-audit
/plugin install memory-audit@claude-memory-audit
```


## Use

- Ask Claude "/memory-audit", "CLAUDE.md is too long", or "clean up memory". The skill runs the audit, explains the report, and asks before deleting anything.
- Run the script directly from your project root:

```
node <plugin-dir>/skills/memory-audit/memory-audit.mjs               # full report
node <plugin-dir>/skills/memory-audit/memory-audit.mjs --hook        # budget check only (what the hook runs)
node <plugin-dir>/skills/memory-audit/memory-audit.mjs --self-test   # built-in asserts
```

Options: `--root <dir>`, `--memory-dir <dir>`, `--out <dir>`. Environment overrides: `MEMORY_AUDIT_ROOT`, `MEMORY_DIR`, `MEMORY_AUDIT_OUT`.

The memory directory is found automatically at `~/.claude/projects/<encoded project path>/memory/`, where the encoding replaces every non-alphanumeric character of the absolute project path with `-` (e.g. `/home/me/my_app` becomes `-home-me-my-app`).

The report is written to `reports/memory-audit-<date>.md` if `reports/` exists, otherwise `.claude/memory-audit-<date>.md`.

## Configure (optional)

`.claude/memory-audit.json` in your project. Every key is optional; these are the defaults:

```json
{
  "claudeMd": "CLAUDE.md",
  "memoryDir": null,
  "reportDir": null,
  "budgets": {
    "claudeMd": { "lines": 160, "tokens": 6000 },
    "memoryIndex": { "lines": 115, "tokens": 3500 }
  },
  "citePaths": ["CLAUDE.md", ".claude", "docs", "scripts"],
  "gatePrefixes": ["lint", "verify", "audit", "check", "test"],
  "gates": ["pytest", "ruff check"],
  "archivePattern": "(-launch|-roadmap|roadmap-|-status)",
  "staleDays": 90,
  "archiveDays": 60,
  "overlapThreshold": 0.08
}
```

- **Budgets**: calibrated on one real project (~90 memories). After a three-layer split its `CLAUDE.md` held every per-turn rule in ~150 lines / ~4K tokens, so 160 / 6,000 leaves headroom. `MEMORY.md` is one line per memory, so its line cap should track your memory count; tokens are the real budget. Tune both for your project.
- **citePaths**: where a memory's slug counts as "still referenced".
- **gatePrefixes**: `package.json` scripts with these prefixes, plus `scripts/check-*` files, count as machine checks. A memory naming one that exists, uncited and idle, is flagged `superseded`.
- **gates**: machine checks for any language or build tool (`pytest`, `ruff check`, `make lint`, `cargo clippy`...). A memory that names one in backticks counts as already enforced. Use this in non-Node projects, where `gatePrefixes` finds nothing.
- **overlapThreshold**: tuned on CJK-heavy notes; English-heavy memories may want a higher value.

## Limitations

- Token counts are estimates (CJK ~1 token/char, other text ~4 chars/token), not a tokenizer.
- Age falls back to file mtime when a memory has no `lastVerified` frontmatter; auto-memory is not in git.
- Very long project paths, or setups that relocate auto-memory, may not match the computed directory. Pass `--memory-dir` or set `MEMORY_DIR`.
- `superseded` detection finds `package.json` scripts and `scripts/check-*` files on its own; for other languages list your checks in `gates`.
- Needs `node` (18+) on PATH for the SessionStart hook and the audit script.
- The audit never deletes or edits memories. The skill asks before any `superseded` / `stale` removal.

---

## 繁體中文

讓 `CLAUDE.md` 與 auto-memory 保持精簡、可信的 Claude Code plugin。

- **三層分離**：憲法層 `CLAUDE.md`（每一輪都要用）／操作層（做那件事之前才讀的文件）／帳本層 auto-memory（一則一事實）。分層判準：「每一輪都要用，還是只在做某件特定事情時才要用？」
- **SessionStart 預算檢查**：量 `CLAUDE.md`、`MEMORY.md` 的行數與 token 估計，超標才出聲，絕不擋 session。
- **生命週期稽核**：每則記憶算分數、分成 archive／superseded／stale／active，並列出「存了會漂的值卻沒指向來源」「沒有 lastVerified」「主題重疊」「孤立」等品質問題。只列清單，不自動刪。
- **任何語言都能用**：Node 專案自動從 `package.json` 找檢查指令；Python、Go 等專案在 `.claude/memory-audit.json` 寫 `"gates": ["pytest", "ruff check"]`。需要 `node` 18 以上。

安裝：

```
/plugin marketplace add Jason-chen-taiwan/claude-memory-audit
/plugin install memory-audit@claude-memory-audit
```

設定檔放專案的 `.claude/memory-audit.json`（欄位見上方英文段，全部可省略）。零依賴，只用 Node 內建模組。

## License

MIT
