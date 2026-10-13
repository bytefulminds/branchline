export function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1
    ? { name: path, dir: "" }
    : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function relativeTime(date: Date | number | string, now: number = Date.now()): string {
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return "";
  const seconds = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Shorten a home-directory prefix for display (`/Users/me/x` -> `~/x`). */
export function displayPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
