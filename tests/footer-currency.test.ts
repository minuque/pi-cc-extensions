import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../extensions/config/config.ts";
import { FooterCurrencyConverter } from "../extensions/feature/shell/footer-currency.ts";

test("currency settings default to USD and normalize ISO codes", () => {
	const defaults = normalizeConfig({});
	assert.equal(defaults.footerCurrency, "USD");
	assert.equal(defaults.footerCurrencySource, "USD");
	assert.equal(normalizeConfig({ footerCurrency: " inr " }).footerCurrency, "INR");
	assert.equal(normalizeConfig({ footerCurrency: "eur" }).footerCurrency, "EUR");
	assert.equal(normalizeConfig({ footerCurrency: "INR/../../bad" }).footerCurrency, "USD");
	assert.equal(normalizeConfig({ footerCurrency: 42 }).footerCurrency, "USD");
	assert.equal(normalizeConfig({ footerCurrencySource: " eur " }).footerCurrencySource, "EUR");
	assert.equal(
		normalizeConfig({ footerCurrencySource: "INR/../../bad" }).footerCurrencySource,
		"USD",
	);
	assert.equal(normalizeConfig({ footerCurrencySource: 42 }).footerCurrencySource, "USD");
});

test("same source and target currency formats natively without a rate request", async () => {
	let calls = 0;
	const converter = new FooterCurrencyConverter(async () => {
		calls++;
		throw new Error("same-currency display must not fetch");
	});
	await converter.load("EUR", "EUR");
	assert.equal(converter.format(12.34, "EUR", "EUR"), "€12.34");
	assert.equal(converter.format(12.34, "USD", "USD"), "$12.34");
	assert.equal(calls, 0);
});

test("loads and caches each source-target rate and formats estimated conversions", async () => {
	const requests: string[] = [];
	const converter = new FooterCurrencyConverter(async (url) => {
		requests.push(url);
		const parts = new URL(url).pathname.split("/");
		const base = parts.at(-2) ?? "";
		const quote = parts.at(-1) ?? "";
		return new Response(
			JSON.stringify({ base: base.toUpperCase(), quote: quote.toUpperCase(), rate: 95.68 }),
		);
	});
	assert.equal(converter.format(0.76, "USD", "INR"), "$0.76");
	await Promise.all([converter.load("USD", "INR"), converter.load("USD", "INR")]);
	assert.deepEqual(requests, ["https://api.frankfurter.dev/v2/rate/usd/inr"]);
	assert.equal(converter.format(0.76, "USD", "INR"), "≈₹72.72");
	assert.equal(converter.format(1_000, "USD", "INR"), "≈₹95,680.00");
	await converter.load("EUR", "INR");
	assert.deepEqual(requests, [
		"https://api.frankfurter.dev/v2/rate/usd/inr",
		"https://api.frankfurter.dev/v2/rate/eur/inr",
	]);
	assert.equal(converter.format(2, "EUR", "INR"), "≈₹191.36");
	await converter.load("USD", "EUR");
	assert.equal(converter.format(1, "USD", "EUR"), "≈€95.68");
});

test("failed request falls back to the source currency and retries next initialization", async () => {
	let calls = 0;
	const converter = new FooterCurrencyConverter(async () => {
		calls++;
		return calls === 1
			? new Response("unavailable", { status: 503 })
			: new Response(JSON.stringify({ base: "EUR", quote: "INR", rate: 95.68 }));
	});
	await Promise.all([converter.load("EUR", "INR"), converter.load("EUR", "INR")]);
	assert.equal(calls, 1);
	assert.equal(converter.format(1, "EUR", "INR"), "€1.00");
	await converter.load("EUR", "INR");
	assert.equal(calls, 2);
	assert.equal(converter.format(1, "EUR", "INR"), "≈₹95.68");
	await converter.load("EUR", "INR");
	assert.equal(calls, 2);
});

test("failed, invalid, and nonpositive rates preserve the source currency", async () => {
	for (const response of [
		new Response("unavailable", { status: 503 }),
		new Response(JSON.stringify({ base: "USD", quote: "INR", rate: 95 })),
		new Response(JSON.stringify({ base: "EUR", quote: "INR", rate: -1 })),
	]) {
		const converter = new FooterCurrencyConverter(async () => response);
		await converter.load("EUR", "INR");
		assert.equal(converter.format(1, "EUR", "INR"), "€1.00");
	}
	const converter = new FooterCurrencyConverter(async () => {
		throw new Error("offline");
	});
	await converter.load("EUR", "INR");
	assert.equal(converter.format(1, "EUR", "INR"), "€1.00");
	assert.equal(converter.format(1, "USD", "INR"), "$1.00");
});
