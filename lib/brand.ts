/**
 * invygo brand tokens — mirrors `tracker_v1/theme.py`'s `Brand` class.
 * Use these in TS when you need a colour value (charts, inline styles).
 * Tailwind classes are exposed via `tailwind.config.ts`.
 */
export const Brand = {
  // Primary
  BLUE: "#159fcb",
  BLUE_DARK: "#106F93",
  BLUE_DARKER: "#0D5671",
  BLUE_LIGHT: "#7FD2EB",
  BLUE_PALE: "#B3E4F3",
  BLUE_PASTEL: "#E6F6FB",

  // Midnight
  MIDNIGHT: "#023047",
  MIDNIGHT_DARK: "#011B2C",
  MIDNIGHT_GREY: "#69757D",
  MIDNIGHT_PALE: "#E6E9EB",

  // Semantic
  GREEN: "#8abf3f",
  GREEN_DARK: "#79A935",
  GREEN_PALE: "#EEF7E6",

  YELLOW: "#ffb703",
  YELLOW_DARK: "#DB9802",
  YELLOW_PALE: "#FFF7E6",

  ORANGE: "#FB8500",
  ORANGE_DARK: "#D46F00",
  ORANGE_PALE: "#FFF4E6",

  // Neutrals
  GREY_50: "#FCFCFD",
  GREY_100: "#F9FAFB",
  GREY_200: "#F2F4F7",
  GREY_300: "#D0D5DD",
  GREY_400: "#98A2B3",
  GREY_500: "#667085",
  GREY_600: "#475467",
  GREY_700: "#344054",
  GREY_900: "#1D2939",

  BG: "#FFFFFF",
  BG_SOFT: "#F9FAFB",
  BORDER: "#E6E9EB",
  BORDER_DARK: "#D0D5DD",
} as const;

/** Curated palette for chart traces. */
export const PLOTLY_PALETTE = [
  Brand.BLUE,
  Brand.MIDNIGHT,
  Brand.GREEN,
  Brand.YELLOW,
  Brand.ORANGE,
  Brand.BLUE_DARK,
  Brand.GREEN_DARK,
  Brand.MIDNIGHT_GREY,
];
