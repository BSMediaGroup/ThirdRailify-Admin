import { normalizeOrigin } from "./auth-core.js";

export const THIRD_RAIL_BRAND = Object.freeze({
  name: "Third Railify Official",
  wordmark: "THIRD RAILIFY OFFICIAL",
  gold: "#f3c928",
  dark: "#11110e",
  page: "#080806",
  cream: "#f3f0e5",
  creamMuted: "#e8e3d4",
  ink: "#17160f",
  bodyFont: "'Blinker',Arial,Helvetica,sans-serif",
  displayFont: "'American Captain','Arial Narrow',Impact,sans-serif",
  monoFont: "'Geist Mono','Courier New',monospace",
});

export const THIRD_RAIL_EMAIL_ASSET_ORIGIN = "https://admin.thirdrailify.com";

export function thirdRailBrandAssets(origin) {
  const assetOrigin = normalizeOrigin(origin) || THIRD_RAIL_EMAIL_ASSET_ORIGIN;
  const root = `${assetOrigin}/email-assets`;
  return Object.freeze({
    root,
    logo: `${root}/trzapcolorcon.svg`,
    displayFont: `${root}/american-captain.ttf`,
    bodyFont: `${root}/blinker-regular.ttf`,
    bodySemiboldFont: `${root}/blinker-semibold.ttf`,
    monoFont: `${root}/geist-mono.ttf`,
  });
}

export function thirdRailFontFaceCss(origin) {
  const assets = thirdRailBrandAssets(origin);
  return `@font-face{font-family:'American Captain';src:url('${assets.displayFont}') format('truetype');font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:'Blinker';src:url('${assets.bodyFont}') format('truetype');font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:'Blinker';src:url('${assets.bodySemiboldFont}') format('truetype');font-weight:600;font-style:normal;font-display:swap}@font-face{font-family:'Geist Mono';src:url('${assets.monoFont}') format('truetype');font-weight:100 900;font-style:normal;font-display:swap}`;
}
