// Frankfurter v2: https://frankfurter.dev/#rate
// Mid-market rates are indicative, not the exchange rate charged by a bank.
type FetchRate = (url: string, init: RequestInit) => Promise<Response>;

function formatCurrency(amount: number, currency: string): string {
	// Preserve the existing USD display exactly for the default configuration.
	if (currency === "USD") return `$${amount.toFixed(2)}`;
	return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
}

export class FooterCurrencyConverter {
	private readonly rates = new Map<string, number>();
	private readonly requests = new Map<string, Promise<void>>();
	private readonly fetchRate: FetchRate;

	constructor(fetchRate: FetchRate = fetch) {
		this.fetchRate = fetchRate;
	}

	/** Fetch each source-target rate once per runtime; never block footer rendering. */
	load(sourceCurrency: string, targetCurrency: string): Promise<void> {
		if (sourceCurrency === targetCurrency) return Promise.resolve();
		const pair = `${sourceCurrency}:${targetCurrency}`;
		const previous = this.requests.get(pair);
		if (previous) return previous;
		const request = (async (): Promise<boolean> => {
			try {
				const response = await this.fetchRate(
					`https://api.frankfurter.dev/v2/rate/${sourceCurrency.toLowerCase()}/${targetCurrency.toLowerCase()}`,
					{ signal: AbortSignal.timeout(5_000) },
				);
				if (!response.ok) return false;
				const data: unknown = await response.json();
				if (!data || typeof data !== "object") return false;
				const { base, quote, rate } = data as Record<string, unknown>;
				if (
					base !== sourceCurrency ||
					quote !== targetCurrency ||
					typeof rate !== "number" ||
					!Number.isFinite(rate) ||
					rate <= 0
				)
					return false;
				this.rates.set(pair, rate);
				return true;
			} catch {
				// No usable rate: keep and label the original source-currency amount.
				return false;
			}
		})().then((success) => {
			// Cache successes, but allow a later footer initialization to retry failures.
			if (!success) this.requests.delete(pair);
		});
		this.requests.set(pair, request);
		return request;
	}

	format(cost: number, sourceCurrency: string, targetCurrency: string): string {
		if (sourceCurrency === targetCurrency) return formatCurrency(cost, sourceCurrency);
		const rate = this.rates.get(`${sourceCurrency}:${targetCurrency}`);
		if (rate === undefined) return formatCurrency(cost, sourceCurrency);
		return `≈${formatCurrency(cost * rate, targetCurrency)}`;
	}
}
