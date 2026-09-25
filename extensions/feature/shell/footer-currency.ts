// Frankfurter v2: https://frankfurter.dev/#rate
// Mid-market rates are indicative, not the exchange rate charged by a bank.
type FetchRate = (url: string, init: RequestInit) => Promise<Response>;

export class FooterCurrencyConverter {
	private readonly rates = new Map<string, number>();
	private readonly requests = new Map<string, Promise<void>>();
	private readonly fetchRate: FetchRate;

	constructor(fetchRate: FetchRate = fetch) {
		this.fetchRate = fetchRate;
	}

	/** Fetch once per currency per runtime; never block footer rendering. */
	load(currency: string): Promise<void> {
		if (currency === "USD") return Promise.resolve();
		const previous = this.requests.get(currency);
		if (previous) return previous;
		const request = (async () => {
			try {
				const response = await this.fetchRate(
					`https://api.frankfurter.dev/v2/rate/usd/${currency.toLowerCase()}`,
					{ signal: AbortSignal.timeout(5_000) },
				);
				if (!response.ok) return;
				const data: unknown = await response.json();
				if (!data || typeof data !== "object") return;
				const { base, quote, rate } = data as Record<string, unknown>;
				if (
					base === "USD" &&
					quote === currency &&
					typeof rate === "number" &&
					Number.isFinite(rate) &&
					rate > 0
				) {
					this.rates.set(currency, rate);
				}
			} catch {
				// No usable rate: keep the original USD display, not a mislabeled conversion.
			}
		})();
		this.requests.set(currency, request);
		return request;
	}

	format(costUsd: number, currency: string): string {
		const rate = this.rates.get(currency);
		if (currency === "USD" || rate === undefined) return `$${costUsd.toFixed(2)}`;
		return `≈${new Intl.NumberFormat("en", { style: "currency", currency }).format(costUsd * rate)}`;
	}
}
