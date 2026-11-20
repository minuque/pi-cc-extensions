<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

# pi-cc-extensions

> Claude Code-style TUI output with personal touches and handy utilities (no extra built-in tools).

## Preview

<a href="https://github.com/user-attachments/assets/6c858000-fdad-43f9-957f-4d0278648498"><img src="./assets/readme/preview.webp" alt="pi-cc-extensions UI preview" width="100%"></a>

Click the cover to play the demo video

## Quick start

```bash
pi install npm:pi-cc-extensions

# GitHub
pi install git:github.com/minuque/pi-cc-extensions
```

Run `/reload` after installation.

## Features

| Feature                     | Description                                                                                                                       | Entry point                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Claude Code UI              | Tool summaries, expand/collapse, rich edit/write diffs; `on` / `compact` / `off` modes                                            | `/ccstyle`                                              |
| Markdown enhancements       | Mermaid dialects in non-standard fences (`statediagram`, `classdiagram`…) and circled-number conversion; plain mermaid goes to pi | Automatic; turn off with `enableMarkdownEnhance: false` |
| Fullscreen mode             | Click to expand/collapse tool cards and groups, previews, hover highlight, back-to-bottom button                                  | `--tui-mode fullscreen` (default since pi 1.5)          |
| Settings panel              | `Style / Features / UI / Diff / Thinking / Footer` tabs                                                                           | `/ccstyle`                                              |
| Context inspection          | Usage breakdown plus previews of the system prompt, memory, skills, tools definition and messages                                 | `/context`                                              |
| Transcript browsing         | Full-screen transcript with every tool output expanded; the key goes to pi while a `!` output can be expanded                     | `Ctrl+O`                                                |
| Session/Subagent references | Search and inject effective context from previous Sessions or existing SubAgents                                                  | `@`                                                     |
| Status bar                  | Model, context, cache, cost, conversation token total and git, with live quota via `@narumitw/pi-usage`; Nerd Font icons optional | `/ccstyle` → Footer                                     |
| Theme                       | Bundled themes: CC Dark, CC Light, CC Dark HC, CC Light HC                                                                        | `/settings` → Theme                                     |

Renderer snapshots for `on` / `compact` modes: [default](./docs/tool-render-examples-default.md) · [compact](./docs/tool-render-examples-compact.md)

## Configuration

`/ccstyle` behavior is configured through `~/.pi/agent/pi-cc-extensions.json`:

```jsonc
{
  // style
  "mode": "on",                            // on / compact / off
  "excludeRenderers": [],                  // tools keeping the native renderer, case-insensitive; Agent always keeps its own

  // features
  "enableSessionReference": true,          // @ session references
  "enableSubagentAutocomplete": true,      // @subagent:[name] completion and delegation hints
  "enableContextCommand": true,            // /context usage check
  "enableAgentSummary": true,              // per-turn tool summary
  "enableWorkingMessage": true,            // Working... bottom token/elapsed
  "enableAliases": true,                   // /clear, /exit aliases
  "enableMarkdownEnhance": true,           // markdown pass: Mermaid dialects, circled-number conversion; false hands it to other extensions
  "enableTableCopy": false,                // TSV / CSV / Markdown table copy; enable in /ccstyle, restart required
  "enableEditorPrefix": true,              // editor ❯ prefix

  // ui
  "expandedInputMaxLines": 5,              // max expanded tool Input lines; overflow shows a hint
  "expandedOutputMaxLines": 10,            // max expanded tool Output lines; overflow shows a hint
  "expandedPreviewMaxLines": 40,           // max TaskList body lines (expanded diffs always show all)
  "toolLabelClip": 0,                      // tool summary path/command clip length; 0 = fit width
  "showStartupHeader": true,               // startup header (logo + tips) toggle
  "stickyUserMessage": true,               // fullscreen: pin a user message's first line once it scrolls off the top, until the next one takes over
  "scrollButtonMode": "dock",              // fullscreen: dock row / native Pi floating overlay

  // diff
  "diffViewMode": "auto",                  // layout: auto / split / unified
  "diffIndicatorMode": "bars",             // change indicators: bars / classic / none
  "diffSplitMinWidth": 120,                // min terminal width for side-by-side columns
  "editDiffCollapsedLines": 24,            // edit collapse lines; 0 = change-count summary only
  "writeDiffCollapsedLines": 0,            // write collapse lines; 0 = creation summary only
  "diffWordWrap": true,                    // wrap long diff lines

  // thinking
  "useSummaryTitlesAsThinkingTitle": true, // use latest summary as thinking title
  "previewLines": 3,                       // preview lines while thinking; 0 hides
  "completedPreviewLines": null,           // completed preview lines; 0 hides, null follows previewLines; panel takes a number or follow
  "animationIntervalMs": 90,               // title animation interval (ms)

  // footer
  "enableCustomFooter": true,              // custom status bar
  "footerTokenRate": true,                 // output rate chip; false hides it
  "footerTokenRateMode": "average",        // average: whole-prompt avg; live: trailing 1s rate
  "footerTokenRateTtft": true,             // append TTFT to the rate chip; false shows tok/s only
  "footerSessionTokens": false,            // conversation token total chip; sums usage.totalTokens of session entries. Off by default
  "footerNerdIcons": true,                 // Nerd Font glyphs for git/cache/tokens; false = plain text
  "footerGitStatsMode": "working",         // working (default): uncommitted; branch: cumulative net changes
  "footerContextLimit": "window",          // context chip limit: window (default) | compaction point | both; may briefly exceed 100%
  "footerHiddenKeys": [],                  // hidden chip keys
  "footerLine1Keys": ["model", "context", "cache", "rate", "cost", "tokens", "pi-usage"], // chip order per line, builtins and plugins share it
  "footerLine2Keys": ["cwd", "git"],       // cwd: directory and session; git: branch and changes
  "footerLine3Keys": []                    // painted only when a chip is visible
}
```

> [!TIP]
> **Fullscreen**: expanded diffs always show every line. When expanded Input/Output exceeds the cap, the footer shows `… +N more lines`; click for the full preview, click again to collapse.

> [!NOTE]
> **Mermaid rendering**: set `markdown.mermaid` to `final` (`/settings`) so it renders once instead of every frame.

## Local development

```bash
./test.sh            # macOS/Linux; needs node and pi
./test.bat           # Windows; runs test.sh through Git Bash
pi -e .              # one run, does not edit settings.json
```

## Compatibility

- Node.js `>=22.19.0`, Pi `^1.5.1`

## Recommended companions

| Extension                                | Purpose                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `npm:pi-web-access`                      | Web search, URL fetching, GitHub cloning, PDF/video parsing |
| `npm:@narumitw/pi-usage`                 | Current-account usage for Codex / Copilot / OpenRouter      |
| `npm:@juicesharp/rpiv-ask-user-question` | Multiple-choice questionnaire the model can ask you         |

## Credits

- Rich diffs are adapted from [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) (MIT). See [`extensions/renderer/tool/diff/ATTRIBUTION.md`](./extensions/renderer/tool/diff/ATTRIBUTION.md).

## License

[MIT](./LICENSE) © minuque
