/**
 * Shared style-config schema + defaults for the "Customize Style" editor.
 *
 * The config is stored as JSON in StyleSetting.config (per shop) and served to
 * the storefront via the app proxy (api.style).
 *  - Phase 1: Carousel widget — section title, card size, title, price, button.
 *  - Phase 2: typography (weight / letter-spacing), padding/margin, border /
 *    shadow, and the view-count badge.
 * Per-device fields live in desktop/mobile blocks; props that rarely differ by
 * device (weights, borders, padding) are stored once at the element level.
 */

export interface CarouselConfig {
  section: {
    text: string;
    fontWeight: number;
    letterSpacing: number; // px
    marginBottom: number; // px
    desktop: { show: boolean; fontSize: number; color: string; align: string };
    mobile: { show: boolean; fontSize: number; color: string; align: string };
  };
  card: {
    borderWidth: number; // px
    borderColor: string;
    shadow: boolean;
    desktop: { width: number; height: number; radius: number; gap: number };
    mobile: { width: number; height: number; radius: number; gap: number };
  };
  title: {
    fontWeight: number;
    desktop: { show: boolean; fontSize: number; color: string };
    mobile: { show: boolean; fontSize: number; color: string };
  };
  price: {
    fontWeight: number;
    desktop: { show: boolean; fontSize: number; color: string };
    mobile: { show: boolean; fontSize: number; color: string };
  };
  button: {
    bg: string;
    textColor: string;
    text: string;
    radius: number;
    fontSize: number;
    fontWeight: number;
    paddingY: number; // px
    paddingX: number; // px
    borderWidth: number; // px
    borderColor: string;
  };
  badge: {
    showViews: boolean;
    color: string;
  };
}

export interface StyleConfig {
  carousel: CarouselConfig;
}

export const DEFAULT_CONFIG: StyleConfig = {
  carousel: {
    section: {
      text: "Shop Our Looks",
      fontWeight: 700,
      letterSpacing: 0,
      marginBottom: 16,
      desktop: { show: true, fontSize: 22, color: "#111111", align: "left" },
      mobile: { show: true, fontSize: 18, color: "#111111", align: "left" },
    },
    card: {
      borderWidth: 0,
      borderColor: "#000000",
      shadow: true,
      desktop: { width: 270, height: 405, radius: 12, gap: 10 },
      mobile: { width: 210, height: 315, radius: 12, gap: 10 },
    },
    title: {
      fontWeight: 600,
      desktop: { show: true, fontSize: 12, color: "#111111" },
      mobile: { show: true, fontSize: 11, color: "#111111" },
    },
    price: {
      fontWeight: 700,
      // default hidden (matches the current storefront where price was removed)
      desktop: { show: false, fontSize: 12, color: "#e53e3e" },
      mobile: { show: false, fontSize: 12, color: "#e53e3e" },
    },
    button: {
      bg: "#111111",
      textColor: "#ffffff",
      text: "Add to cart",
      radius: 6,
      fontSize: 13,
      fontWeight: 600,
      paddingY: 11,
      paddingX: 14,
      borderWidth: 0,
      borderColor: "#000000",
    },
    badge: {
      showViews: true,
      color: "#ffffff",
    },
  },
};

/** Deep-merge a stored (possibly partial / older) config onto the defaults. */
export function mergeConfig(stored: unknown): StyleConfig {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as StyleConfig;
  if (!stored || typeof stored !== "object") return out;
  deepAssign(out as unknown as Record<string, unknown>, stored as Record<string, unknown>);
  return out;
}

function deepAssign(target: Record<string, unknown>, src: Record<string, unknown>) {
  for (const key of Object.keys(src)) {
    const sv = src[key];
    const tv = target[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object") {
      deepAssign(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else if (sv !== undefined && sv !== null) {
      target[key] = sv;
    }
  }
}
