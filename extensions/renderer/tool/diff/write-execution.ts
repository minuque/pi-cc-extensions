import { createWriteToolDefinition, type WriteOperations } from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";

export const MAX_COMPARABLE_WRITE_BYTES = 512_000;
export const MAX_WRITE_METADATA_ENTRIES = 100;

export type WriteExecutionMeta = {
	fileExistedBeforeWrite: boolean;
	previousContent?: string;
	diffUnavailableReason?: string;
};

export class WriteExecutionMetadataStore {
	readonly entries = new Map<string, WriteExecutionMeta>();

	set(toolCallId: string, metadata: WriteExecutionMeta): void {
		this.entries.delete(toolCallId);
		this.entries.set(toolCallId, metadata);
		while (this.entries.size > MAX_WRITE_METADATA_ENTRIES) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	get(toolCallId: unknown): WriteExecutionMeta | undefined {
		return typeof toolCallId === "string" ? this.entries.get(toolCallId) : undefined;
	}

	delete(toolCallId: string): void {
		this.entries.delete(toolCallId);
	}

	clear(): void {
		this.entries.clear();
	}
}

async function capturePreviousContent(absolutePath: string): Promise<WriteExecutionMeta> {
	let info;
	try {
		info = await lstat(absolutePath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return { fileExistedBeforeWrite: false };
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "unable to inspect the previous file",
		};
	}

	if (!info.isFile()) {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "previous path is not a regular file",
		};
	}
	if (info.size > MAX_COMPARABLE_WRITE_BYTES) {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: `previous file exceeds ${MAX_COMPARABLE_WRITE_BYTES} bytes`,
		};
	}

	try {
		const bytes = await readFile(absolutePath);
		const previousContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { fileExistedBeforeWrite: true, previousContent };
	} catch {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "previous file is not comparable UTF-8 text",
		};
	}
}

export async function executeWriteWithMetadata(
	store: WriteExecutionMetadataStore,
	toolCallId: string,
	params: { path: string; content: string },
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	store.delete(toolCallId);
	// 覆盖层只揽写前快照：路径解析（含 Windows 下 /mnt/<drive>、/cygdrive/<drive> 转换）、
	// 目录创建、mutation queue 与错误文案全交回 pi 官方 write，参数与官方逐字一致。
	const definition = createWriteToolDefinition(cwd, {
		operations: writeSnapshotOperations(store, toolCallId, signal),
	}) as any;
	try {
		await definition.execute(toolCallId, params, signal, undefined, { cwd });
		return writeSuccessResult(params);
	} catch (error) {
		// 文件已落盘，只是官方写后那次 abort 检查抦了错：保持「文件已改即成功」。
		if (store.get(toolCallId) && signal?.aborted) return writeSuccessResult(params);
		store.delete(toolCallId);
		throw error;
	}
}

/** 官方 write 的落盘操作：拿到的是官方解析后的绝对路径，快照才跟真实落盘一致。 */
function writeSnapshotOperations(
	store: WriteExecutionMetadataStore,
	toolCallId: string,
	signal: AbortSignal | undefined,
): WriteOperations {
	const throwIfAborted = () => {
		if (signal?.aborted) throw new Error("Operation aborted");
	};
	return {
		mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => {}),
		writeFile: async (absolutePath, content) => {
			store.delete(toolCallId);
			// 官方 abort 检查包住整次 operation，不进快照读盘。读前、读后各查一次：
			// 取消落在读盘期间或刚读完、真正落盘前时抛错，不写文件，也不留 metadata。
			throwIfAborted();
			const metadata = await capturePreviousContent(absolutePath);
			throwIfAborted();
			await writeFile(absolutePath, content, "utf8");
			// 写已生效：后续 abort 不得把这次写报成失败，快照先落下。
			store.set(toolCallId, metadata);
		},
	};
}

function writeSuccessResult(params: { path: string; content: string }): {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
} {
	return {
		content: [
			{
				type: "text",
				text: `Successfully wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${params.path}`,
			},
		],
		details: undefined,
	};
}
