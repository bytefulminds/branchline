/** Icons for the graph toolbar, drawn like the Lucide icons around them. */

interface IconProps {
  size?: number;
}

function GraphIcon({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** A merged branch folded into its merge commit, shown with a plus like the graph's "+1". */
export function MergedFoldedIcon(props: IconProps) {
  return (
    <GraphIcon {...props}>
      <path d="M6 3v6" />
      <path d="M6 15v6" />
      <circle cx="6" cy="12" r="3" />
      <path d="M13 12h7" />
      <path d="M16.5 8.5v7" />
    </GraphIcon>
  );
}

/** A branch beside the main line: merged branches shown in full. */
export function MergedShownIcon(props: IconProps) {
  return (
    <GraphIcon {...props}>
      <path d="M6 3v18" />
      <path d="M6 8a9 9 0 0 0 9 9" />
      <circle cx="18" cy="17" r="3" />
    </GraphIcon>
  );
}
