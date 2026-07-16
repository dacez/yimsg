type ResponsiveLayoutChoice = 'desktop' | 'mobile' | 'auto';
type ResponsiveLayout = 'desktop' | 'mobile';

export interface ResponsiveLayoutEnvironment {
  readonly width?: number;
  readonly innerWidth?: number;
  readonly matchMedia?: (query: string) => { matches: boolean };
}

export const MOBILE_LAYOUT_MAX_WIDTH = 640;
export const EMBEDDED_WIDGET_MIN_WIDTH = 320;
export const EMBEDDED_WIDGET_MIN_HEIGHT = 360;

interface EmbeddedWidgetSizeEnvironment {
  readonly width?: number;
  readonly height?: number;
}

export function detectResponsiveLayout(env: ResponsiveLayoutEnvironment): ResponsiveLayout {
  const width = typeof env.width === 'number'
    ? env.width
    : typeof env.innerWidth === 'number'
      ? env.innerWidth
      : Number.POSITIVE_INFINITY;

  let coarse = false;
  if (typeof env.matchMedia === 'function') {
    try {
      coarse = env.matchMedia('(pointer: coarse)').matches;
    } catch {
      coarse = false;
    }
  }

  if (coarse || width <= MOBILE_LAYOUT_MAX_WIDTH) {
    return 'mobile';
  }
  return 'desktop';
}

export function resolveResponsiveLayout(
  choice: ResponsiveLayoutChoice,
  env: ResponsiveLayoutEnvironment,
): ResponsiveLayout {
  if (choice === 'desktop') return 'desktop';
  if (choice === 'mobile') return 'mobile';
  return detectResponsiveLayout(env);
}

export function isEmbeddedWidgetTooSmall(env: EmbeddedWidgetSizeEnvironment): boolean {
  const width = typeof env.width === 'number' ? env.width : Number.POSITIVE_INFINITY;
  const height = typeof env.height === 'number' ? env.height : Number.POSITIVE_INFINITY;
  return width < EMBEDDED_WIDGET_MIN_WIDTH || height < EMBEDDED_WIDGET_MIN_HEIGHT;
}
