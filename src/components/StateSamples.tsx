export function StateSamples() {
  return (
    <section className="state-lab" aria-labelledby="state-lab-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Interface language</p>
          <h2 id="state-lab-title">Honest states, ready for real data</h2>
        </div>
        <span className="tag tag--muted">Visual scaffold</span>
      </div>
      <div className="state-grid">
        <article className="state-card" aria-label="Loading state example">
          <span className="state-symbol state-symbol--loading" aria-hidden="true" />
          <div><strong>Loading</strong><p>Reserved for bounded server requests.</p></div>
        </article>
        <article className="state-card" aria-label="Empty state example">
          <span className="state-symbol state-symbol--empty" aria-hidden="true">0</span>
          <div><strong>No records</strong><p>Nothing is connected to this scaffold.</p></div>
        </article>
        <article className="state-card" aria-label="Error state example">
          <span className="state-symbol state-symbol--error" aria-hidden="true">!</span>
          <div><strong>Unavailable</strong><p>Future failures will remain explicit.</p></div>
        </article>
      </div>
    </section>
  );
}
