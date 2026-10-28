// Which browser this is, for status lines and the native-host handshake.

export function browserInfo(): { name: string; version: string } {
  const brands = (navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string; version: string }> } }).userAgentData?.brands ?? [];
  const known = ['Microsoft Edge', 'Brave', 'Opera', 'Vivaldi', 'Google Chrome', 'Chromium'];
  const brand = known.map((k) => brands.find((b) => b.brand === k)).find(Boolean);
  const full = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? brand?.version ?? '';
  return { name: brand?.brand ?? 'Chromium', version: full };
}
