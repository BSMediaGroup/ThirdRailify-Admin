import { Link } from "react-router-dom";
import { AdminIcon } from "../components/AdminIcon";
import { StateSamples } from "../components/StateSamples";
import type { AdminArea } from "../config/navigation";

export function AreaPage({ area }: { area: AdminArea }) {
  return (
    <>
      <section className="area-heading">
        <div className="area-icon"><AdminIcon name={area.icon} size={28} /></div>
        <div><p className="eyebrow">Future workspace</p><h1>{area.label}</h1><p>{area.summary}</p></div>
        <span className="tag tag--muted">Not connected</span>
      </section>

      <section className="placeholder-panel" aria-labelledby="future-scope-title">
        <div className="placeholder-graphic" aria-hidden="true"><span /><span /><span /></div>
        <div>
          <p className="eyebrow">Deliberate boundary</p>
          <h2 id="future-scope-title">Structure first. Authority next.</h2>
          <p>This route establishes navigation, layout, responsive behavior, and honest state language only. It contains no real records or write controls.</p>
          <ul>
            {area.futureScope.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      </section>

      <div className="gate-card">
        <div><AdminIcon name="shield" /><span>Required before implementation</span></div>
        <p>Approved authority, authenticated server boundary, least-privilege permissions, audit trail, and feature-specific acceptance criteria.</p>
      </div>

      <StateSamples />
      <Link className="back-link" to="/"><AdminIcon name="arrow" size={16} /> Return to overview</Link>
    </>
  );
}
