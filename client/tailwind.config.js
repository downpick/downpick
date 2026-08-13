/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#18181b',
          1: '#09090b',
          2: '#27272a',
          3: '#3f3f46',
        },
        accent: {
          DEFAULT: '#c9a227',
          hover: '#dcb84f',
        },
        success: '#8fbf7f',
        error: '#e0777f',
        warning: '#d9a05b',
        text: {
          DEFAULT: '#e4e4e7',
          muted: '#a1a1aa',
          dim: '#71717a',
        },
      },
    },
  },
  plugins: [],
};
