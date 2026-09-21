/**
 * Tailwind design-token export for SonicForge.
 *
 * Brief:
 *   SonicForge ships hand-authored CSS rather than a Tailwind build, and
 *   that is a deliberate decision: loading the Tailwind play CDN at runtime
 *   would be the application's only network request, would cause a flash of
 *   unstyled content, and would break the offline guarantee the service
 *   worker provides.
 *
 *   This file exists so the design system is still Tailwind-native for
 *   anyone extending the project. Every value here is the single source of
 *   truth mirrored by the custom properties in css/theme.css - change one
 *   and change the other.
 *
 * Usage:
 *   npm install -D tailwindcss
 *   npx tailwindcss -i ./css/tailwind-entry.css -o ./css/tailwind.css --watch
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './js/**/*.js'],
  darkMode: 'class',

  theme: {
    extend: {
      colors: {
        onyx: {
          900: '#05070d',
          850: '#080b13',
          800: '#0b0f19',
          700: '#111726',
          500: '#1d2740',
        },
        cyan: {
          DEFAULT: '#00f2fe',
          dim: '#00b8c4',
        },
        violet: {
          DEFAULT: '#7f00ff',
          lite: '#a855f7',
        },
        amber: '#ffb020',
        rose: '#ff3d71',
        lime: '#29ff9a',
        ink: {
          hi: '#eef3ff',
          DEFAULT: '#b9c4dc',
          mid: '#7d89a6',
          low: '#4d5872',
        },
      },

      fontFamily: {
        ui: [
          'Inter',
          'Segoe UI Variable',
          'Segoe UI',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'SF Mono',
          'Cascadia Code',
          'ui-monospace',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },

      borderRadius: {
        sm: '6px',
        DEFAULT: '10px',
        lg: '16px',
      },

      boxShadow: {
        sm: '0 2px 8px rgba(0, 0, 0, 0.4)',
        DEFAULT: '0 8px 28px rgba(0, 0, 0, 0.55)',
        lift: '0 18px 44px rgba(0, 0, 0, 0.62)',
        'glow-cyan': '0 0 18px rgba(0, 242, 254, 0.24)',
        'glow-violet': '0 0 18px rgba(127, 0, 255, 0.45)',
      },

      backdropBlur: {
        glass: '18px',
      },

      transitionTimingFunction: {
        // The single easing curve every animation in the app uses.
        forge: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },

      spacing: {
        'rail-l': '248px',
        'rail-r': '384px',
        header: '58px',
        status: '26px',
      },
    },
  },

  plugins: [],
};
