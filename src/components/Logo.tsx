/** Branchline logo mark, matching _assets/Branchline_logo.png. */
export function LogoMark({ size = 24, title }: { size?: number; title?: string }) {
  const nodes: [number, number][] = [
    [25.8, 21.4],
    [25.8, 50.2],
    [25.8, 78.6],
    [74.7, 25.3],
    [74.7, 74.1],
  ];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ flex: "none" }}
    >
      <rect width="100" height="100" rx="22" fill="var(--color-surface)" />
      <g fill="none" stroke="var(--color-brand-line)" strokeWidth="3.8" strokeLinecap="round">
        <path d="M25.8 21.4V78.6" />
        <path d="M25.8 38H33C43 38 46 25.3 57 25.3H74.7" />
        <path d="M25.8 62.5H33C43 62.5 46 74.1 57 74.1H74.7" />
      </g>
      {nodes.map(([cx, cy]) => (
        <g key={`${cx}-${cy}`}>
          <circle cx={cx} cy={cy} r="8.2" fill="var(--color-brand-line)" />
          <circle cx={cx} cy={cy} r="5.8" fill="var(--color-brand-mint)" />
        </g>
      ))}
    </svg>
  );
}
