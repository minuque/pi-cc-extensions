import assert from "node:assert/strict";
import test from "node:test";
import { formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";
import {
	formatFooterCost,
	presetFooterCurrencyRate,
} from "../extensions/feature/shell/footer-currency.ts";

test("currency settings default to USD and no rate", () => {
	const defaults = normalizeConfig({});
	assert.equal(defaults.footerCurrency, "USD");
	assert.equal(defaults.footerCurrencyRate, null);
	assert.match(formatConfigStatus(defaults), /footerCurrency=USD/);
	assert.match(formatConfigStatus(defaults), /footerRate=-/);
});

test("currency code normalizes to three uppercase letters", () => {
	assert.equal(normalizeConfig({ footerCurrency: " cny " }).footerCurrency, "CNY");
	assert.equal(normalizeConfig({ footerCurrency: "eur" }).footerCurrency, "EUR");
	assert.equal(normalizeConfig({ footerCurrency: "INR/../../bad" }).footerCurrency, "USD");
	assert.equal(normalizeConfig({ footerCurrency: 42 }).footerCurrency, "USD");
	assert.equal(normalizeConfig({ footerCurrency: "US" }).footerCurrency, "USD");
});

test("currency rate keeps positive numbers and drops everything else", () => {
	assert.equal(normalizeConfig({ footerCurrencyRate: 7.12 }).footerCurrencyRate, 7.12);
	assert.equal(normalizeConfig({ footerCurrencyRate: " 7.12 " }).footerCurrencyRate, 7.12);
	assert.equal(normalizeConfig({ footerCurrencyRate: 0 }).footerCurrencyRate, null);
	assert.equal(normalizeConfig({ footerCurrencyRate: -1 }).footerCurrencyRate, null);
	assert.equal(normalizeConfig({ footerCurrencyRate: "" }).footerCurrencyRate, null);
	assert.equal(normalizeConfig({ footerCurrencyRate: "no" }).footerCurrencyRate, null);
	assert.match(
		formatConfigStatus(normalizeConfig({ footerCurrencyRate: 7.12 })),
		/footerRate=7\.12/,
	);
});

test("preset rates follow the currency and are empty otherwise", () => {
	assert.equal(presetFooterCurrencyRate("cny"), 7.12);
	assert.equal(presetFooterCurrencyRate(" EUR "), 0.92);
	assert.equal(presetFooterCurrencyRate("JPY"), 150);
	assert.equal(presetFooterCurrencyRate("USD"), null);
	assert.equal(presetFooterCurrencyRate("CHF"), null);
});

test("USD keeps the dollar text and a missing rate only changes the symbol", () => {
	assert.equal(formatFooterCost(0.76, "USD", null), "$0.76");
	assert.equal(formatFooterCost(0.76, "USD", 7.12), "$0.76");
	assert.equal(formatFooterCost(0.76, "CNY", null), "CN¥0.76");
	assert.equal(formatFooterCost(1000, "USD", null), "$1000.00");
});

test("a positive rate formats an approximate localized amount", () => {
	assert.equal(formatFooterCost(0.76, "CNY", 7.12), "≈CN¥5.41");
	assert.equal(formatFooterCost(1000, "CNY", 7.12), "≈CN¥7,120.00");
	assert.equal(formatFooterCost(1, "EUR", 0.92), "≈€0.92");
	assert.equal(formatFooterCost(1, "JPY", 150), "≈¥150");
	assert.equal(formatFooterCost(1, "CHF", 1.5), "≈CHF\u00a01.50");
});

test("an unsupported currency keeps the original dollar text", () => {
	assert.equal(formatFooterCost(0.76, "XYZ", 7.12), "$0.76");
	assert.equal(formatFooterCost(0.76, "RMB", 7.12), "$0.76");
});
