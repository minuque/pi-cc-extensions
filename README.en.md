<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

# pi-cc-extensions

> Claude Code-style TUI output with some personal touches and handy utilities.

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

| Feature                     | Description                                                                               | Entry point                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Claude Code UI              | Tool summaries, expand/collapse, rich edit/write diffs, and `on` / `compact` / `off` modes | `/ccstyle`                                      |
| Markdown enhancements       | Mermaid diagrams, admonitions, URL linking, and more                                      | Automatic                                       |
| Fullscreen mode             | Tool card/group expand and collapse, previews, hover highlight, and a back-to-bottom button | `TUIMODE=fullscreen` or `--tui-mode fullscreen` |
| Settings panel              | `Style / Features / UI / Diff / Thinking / Footer` tabs                                   | `/ccstyle`                                      |
| Context inspection          | Usage breakdown and previews for the system prompt, memory, skills, tools definition, and messages | `/context`                                      |
| Session/Subagent references | Search and inject effective context from previous Sessions or existing SubAgents          | `@`                                             |
| Status bar                  | Shows model, context, cache, cost, and git; also works with `@narumitw/pi-usage` for live quota. Git/cache Nerd Font icons can be turned off | `/ccstyle`                                      |
| Theme                       | Bundled CC Dark and CC Light themes                                                       | `/theme`                                        |

Renderer snapshots for `on` / `compact` modes: [default](./docs/tool-render-examples-default.md) · [compact](./docs/tool-render-examples-compact.md)

## Configuration

`/ccstyle` behavior is configured through `~/.pi/agent/pi-cc-extensions.json`:

```jsonc
{
  // style
  "mode": "on",                            // on / compact / off
  "excludeRenderers": [],                  // tools keeping the native renderer; Agent always keeps its dedicated renderer
  "mcpGatewayServerIdExtraction": false,   // extract the MCP server from `mcp` gateway calls for titles; off = MCP

  // features
  "enableSessionReference": true,          // @ session references
  "enableSubagentAutocomplete": true,      // @ subagent completion and delegation hints
  "enableContextCommand": true,            // /context usage check
  "enableAgentSummary": true,              // per-turn tool summary
  "enableWorkingMessage": true,            // Working... bottom token/elapsed
  "enableAliases": true,                   // /clear, /exit aliases

  // ui
  "expandedInputMaxLines": 5,              // expanded tool Input lines; overflow shows a footer hint
  "expandedOutputMaxLines": 10,            // expanded tool Output lines; overflow shows a footer hint
  "expandedPreviewMaxLines": 40,           // max lines for expanded diff/TaskList bodies
  "inputClip": 100,                        // tool summary path/command clip length
  "showStartupHeader": true,               // startup header (logo + tips) toggle
  "scrollStepLines": 3,                    // fullscreen wheel scroll step

  // diff
  "diffViewMode": "auto",                  // layout: auto / split / unified
  "diffIndicatorMode": "bars",             // change indicators: bars / classic / none
  "diffSplitMinWidth": 120,                // min terminal width for side-by-side columns
  "editDiffCollapsedLines": 24,            // Edit collapse lines; beyond that shows the expand hint
  "writeDiffCollapsedLines": 0,            // write collapse lines; 0 = creation summary only
  "diffWordWrap": true,                    // wrap long diff lines

  // thinking
  "useSummaryTitlesAsThinkingTitle": true, // use latest summary as thinking title
  "previewLines": 3,                       // preview lines; 0 hides
  "animationIntervalMs": 90,               // title animation interval (ms)
  "dimThinkingText": false,                // dim thinking body text

  // footer
  "enableCustomFooter": true,              // custom status bar
  "footerNerdIcons": true,                 // Nerd Font glyphs for git/cache; false = plain text
  "footerHiddenKeys": [],                  // hidden plugin chip keys
  "footerLine1Keys": ["pi-usage"],         // line1 plugin chip order; pi-usage is shown by default, data from @narumitw/pi-usage
  "footerLine2Keys": [],                   // line2 plugin chip order (after cwd/git)
  "footerLine3Keys": []                    // line3 overflow slot; painted only when a chip is visible
}
```

> [!TIP]
> **Fullscreen**: click `click to show more` to expand tool cards, thinking, Skill, and compact summaries. When expanded Input/Output exceeds the line cap, the footer `… +N more lines • click to show more` opens a full preview. Double-click an expanded panel to collapse it.

> [!NOTE]
> **Mermaid rendering**: set `markdown.mermaid` to `final` via `~/.pi/agent/settings.json` or the Mermaid diagrams option in `/settings`. Default `streaming` redraws per frame; `final` renders once at completion.

## Local development

```bash
npm test
npm run typecheck
./test.bat # or pi -e .
```

## Compatibility

- Node.js `>=22.19.0`, Pi `^0.84.0`

## Recommended companions

| Extension                                | Purpose                                                      |
| ---------------------------------------- | ------------------------------------------------------------ |
| `npm:@tintinweb/pi-subagents`            | Parallel SubAgents, background tasks, and worktree isolation |
| `npm:@tintinweb/pi-tasks`                | Claude Code-style task tracking and coordination             |
| `npm:pi-mcp-adapter`                     | On-demand MCP tool discovery with lower context usage        |
| `npm:@ff-labs/pi-fff`                    | FFF-powered fuzzy file and content search (fffind / ffgrep)  |
| `npm:pi-web-access`                      | Web search, URL fetching, GitHub cloning, PDF/video parsing  |
| `npm:@narumitw/pi-usage`                 | Current-account usage for Codex / Copilot / OpenRouter       |

## Credits

- Rich diffs are adapted from [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) (MIT). See [`extensions/renderer/tool/diff/ATTRIBUTION.md`](./extensions/renderer/tool/diff/ATTRIBUTION.md).

## License

[MIT](./LICENSE) © minuque
