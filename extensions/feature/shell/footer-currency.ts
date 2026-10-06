const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

/** 底栏费用文本。USD、没有正数倍率、或不支持的币种保持原来的美元写法。 */
export function formatFooterCost(cost: number, currency: string, rate: number | null): string {
	const usd = `$${cost.toFixed(2)}`;
	if (currency === "USD" || rate === null || !KNOWN_CURRENCIES.has(currency)) return usd;
	const formatted = new Intl.NumberFormat("en", { style: "currency", currency }).format(
		cost * rate,
	);
	return `≈${formatted}`;
}
