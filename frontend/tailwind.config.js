/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0a0c10",
          900: "#11141b",
          800: "#181c25",
          700: "#222834",
          600: "#2e3644",
        },
        // Severity is the product's core vocabulary, so it gets named colours
        // rather than ad-hoc utility classes scattered through components.
        sev: {
          critical: "#f2555a",
          high: "#f0883e",
          notable: "#e3b341",
          quiet: "#5a6472",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
