import { GRAPH_COLORS } from "./graph";

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Local, deterministic avatar (no network lookups). */
export function Avatar({ name, email, size = 20 }: { name: string; email: string; size?: number }) {
  const c = hash(email.toLowerCase() || name) % GRAPH_COLORS;
  return (
    <span
      className="bl-avatar"
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `color-mix(in srgb, var(--graph-${c}) 28%, var(--color-surface))`,
        color: `var(--graph-${c})`,
      }}
    >
      {initials(name)}
    </span>
  );
}
