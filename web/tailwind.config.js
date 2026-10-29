/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#0a0e14',
          800: '#0f141c',
          700: '#161c26',
          600: '#1e2631',
          500: '#2a3340',
        },
        edge: '#2d3744',
        muted: '#8b949e',
        accent: '#1f6feb',
        good: '#3fb950',
        warn: '#d29922',
        bad: '#f85149',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
