import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config/config.ts";

// shell
import piAliases from "./feature/shell/aliases.ts";
import { installFlushDockedBash } from "./feature/shell/flush-docked-bash.ts";
import customFooter from "./feature/shell/footer.ts";
import { applyPromptEditor } from "./feature/shell/prompt-editor.ts";
import piStartupHeader, { installEarlyStartupHeader } from "./feature/shell/startup-header.ts";
import workingMessage from "./feature/shell/working-message.ts";

// feature
import agentAutocomplete from "./feature/reference/subagent.ts";
import agentSummary from "./feature/agent-summary/index.ts";
import context from "./feature/context.ts";
import sessionReference from "./feature/reference/index.ts";
import { installCompactThinking } from "./feature/compact-thinking.ts";

// renderer
import claudeCodeStyle, { getCompactThinkingConfig } from "./renderer/index.ts";
import markdownEnhance from "./renderer/markdown-enhance.ts";
import tableCopy from "./renderer/table-copy.ts";

export default function (pi: ExtensionAPI): void {
	// shell chrome
	if (config.enableAliases) piAliases(pi);
	installFlushDockedBash();
	installEarlyStartupHeader();
	piStartupHeader(pi);
	if (config.enableWorkingMessage) workingMessage(pi);
	customFooter(pi);

	// 输入框 ❯ 提示符：session_start 时按配置应用；setEditorComponent 是一次性替换。
	pi.on("session_start", (_event, ctx) => {
		applyPromptEditor(ctx);
	});

	// render stack：thinking controller 直接交给 style 作 query
	// markdownEnhance 单独开关：其他扩展也注册 transformer 时会互相改写输出。
	if (config.enableMarkdownEnhance) markdownEnhance(pi);
	if (config.enableTableCopy) tableCopy(pi);
	claudeCodeStyle(pi, undefined, installCompactThinking(pi, getCompactThinkingConfig()));

	// features
	if (config.enableContextCommand) context(pi);
	if (config.enableSessionReference) sessionReference(pi);
	if (config.enableSubagentAutocomplete) agentAutocomplete(pi);
	if (config.enableAgentSummary) agentSummary(pi);
}
