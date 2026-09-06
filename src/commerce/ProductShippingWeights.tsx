import { useEffect, useState } from "react";
import { adminApi } from "../auth/client";
import "../styles/shipping-rates.css";
type Weight = { id: string; variant_id: string | null; weight_mg: number | null; revision: number; provenance: string };
type Payload = { weights: Weight[]; variants: { id: string; sku: string; size_label: string; color_label: string }[] };
export function ProductShippingWeights({ productId, csrfToken, canManage }: { productId: string; csrfToken: string | null; canManage: boolean }) {
  const [data, setData] = useState<Payload | null>(null), [selected, setSelected] = useState<string[]>(["default"]), [value, setValue] = useState(""), [unit, setUnit] = useState("g"), [source, setSource] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const path = `/api/admin/commerce/products/${encodeURIComponent(productId)}/shipping-weights`;
  useEffect(() => { let active = true; adminApi<Payload>(path).then(p => { if (active) setData(p); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [path]);
  async function save(clear: boolean) {
    setBusy(true); setError("");
    try { const assignments = selected.map(id => ({ variantId: id === "default" ? null : id, revision: data?.weights.find(w => w.variant_id === (id === "default" ? null : id))?.revision || 0, value: clear ? null : value, unit, provenance: source })); setData(await adminApi<Payload>(path, { method: "POST", headers: { "X-CSRF-Token": csrfToken || "" }, body: JSON.stringify({ assignments }) })); setValue(""); setSource(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Weight update failed."); } finally { setBusy(false); }
  }
  const defaultWeight = data?.weights.find(w => w.variant_id === null);
  return <section className="shipping-rates shipping-weights" aria-label="Product shipping weights"><h3>Shipping weights</h3><p>Variant override → product default → missing. Units are explicit; sources are retained independently of provider refresh.</p>{error && <p role="alert">{error}</p>}{data && <>
    <p>Product default: {defaultWeight?.weight_mg ? `${defaultWeight.weight_mg / 1000} g · ${defaultWeight.provenance}` : "Missing"}</p>
    <fieldset disabled={!canManage || busy}><legend>Assign weight to selected records</legend><label><input type="checkbox" checked={selected.includes("default")} onChange={e => setSelected(s => e.target.checked ? [...s, "default"] : s.filter(v => v !== "default"))} />Product default</label><div className="shipping-actions"><button type="button" onClick={() => setSelected(data.variants.map(v => v.id))}>Select all variants</button><button type="button" onClick={() => setSelected([])}>Clear selection</button></div>
    <div className="shipping-destinations">{data.variants.map(v => { const w = data.weights.find(w => w.variant_id === v.id); return <label key={v.id}><input type="checkbox" checked={selected.includes(v.id)} onChange={e => setSelected(s => e.target.checked ? [...s, v.id] : s.filter(id => id !== v.id))} /><span>{[v.size_label, v.color_label, v.sku].filter(Boolean).join(" / ")}<br />{w?.weight_mg ? `Override: ${w.weight_mg / 1000} g · ${w.provenance}` : defaultWeight?.weight_mg ? `Inherited: ${defaultWeight.weight_mg / 1000} g` : "Missing weight"}</span></label>; })}</div>
    <div className="shipping-fields"><label>Shipping weight<input inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} /></label><label>Unit<select value={unit} onChange={e => setUnit(e.target.value)}><option value="g">Grams</option><option value="kg">Kilograms</option><option value="mg">Milligrams</option></select></label><label>Source / provenance<input maxLength={500} value={source} onChange={e => setSource(e.target.value)} placeholder="e.g. Measured packed variant, date" /></label></div><p>{selected.length} explicit assignments. Blank or unknown weight is never zero.</p><div className="shipping-actions"><button type="button" disabled={!selected.length || !value || !source || !csrfToken} onClick={() => void save(false)}>Save shipping weights</button><button type="button" disabled={!selected.length || !source || !csrfToken} onClick={() => void save(true)}>Clear selected overrides / default</button></div>
    </fieldset></>}</section>;
}
