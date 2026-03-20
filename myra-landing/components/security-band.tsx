const items = [
  "FMCSA Licensed",
  "SOC 2 Type II",
  "$2M Cargo Coverage",
  "CTPAT Certified",
  "256-bit TLS",
  "Broker Authority #12847",
];

export function SecurityBand() {
  return (
    <div className="security-band">
      <div className="security-inner">
        <div className="security-shield">
          <svg viewBox="0 0 24 24">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span className="security-shield-text">Compliance</span>
        </div>
        <div className="security-items">
          {items.map((text) => (
            <div key={text} className="security-item">
              <div className="security-item-dot"></div>
              <span className="security-item-text">{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
