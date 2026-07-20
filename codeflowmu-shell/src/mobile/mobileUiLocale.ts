export type MobileUiLang = "zh" | "en";

export function normalizeMobileUiLang(value: unknown): MobileUiLang {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "en" || raw.startsWith("en-") ? "en" : "zh";
}

export function mobileUiText(lang: MobileUiLang, zh: string, en: string): string {
  return lang === "en" ? en : zh;
}
