/**
 * Shared style-config schema + defaults for the "Customize Style" editor.
 *
 * The config is stored as JSON in StyleSetting.config (per shop) and served to
 * the storefront via the app proxy (api.style). Phase 1 implements the Carousel
 * widget; later phases add Story / Floating / Overlay and more element props.
 */

export type DeviceBlock = Record<string, string | number | boolean>;

export interface CarouselConfig {
  section: {
    text: string;
    desktop: { show: boolean; fontSize: number; color: string; align: string };
    mobile: { show: boolean; fontSize: number; color: string; align: string };
  };
  card: {
    desktop: { width: number; height: number; radius: number; gap: number };
    mobile: { width: number; height: number; radius: number; gap: number };
  };
  title: {
    desktop: { show: boolean; fontSize: number; color: string };
    mobile: { show: boolean; fontSize: number; color: string };
  };
  price: {
    desktop: { show: boolean; fontSize: number; color: string };
    mobile: { show: boolean; fontSize: number; color: string };
  };
  button: {
    bg: string;
    textColor: string;
    text: string;
    radius: number;
  };
}

export interface StyleConfig {
  carousel: CarouselConfig;
}

export const DEFAULT_CONFIG: StyleConfig = {
  carousel: {
    section: {
      text: "Shop Our Looks",
      desktop: { show: true, fontSize: 22, color: "#111111", align: "left" },
      mobile: { show: true, fontSize: 18, color: "#111111", align: "left" },
    },
    card: {
      desktop: { width: 270, height: 405, radius: 12, gap: 10 },
      mobile: { width: 210, height: 315, radius: 12, gap: 10 },
    },
    title: {
      desktop: { show: true, fontSize: 12, color: "#111111" },
      mobile: { show: true, fontSize: 11, color: "#111111" },
    },
    price: {
      // default hidden (matches the current storefront where price was removed)
      desktop: { show: false, fontSize: 12, color: "#e53e3e" },
      mobile: { show: false, fontSize: 12, color: "#e53e3e" },
    },
    button: {
      bg: "#111111",
      textColor: "#ffffff",
      text: "Add to cart",
      radius: 6,
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
