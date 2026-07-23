const UNSAFE_TERMINAL_ESCAPE = new RegExp(
	"\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\x5C)"
	+ "|\\u001B[PX^_][\\s\\S]*?\\u001B\\x5C"
	+ "|(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]"
	+ "|\\u001B[@-_]",
	"g",
);

/** Prevent captured terminal control responses from being replayed by tool renderers. */
export function sanitizeToolResultText(value: string): string {
	return value
		.replace(UNSAFE_TERMINAL_ESCAPE, "")
		.replace(/\x1B/g, "")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}
