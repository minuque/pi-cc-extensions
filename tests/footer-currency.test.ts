import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../extensions/config/config.ts";
import { FooterCurrencyConverter } from "../extensions/feature/shell/footer-currency.ts";

test("currency setting defaults to USD and normalizes ISO codes", () => {
	assert.equal(normalizeConfig({}).footerCurrency, "USD");
	assert.equal(normalizeConfig({ footerCurrency: " inr " }).footerCurrency, "INR");
	assert.equal(normalizeConfig({ footerCurrency: "eur" }).footerCurrency, "EUR");
	assert.equal(normalizeConfig({ footerCurrency: "INR/../../bad" }).footerCurrency, "USD");
	assert.equal(normalizeConfig({ footerCurrency: 42 }).footerCurrency, "USD");
});

test("loads one rate per currency and formats estimated conversion", async () => {
	const requests: string[] = [];
	const converter = new FooterCurrencyConverter(async (url) => {
		requests.push(url);
		const quote = url.split("/").at(-1)?.toUpperCase();
		return new Response(
			JSON.stringify({ base: "USD", quote, rate: quote === "INR" ? 95.68 : 0.87431 }),
		);
	});
	assert.equal(converter.format(0.76, "INR"), "$0.76");
	await Promise.all([converter.load("INR"), converter.load("INR")]);
	assert.deepEqual(requests, ["https://api.frankfurter.dev/v2/rate/usd/inr"]);
	assert.equal(converter.format(0.76, "INR"), "≈₹72.72");
	assert.equal(converter.format(1_000, "INR"), "≈₹95,680.00");
	await converter.load("EUR");
	assert.match(converter.format(1, "EUR"), /^≈.*€/);
	await converter.load("USD");
	assert.equal(requests.length, 2);
	assert.equal(converter.format(0.76, "USD"), "$0.76");
});

test("failed, invalid, and nonpositive rates preserve USD display", async () => {
	for (const response of [
		new Response("unavailable", { status: 503 }),
		new Response(JSON.stringify({ base: "USD", quote: "EUR", rate: 95 })),
		new Response(JSON.stringify({ base: "USD", quote: "INR", rate: -1 })),
	]) {
		const converter = new FooterCurrencyConverter(async () => response);
		await converter.load("INR");
		assert.equal(converter.format(1, "INR"), "$1.00");
	}
	const converter = new FooterCurrencyConverter(async () => {
		throw new Error("offline");
	});
	await converter.load("INR");
	assert.equal(converter.format(1, "INR"), "$1.00");
});
