import { countryName, countryOptions, isKnownCountry, isKnownRegion, normalizeCountry, normalizeRegion, regionLabel, regionOptions } from "../address/geography";

type Props = {
  countryCode: string;
  region: string;
  onCountryChange: (value: string) => void;
  onRegionChange: (value: string) => void;
  countryError?: string;
  regionError?: string;
  idPrefix: string;
};

export function CountryRegionFields({ countryCode, region, onCountryChange, onRegionChange, countryError, regionError, idPrefix }: Props) {
  const canonicalCountry = normalizeCountry(countryCode);
  const canonicalRegion = normalizeRegion(canonicalCountry, region);
  const regions = regionOptions(canonicalCountry);
  const unknownCountry = Boolean(countryCode) && !isKnownCountry(countryCode);
  const unknownRegion = Boolean(region) && regions.length > 0 && !isKnownRegion(canonicalCountry, region);
  const countryErrorId = `${idPrefix}-country-error`;
  const regionErrorId = `${idPrefix}-region-error`;
  const legacyId = `${idPrefix}-region-legacy`;
  const changeCountry = (next: string) => {
    const normalizedCountry = normalizeCountry(next);
    const nextRegions = regionOptions(normalizedCountry);
    const retained = nextRegions.some((option) => option.code === canonicalRegion) ? canonicalRegion : "";
    onCountryChange(normalizedCountry);
    if (retained !== region) onRegionChange(retained);
  };
  return <div className="country-region-fields">
    <div className={`commerce-field${countryError ? " has-error" : ""}`}>
      <label htmlFor={`${idPrefix}-country`}>Country</label>
      <select id={`${idPrefix}-country`} value={canonicalCountry} onChange={(event) => changeCountry(event.target.value)} autoComplete="country" aria-invalid={Boolean(countryError)} aria-describedby={countryError ? countryErrorId : undefined}>
        {!canonicalCountry && <option value="">Choose a country</option>}
        {unknownCountry && <option value={canonicalCountry}>{countryName(countryCode)} (legacy value)</option>}
        {countryOptions().map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
      </select>
      {countryError && <small id={countryErrorId} className="commerce-field__error" role="alert">{countryError}</small>}
    </div>
    <div className={`commerce-field${regionError ? " has-error" : ""}`}>
      <label htmlFor={`${idPrefix}-region`}>{regionLabel(canonicalCountry)}</label>
      <select id={`${idPrefix}-region`} value={regions.length ? canonicalRegion : ""} onChange={(event) => onRegionChange(event.target.value)} autoComplete="address-level1" disabled={!regions.length} aria-invalid={Boolean(regionError)} aria-describedby={[regionError ? regionErrorId : "", unknownRegion ? legacyId : ""].filter(Boolean).join(" ") || undefined}>
        <option value="">{regions.length ? `Choose ${regionLabel(canonicalCountry).toLowerCase()}` : "Not applicable"}</option>
        {unknownRegion && <option value={canonicalRegion}>{region} (legacy value)</option>}
        {regions.map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}
      </select>
      {unknownRegion && <small id={legacyId} className="geography-field__notice">This saved region is not in the current country dataset. It will be preserved unless you choose another value.</small>}
      {regionError && <small id={regionErrorId} className="commerce-field__error" role="alert">{regionError}</small>}
    </div>
  </div>;
}
