import assert from "node:assert/strict";
import test from "node:test";
import { ADDRESS_GEOGRAPHY_DATASET, countryName, countryOptions, formatGeography, normalizeCountry, normalizeRegion, regionName, regionOptions } from "../src/address/geography.ts";

test("Admin geography matches Address UX V2 canonical data", () => {
  assert.equal(ADDRESS_GEOGRAPHY_DATASET, "country-region-data@4.1.0");
  assert.equal(countryOptions().length, 249);
  assert.equal(normalizeCountry("Canada"), "CA");
  assert.equal(normalizeRegion("ca", "Ontario"), "ON");
  assert.equal(countryName("CA"), "Canada");
  assert.equal(regionName("CA", "ON"), "Ontario");
  assert.equal(formatGeography("Thamesford", "ON", "CA"), "Thamesford, Ontario, Canada");
  assert.deepEqual(regionOptions("AQ"), []);
});
