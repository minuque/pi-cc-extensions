#!/bin/sh
# 本地开发运行器（macOS/Linux）：临时用当前检出的目录替换 npm 安装的扩展，
# 退出后还原成进入前的状态。Windows 用 test.bat；只想跑一次且不改配置用 pi -e .。
# 用法：./test.sh [pi 的参数...]
set -u

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
npm_source='npm:pi-cc-extensions'

# pi 用 PI_CODING_AGENT_DIR 覆盖配置目录，默认 ~/.pi/agent
agent_dir=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
settings=$agent_dir/settings.json

# 配置里的包来源，一行一条；字符串项直接取，对象项取 source。
sources_script='
	const fs = require("node:fs");
	let raw = {};
	try {
		raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) ?? {};
	} catch {
		raw = {};
	}
	for (const item of Array.isArray(raw.packages) ? raw.packages : []) {
		const source = typeof item === "string" ? item : item?.source;
		if (typeof source === "string") console.log(source);
	}
'
configured_sources() {
	[ -f "$settings" ] || return 0
	node -e "$sources_script" "$settings"
}

# 进入前的状态，输出 "hadNpm hadLocal"。本地配置以相对 agentDir 的路径存储，
# 按词法绝对化比较（不解析符号链接），与 test.ps1 的 GetFullPath 口径一致。
detect_script='
	const fs = require("node:fs");
	const path = require("node:path");
	const [settings, agentDir, repoDir, npmSource] = process.argv.slice(1);
	if (!fs.existsSync(settings)) {
		console.log("0 0");
		process.exit(0);
	}
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(settings, "utf8"));
	} catch {
		console.error("invalid settings: " + settings);
		process.exit(1);
	}
	const sources = (Array.isArray(raw?.packages) ? raw.packages : [])
		.map((item) => (typeof item === "string" ? item : item?.source))
		.filter((source) => typeof source === "string");
	const isLocal = (source) => {
		if (source.startsWith("npm:")) return false;
		const candidate = path.resolve(agentDir, source);
		return fs.existsSync(candidate) && candidate === path.resolve(repoDir);
	};
	console.log(sources.includes(npmSource) ? 1 : 0, sources.some(isLocal) ? 1 : 0);
'

command -v node >/dev/null 2>&1 || {
	printf 'node not found in PATH\n' >&2
	exit 127
}
command -v pi >/dev/null 2>&1 || {
	printf 'pi not found in PATH\n' >&2
	exit 127
}

state=$(node -e "$detect_script" "$settings" "$agent_dir" "$repo_dir" "$npm_source") || exit 1
had_npm=${state%% *}
had_local=${state##* }

rollback_failed() {
	printf 'rollback failed: %s\n' "$1" >&2
	printf "run manually: pi install $npm_source\n" >&2
}

restore() {
	if [ "$had_local" -eq 0 ]; then
		if pi remove "$repo_dir" >/dev/null; then
			printf '[restore] remove temporary local extension\n'
		else
			rollback_failed "pi remove $repo_dir"
		fi
	fi
	if [ "$had_npm" -eq 1 ]; then
		if pi install "$npm_source" >/dev/null; then
			printf '[restore] restore %s\n' "$npm_source"
		else
			rollback_failed "pi install $npm_source"
		fi
	fi
	printf '[restore] packages: %s\n' "$(configured_sources | paste -sd, -)"
	if [ "$had_npm" -eq 0 ] && [ "$had_local" -eq 0 ]; then
		printf "[restore] note: $npm_source was not configured before; run 'pi install $npm_source' to restore a normal install\n"
	fi
}

cd "$repo_dir" || exit 1
trap restore EXIT

if [ "$had_npm" -eq 1 ]; then
	if ! pi remove "$npm_source" >/dev/null; then
		printf 'failed: pi remove %s\n' "$npm_source" >&2
		exit 1
	fi
	printf '[swap] remove %s\n' "$npm_source"
fi
if ! pi install "$repo_dir" >/dev/null; then
	printf 'failed: pi install %s\n' "$repo_dir" >&2
	exit 1
fi
printf '[swap] load local extension %s\n' "$repo_dir"
configured_sources | while IFS= read -r source; do printf '[loaded] %s\n' "$source"; done

pi "$@"
status=$?
exit "$status"
