interface CoreContextUsage {
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readCoreContextUsage(ctx: unknown): CoreContextUsage | null {
  if (!isRecord(ctx) || typeof ctx.getContextUsage !== "function") {
    return null;
  }

  const usage = ctx.getContextUsage();
  if (!isRecord(usage)) {
    return null;
  }

  const tokens = usage.tokens;
  const contextWindow = usage.contextWindow;
  if (
    (tokens !== null && (typeof tokens !== "number" || !Number.isFinite(tokens)))
    || typeof contextWindow !== "number"
    || !Number.isFinite(contextWindow)
    || contextWindow <= 0
  ) {
    return null;
  }

  // pi intentionally reports null immediately after compaction. Preserve that
  // state instead of falling back to the last pre-compaction assistant usage.
  if (tokens === null) {
    return { contextTokens: null, contextWindow, contextPercent: null };
  }

  const percent = usage.percent;
  return {
    contextTokens: tokens,
    contextWindow,
    contextPercent: typeof percent === "number" && Number.isFinite(percent)
      ? percent
      : (tokens / contextWindow) * 100,
  };
}
