/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // A light, near-white product surface. `canvas` is the page, `surface`
        // is a raised card, `sunk` is an inset well (tables, code, chart frames).
        canvas: "#f7f8fa",
        surface: "#ffffff",
        sunk: "#f2f4f7",
        line: "#e6e8ec",
        "line-strong": "#d6d9df",
        // Text scale, dark-on-light. `ink-900` is body text, `ink-500` is
        // secondary, `ink-400` is faint metadata.
        ink: {
          900: "#0f1729",
          700: "#31394a",
          600: "#4a5264",
          500: "#697086",
          400: "#8b91a3",
        },
        // Direction of price movement.
        up: "#0f8a52",
        down: "#c8354a",
        // Severity is the product's core vocabulary, tuned for AA contrast on
        // white rather than on a dark panel.
        sev: {
          critical: "#c8354a",
          high: "#b45309",
          notable: "#8a6d0f",
          quiet: "#697086",
        },
        // Tint backgrounds for severity chips / banners.
        "sev-bg": {
          critical: "#fdeef0",
          high: "#fdf3e7",
          notable: "#fbf6e6",
          quiet: "#f2f4f7",
        },
        accent: "#2b59d9",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        // Restrained. A card is separated by its border first; the shadow is
        // just enough to lift it off the canvas.
        card: "0 1px 2px 0 rgb(15 23 41 / 0.04), 0 1px 3px 0 rgb(15 23 41 / 0.06)",
        pop: "0 4px 16px -2px rgb(15 23 41 / 0.12), 0 2px 6px -2px rgb(15 23 41 / 0.08)",
      },
      borderRadius: {
        card: "0.75rem",
      },
    },
  },
  plugins: [],
};
