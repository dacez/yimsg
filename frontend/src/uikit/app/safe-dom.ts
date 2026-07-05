const safeHtmlBrand: unique symbol = Symbol('YimsgSafeHtml');

export interface SafeHtml {
  readonly [safeHtmlBrand]: true;
  readonly value: string;
}

const TRUSTED_URL_PROTOCOLS = new Set(['http:', 'https:']);

export function escapeHtml(str: string | undefined | null): string {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\'': return '&#39;';
      default: return char;
    }
  });
}

export function safeHtml(value: string): SafeHtml {
  return { [safeHtmlBrand]: true, value };
}

export function unwrapSafeHtml(value: SafeHtml): string {
  return value.value;
}

export function normalizeTrustedResourceUrl(raw: string | undefined | null): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  if (value.startsWith('./') || value.startsWith('../')) return value;

  try {
    const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
    const url = new URL(value, base);
    if (!TRUSTED_URL_PROTOCOLS.has(url.protocol)) return null;
    return value;
  } catch {
    return null;
  }
}

export function setSafeHtml(element: HTMLElement, html: SafeHtml): void {
  element.innerHTML = unwrapSafeHtml(html);
}

export function setTrustedImageSrc(image: HTMLImageElement, url: string | undefined | null): boolean {
  const normalized = normalizeTrustedResourceUrl(url);
  if (!normalized) return false;
  image.src = normalized;
  return true;
}

export function setTrustedAnchorHref(anchor: HTMLAnchorElement, url: string | undefined | null): boolean {
  const normalized = normalizeTrustedResourceUrl(url);
  if (!normalized) return false;
  anchor.href = normalized;
  anchor.rel = 'noopener noreferrer';
  return true;
}
