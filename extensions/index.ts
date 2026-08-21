import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config/config.ts";

// shell
import piAliases from "./feature/shell/aliases.ts";
import piStartupHeader from "./feature/shell/startup-header.ts";
import workingMessage from "./feature/shell/working-message.ts";

// feature
import agentAutocomplete from "./feature/reference/subagent.ts";
import agentSummary from "./feature/agent-summary/index.ts";
import context from "./feature/context.ts";
import sessionReference from "./feature/reference/index.ts";
import { installCompactThinking } from "./feature/compact-thinking.ts";
import installThinkingTextDim from "./feature/thinking-text-dim.ts";

// renderer
import claudeCodeStyle, { getCompactThinkingConfig } from "./renderer/index.ts";
import markdownEnhance from "./renderer/markdown-enhance.ts";

export default function (pi: ExtensionAPI): void {
	// shell chrome
	if (config.enableAliases) piAliases(pi);
	piStartupHeader(pi);
	if (config.enableWorkingMessage) workingMessage(pi);

	// render stack：thinking controller 直接交给 style 作 query
	markdownEnhance(pi);
	claudeCodeStyle(pi, undefined, installCompactThinking(pi, getCompactThinkingConfig()));
	installThinkingTextDim(pi);

	// features
	if (config.enableContextCommand) context(pi);
	if (config.enableSessionReference) sessionReference(pi);
	if (config.enableSubagentAutocomplete) agentAutocomplete(pi);
	if (config.enableAgentSummary) agentSummary(pi);
}
