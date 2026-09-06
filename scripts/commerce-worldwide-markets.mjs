import {writeFileSync} from "node:fs";
import {worldwideShippingMarkets} from "../functions/_shared/shipping-core.js";
const path=process.argv[2];if(!path)throw new Error("Provide an output SQL path; this script makes no network call.");
const markets=worldwideShippingMarkets(), timestamp=new Date().toISOString();
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const rows=markets.map(m=>`(${quote(m.countryCode)},${quote(m.displayName)},'active','printful_dynamic',${quote(timestamp)},${quote(timestamp)},'operator-worldwide-instruction')`);
const sql=`-- Owner explicitly corrected Canada-only to worldwide on 2026-09-06.
-- Existing D1 market authority; no schema change or provider call.
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM commerce_launch_state WHERE state='active') THEN 1 ELSE json_extract('active_store_changed','$') END;
INSERT INTO commerce_shipping_markets(country_code,display_name,status,strategy,created_at,updated_at,updated_by_actor) VALUES
${rows.join(",\n")}
ON CONFLICT(country_code) DO UPDATE SET display_name=excluded.display_name,status='active',strategy='printful_dynamic',revision=commerce_shipping_markets.revision+1,updated_at=excluded.updated_at,updated_by_actor=excluded.updated_by_actor;
UPDATE commerce_shipping_markets SET status='disabled',revision=revision+1,updated_at=${quote(timestamp)},updated_by_actor='operator-worldwide-instruction' WHERE country_code IN ('RU','BY','CU','IR','SY','KP','VE');
INSERT INTO commerce_audit(id,actor_account_id,action,target_type,target_id,result,metadata_json,created_at) VALUES ('shipping-worldwide-20260906',NULL,'commerce.shipping_markets_configured','commerce_shipping_markets','worldwide','success',${quote(JSON.stringify({scope:'worldwide',enabledDestinations:markets.length,authority:'explicit_operator_instruction',providerCalls:0}))},${quote(timestamp)});
`;
writeFileSync(path,sql,{encoding:"utf8"});console.log(JSON.stringify({enabledDestinations:markets.length,sqlFile:path,providerCalls:0}));
