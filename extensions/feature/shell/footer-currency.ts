const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

/** 1 美元费用对应的显示币种数量。面板切换币种时写入。 */
export const FOOTER_CURRENCY_RATES = {
	CNY: 7.12,
	EUR: 0.92,
	JPY: 150,
	GBP: 0.76,
	INR: 96.25,
	HKD: 7.78,
} as const;

export const FOOTER_CURRENCY_PRESETS = ["USD", ...Object.keys(FOOTER_CURRENCY_RATES)] as const;

/** 不在表里的币种，包括 USD，返回 null。 */
export function presetFooterCurrencyRate(currency: string): number | null {
	const code = currency.trim().toUpperCase();
	return FOOTER_CURRENCY_RATES[code as keyof typeof FOOTER_CURRENCY_RATES] ?? null;
}

/** 底栏费用文本。USD 或不支持的币种保持美元写法。没有倍率时只换符号。 */
export function formatFooterCost(cost: number, currency: string, rate: number | null): string {
	const usd = `$${cost.toFixed(2)}`;
	if (currency === "USD" || !KNOWN_CURRENCIES.has(currency)) return usd;
	const formatted = new Intl.NumberFormat("en", { style: "currency", currency }).format(
		rate === null ? cost : cost * rate,
	);
	return rate === null ? formatted : `≈${formatted}`;
}
