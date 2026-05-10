import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Alexandria", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        // invygo brand tokens (mirrors theme.py)
        brand: {
          DEFAULT: "#159fcb",
          dark: "#106F93",
          darker: "#0D5671",
          light: "#7FD2EB",
          pale: "#B3E4F3",
          pastel: "#E6F6FB",
        },
        midnight: {
          DEFAULT: "#023047",
          dark: "#011B2C",
          grey: "#69757D",
          pale: "#E6E9EB",
        },
        green: {
          DEFAULT: "#8abf3f",
          brand: "#8abf3f",
          dark: "#79A935",
          pale: "#EEF7E6",
        },
        gold: {
          DEFAULT: "#ffb703",
          brand: "#ffb703",
          dark: "#DB9802",
          pale: "#FFF7E6",
        },
        flame: {
          DEFAULT: "#FB8500",
          brand: "#FB8500",
          dark: "#D46F00",
          pale: "#FFF4E6",
        },
        // Neutrals
        ink: {
          50: "#FCFCFD",
          100: "#F9FAFB",
          200: "#F2F4F7",
          300: "#D0D5DD",
          400: "#98A2B3",
          500: "#667085",
          600: "#475467",
          700: "#344054",
          900: "#1D2939",
        },
      },
      borderRadius: {
        lg: "12px",
        md: "10px",
      },
    },
  },
  plugins: [],
};

export default config;
