/** ISO-8601 with local wall-clock + numeric offset (e.g. +08:00), not UTC Z. */
export function toLocalIsoString(
  d: Date = new Date(),
  opts?: { includeMs?: boolean },
): string {
  const includeMs = opts?.includeMs ?? false;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  const base =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const msPart = includeMs ? `.${pad(d.getMilliseconds(), 3)}` : "";
  return `${base}${msPart}${sign}${oh}:${om}`;
}

/** UTC Z suffix — only for `created_at_utc` / machine fields, not user-visible keys. */
export function toUtcIsoString(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const OFFSET_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:[+-]\d{2}:\d{2}|Z)$/;

export function hasExplicitOffset(iso: string): boolean {
  return OFFSET_ISO_RE.test(iso.trim());
}

export interface EnvelopeTimestamps {
  created_at: string;
  updated_at: string;
  timezone: string;
  created_at_utc: string;
}

/** Resolve ledger / panel timestamps from frontmatter with optional file mtime fallback. */
export function resolveEnvelopeTimestamps(
  fm: Record<string, unknown>,
  mtimeMs?: number,
): EnvelopeTimestamps {
  const now = new Date();
  const fallback = Number.isFinite(mtimeMs) ? new Date(mtimeMs!) : now;
  const rawCreated = String(fm.created_at ?? "").trim();
  const rawUpdated = String(fm.updated_at ?? "").trim();
  const created_at =
    rawCreated && hasExplicitOffset(rawCreated)
      ? rawCreated
      : toLocalIsoString(fallback);
  const updated_at =
    rawUpdated && hasExplicitOffset(rawUpdated)
      ? rawUpdated
      : rawCreated && hasExplicitOffset(rawCreated)
        ? rawCreated
        : toLocalIsoString(fallback);
  const timezone =
    String(fm.timezone ?? "").trim() || getLocalTimezone();
  const rawUtc = String(fm.created_at_utc ?? "").trim();
  const created_at_utc =
    rawUtc && /Z$/i.test(rawUtc) ? rawUtc : toUtcIsoString(fallback);
  return { created_at, updated_at, timezone, created_at_utc };
}

/** UI short local display: `05/31 22:26` (no year, no UTC label). */
export function formatLocalShortDateTime(
  input: Date | string | number | null | undefined,
  locale = "en-US",
): string {
  let d: Date;
  if (input instanceof Date) d = input;
  else if (typeof input === "number") d = new Date(input);
  else if (input == null || input === "") return "—";
  else d = new Date(String(input));
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  if (locale.startsWith("zh")) {
    return `${mm}/${dd} ${hh}:${min}`;
  }
  return `${mm}/${dd} ${hh}:${min}`;
}
