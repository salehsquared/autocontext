export function capitalize(s: string, locale: string = "en-US"): string {
  return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
}
