import { allCountries } from "country-region-data";

export const ADDRESS_GEOGRAPHY_DATASET = "country-region-data@4.1.0";

export type GeographyOption = { code: string; name: string };

const collator = new Intl.Collator("en", { sensitivity: "base" });
const countries: GeographyOption[] = allCountries
  .map(([name, code]) => ({ code, name }))
  .sort((left, right) => collator.compare(left.name, right.name));
const countryByCode = new Map<string, GeographyOption>(countries.map((country) => [country.code, country]));
const countryByName = new Map<string, GeographyOption>(countries.map((country) => [fold(country.name), country]));
const regionsByCountry = new Map<string, GeographyOption[]>(allCountries.map(([countryName, countryCode, regions]) => {
  const options = regions.map(([name, code]) => ({ code, name })).sort((left, right) => collator.compare(left.name, right.name));
  const applicable = options.length === 1 && (fold(options[0].name) === fold(countryName) || options[0].code === countryCode) ? [] : options;
  return [countryCode, applicable] as const;
}));

export function countryOptions(allowedCodes?: readonly string[]) {
  if (!allowedCodes) return countries;
  const allowed = new Set(allowedCodes.map((code) => code.trim().toUpperCase()));
  return countries.filter((country) => allowed.has(country.code));
}

export function regionOptions(countryValue: string) { return regionsByCountry.get(normalizeCountry(countryValue)) || []; }

export function normalizeCountry(value: string) {
  const text = String(value || "").trim();
  if (!text) return "";
  return countryByCode.get(text.toUpperCase())?.code || countryByName.get(fold(text))?.code || text.toUpperCase();
}

export function normalizeRegion(countryValue: string, value: string) {
  const text = String(value || "").trim();
  if (!text) return "";
  const options = regionOptions(countryValue);
  return options.find((region) => region.code.toUpperCase() === text.toUpperCase() || fold(region.name) === fold(text))?.code || text;
}

export function countryName(value: string) {
  const code = normalizeCountry(value);
  return countryByCode.get(code)?.name || String(value || "").trim();
}

export function regionName(countryValue: string, value: string) {
  const normalized = normalizeRegion(countryValue, value);
  return regionOptions(countryValue).find((region) => region.code === normalized)?.name || String(value || "").trim();
}

export function isKnownCountry(value: string) { return countryByCode.has(normalizeCountry(value)); }
export function isKnownRegion(countryValue: string, value: string) { return !value || regionOptions(countryValue).some((region) => region.code === normalizeRegion(countryValue, value)); }

export function regionLabel(countryValue: string) {
  const country = normalizeCountry(countryValue);
  if (country === "CA") return "Province / territory";
  if (country === "US" || country === "AU") return "State / territory";
  return "State / province / region";
}

export function postalLabel(countryValue: string) {
  const country = normalizeCountry(countryValue);
  if (country === "US") return "ZIP code";
  if (country === "GB" || country === "AU") return "Postcode";
  return "Postal code";
}

export function formatGeography(city: string, region: string | null | undefined, country: string) {
  return [city, region ? regionName(country, region) : "", countryName(country)].filter(Boolean).join(", ");
}

function fold(value: string) { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("en"); }
