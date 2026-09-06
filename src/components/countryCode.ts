import { allCountries } from "country-region-data";

const isoCountryCodes = new Set<string>(allCountries.map(([, code]) => code));

/** Only assigned ISO countries; aggregates and pseudo-codes remain neutral. */
export function normalizeCountryCode(value: string | null | undefined): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(code) && isoCountryCodes.has(code) ? code : "UNKNOWN";
}
