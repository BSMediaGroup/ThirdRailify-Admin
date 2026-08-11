import { Link } from "react-router-dom";
import { AdminIcon } from "../components/AdminIcon";
import { StateSamples } from "../components/StateSamples";

const boundaries = [
  { label: "Authentication", state: "Not implemented", tone: "blocked" },
  { label: "API connections", state: "None configured", tone: "muted" },
  { label: "Write operations", state: "Disabled", tone: "blocked" },
  { label: "Sensitive data", state: "None present", tone: "safe" },
];

const nextSteps = [
  ["01", "Define authority", "Choose and document the real identity, content, and commerce authorities before adding clients."],
  ["02", "Secure the surface", "Add authenticated server enforcement and deny-by-default roles before any private data or writes."],
  ["03", "Connect read models", "Introduce validated server-side projections with explicit loading, empty, stale, and error states."],
];

export function OverviewPage() {
  return (
    <>
      <section className="page-hero">
        <div>
          <p className="eyebrow"><span /> Initial production foundation</p>
          <h1>Control room,<br /><em>without the fiction.</em></h1>
          <p className="hero-copy">A polished navigation and state foundation for Third Railify operations. No account, provider, analytics, or content system is represented as live.</p>
        </div>
        <div className="signal-panel" aria-hidden="true">
          <span className="signal-orbit signal-orbit--one" />
          <span className="signal-orbit signal-orbit--two" />
          <span className="signal-core"><AdminIcon name="signal" size={32} /></span>
          <p>TR / ADMIN</p>
        </div>
      </section>

      <section className="boundary-section" aria-labelledby="boundary-title">
        <div className="section-heading">
          <div><p className="eyebrow">Current posture</p><h2 id="boundary-title">What this surface actually knows</h2></div>
          <span className="tag">Alpha foundation</span>
        </div>
        <div className="boundary-grid">
          {boundaries.map((item) => (
            <article className="boundary-card" key={item.label}>
              <span className={`boundary-indicator boundary-indicator--${item.tone}`} aria-hidden="true" />
              <p>{item.label}</p>
              <strong>{item.state}</strong>
            </article>
          ))}
        </div>
        <div className="notice-card">
          <AdminIcon name="shield" size={24} />
          <div><strong>Non-sensitive staging surface</strong><p>Do not add users, orders, credentials, provider keys, private analytics, or working admin controls until authentication and server-side authorization are implemented.</p></div>
        </div>
      </section>

      <section className="roadmap-section" aria-labelledby="roadmap-title">
        <div className="section-heading">
          <div><p className="eyebrow">Safe sequence</p><h2 id="roadmap-title">The next operational rails</h2></div>
          <Link className="text-link" to="/integrations">View integration shell <AdminIcon name="arrow" size={16} /></Link>
        </div>
        <div className="roadmap-list">
          {nextSteps.map(([number, title, detail]) => (
            <article key={number}><span>{number}</span><div><h3>{title}</h3><p>{detail}</p></div><AdminIcon name="arrow" /></article>
          ))}
        </div>
      </section>

      <StateSamples />
    </>
  );
}
