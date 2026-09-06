import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { allCountries } from "country-region-data";
import { normalizeCountryCode } from "../src/components/countryCode.ts";

test("country codes normalize only assigned ISO alpha-2 countries", () => {
  for (const code of ["US", "AU", "LV", "VN", "CA", "GB", "DE", "FR", "NZ", "JP", "BR", "ZA", "IN", "AX", "AQ", "BQ"]) {
    assert.equal(normalizeCountryCode(code), code);
    assert.equal(normalizeCountryCode(` ${code.toLowerCase()} `), code);
  }
  for (const code of [null, undefined, "", " ", "U", "USA", "U1", "1A", "ÅU", "🇺🇸", "ZZ", "XX", "UK", "EU", "UN", "T1", "GLOBAL", "UNKNOWN", "../us"]) {
    assert.equal(normalizeCountryCode(code), "UNKNOWN", String(code));
  }
});

test("every assigned ISO country has a local, nonempty SVG asset", async () => {
  assert.equal(allCountries.length, 249);
  for (const [, code] of allCountries) {
    assert.equal(normalizeCountryCode(code), code);
    const directory = ["US", "AU", "CA"].includes(code) ? "src/assets/flags" : "public/assets/country-flags";
    const file = new URL(`../${directory}/${code.toLowerCase()}.svg`, import.meta.url);
    assert.ok((await stat(file)).size > 0, code);
    const svg = await readFile(file, "utf8");
    assert.match(svg, /<svg\b/, code);
    assert.doesNotMatch(svg, /<script\b|<foreignObject\b|(?:href|src)=["']https?:/i, code);
  }
});
