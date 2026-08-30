import australiaFlag from "../assets/flags/au.svg";
import canadaFlag from "../assets/flags/ca.svg";
import unitedStatesFlag from "../assets/flags/us.svg";
import unknownFlag from "../assets/flags/unknown.svg";

const flagSources: Record<string, string> = {
  AU: australiaFlag,
  CA: canadaFlag,
  US: unitedStatesFlag,
};

export function createCountryFlagElement(countryCode: string | null | undefined) {
  const code = normalizeCountryCode(countryCode);
  const image = document.createElement("img");
  image.className = "analytics-country-flag";
  image.src = flagSource(code);
  image.alt = "";
  image.width = 24;
  image.height = 16;
  image.setAttribute("aria-hidden", "true");
  image.dataset.countryFlag = code;
  return image;
}

export function flagSource(countryCode: string) {
  return flagSources[countryCode] || unknownFlag;
}

export function normalizeCountryCode(countryCode: string | null | undefined) {
  return String(countryCode || "unknown").trim().toUpperCase() || "UNKNOWN";
}
