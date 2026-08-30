import { flagSource, normalizeCountryCode } from "./countryFlags";

export function CountryFlag({ countryCode }: { countryCode: string | null | undefined }) {
  const code = normalizeCountryCode(countryCode);
  return (
    <img
      className="analytics-country-flag"
      src={flagSource(code)}
      alt=""
      aria-hidden="true"
      width="24"
      height="16"
      data-country-flag={code}
    />
  );
}
