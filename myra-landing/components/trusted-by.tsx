'use client';

const logos = [
  { name: 'Cargill', color: '#1a5276', abbr: 'CA' },
  { name: 'Sysco', color: '#1e3a5f', abbr: 'SY' },
  { name: 'DAT Freight', color: '#7b2d8b', abbr: 'DA' },
  { name: 'Project44', color: '#1a6b3a', abbr: 'P4' },
  { name: 'FourKites', color: '#b45309', abbr: 'FK' },
  { name: 'Trimble', color: '#1a4f8a', abbr: 'TR' },
  { name: 'Motive', color: '#1e1e1e', abbr: 'MO' },
  { name: 'Geotab', color: '#004080', abbr: 'GT' },
  { name: 'TruckStop', color: '#7c3238', abbr: 'TS' },
];

const reversedLogos = [...logos].reverse();

function LogoPill({ name, color, abbr }: { name: string; color: string; abbr: string }) {
  return (
    <div className="logo-pill">
      <div
        className="logo-icon"
        style={{ background: `${color}20`, color: `${color}aa` }}
      >
        {abbr}
      </div>
      <span className="logo-name">{name}</span>
    </div>
  );
}

function Track({ items, id }: { items: typeof logos; id: string }) {
  return (
    <div className="ticker-track" id={id}>
      {items.map((l, i) => (
        <LogoPill key={i} {...l} />
      ))}
    </div>
  );
}

export function TrustedBy() {
  return (
    <section className="trusted-section">
      <div className="trusted-label">
        <span className="trusted-label-text">Trusted by leaders in freight &amp; logistics</span>
      </div>

      {/* Row 1 - left scroll */}
      <div className="ticker-row" id="row1">
        <Track items={logos} id="track1" />
        <Track items={logos} id="track1b" />
      </div>

      {/* Row 2 - right scroll */}
      <div className="ticker-row reverse" id="row2">
        <Track items={reversedLogos} id="track2" />
        <Track items={reversedLogos} id="track2b" />
      </div>
    </section>
  );
}
