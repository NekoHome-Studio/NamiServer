/**
 * Vuetify instance and theme.
 *
 * Colours are defined here in JS rather than via a Sass settings file, so the
 * build needs no Sass toolchain. The palette is tuned for a dark, dense
 * operations console: a slate background, a single blue accent, and muted
 * surfaces that keep tables readable at high density.
 */

import { defineComponent, h, type PropType } from 'vue';
import { createVuetify } from 'vuetify';
import { aliases as vuetifyAliases, mdi } from 'vuetify/iconsets/mdi-svg';
import { namiIconAliases } from './icons.generated';

/**
 * Icon resolution, and why this is a custom set rather than an alias table.
 *
 * Vuetify resolves an `icon` prop in two steps (`vuetify/lib/composables/icons.js`):
 *
 *   1. only when the string starts with `$` does it consult `icons.aliases`;
 *   2. otherwise a `setName:` prefix picks a set, and a string with no prefix
 *      goes to `icons.defaultSet` **unchanged**.
 *
 * The `mdi-svg` set renders whatever it is handed directly into `<path d="…">`,
 * so a bare `"mdiSend"` produced `<path d="mdiSend">`: a blank icon and a console
 * error, never a thrown exception and never a failing test.
 *
 * An earlier version of this file tried to fix that by putting the generated
 * path map into `aliases`. That cannot work — step 1 is skipped for a bare name,
 * so the map was never consulted, and every icon in the console was blank.
 *
 * Resolving the name inside the set's own component fixes all call sites at once
 * (there are ~400 `mdi*` references) and keeps `icon="mdiSend"` the spelling
 * everyone expects. Unknown names are reported instead of silently rendering a
 * one-path icon with the name as its data.
 */
type SvgPath = string | [string, number];

const warnedUnknown = new Set<string>();

const NamiSvgIcon = defineComponent({
  name: 'NamiSvgIcon',
  inheritAttrs: false,
  props: {
    icon: { type: [String, Array] as PropType<SvgPath | SvgPath[]>, default: '' },
    tag: { type: [String, Object, Function] as PropType<string | object>, required: true },
  },
  setup(props, { attrs }) {
    return () => {
      const raw = props.icon;

      if (typeof raw === 'string' && raw.startsWith('mdi') && !(raw in namiIconAliases)) {
        // Only names are reported: a raw path handed straight to the set is legal.
        if (!warnedUnknown.has(raw)) {
          warnedUnknown.add(raw);
          console.warn(
            `[nami] 图标 "${raw}" 不在 icons.generated.ts 中。运行 ` +
              '`node scripts/generate-icon-map.mjs` 重新生成，否则它会渲染成空白。',
          );
        }
      }

      const resolved = typeof raw === 'string' ? (namiIconAliases[raw] ?? raw) : raw;
      const paths: SvgPath[] = Array.isArray(resolved) ? (resolved as SvgPath[]) : [resolved];

      return h(props.tag as string, attrs, [
        h(
          'svg',
          {
            class: 'v-icon__svg',
            xmlns: 'http://www.w3.org/2000/svg',
            viewBox: '0 0 24 24',
            role: 'img',
            'aria-hidden': 'true',
          },
          paths.map((path) =>
            h(
              'path',
              Array.isArray(path) ? { d: path[0], 'fill-opacity': path[1] } : { d: path },
            ),
          ),
        ),
      ]);
    };
  },
});

/**
 * The cast is deliberate: `IconSet.component` is typed as the stock `VSvgIcon`
 * component, and `NamiSvgIcon` implements exactly the same contract (an `icon`
 * prop plus a `tag` to render into). Casting through `typeof mdi.component`
 * states that equivalence instead of loosening the whole options object.
 */
const namiSet = { component: NamiSvgIcon as unknown as typeof mdi.component };

/**
 * Vuetify's own aliases (`complete`, `cancel`, `close`, …) are merged in and must
 * not be dropped: built-in components depend on them for their internal icons.
 * Their values carry an `svg:` prefix, which selects Vuetify's built-in `svg`
 * set — the one that takes raw path data.
 */
const aliases = {
  ...vuetifyAliases,
  ...namiIconAliases,
};

export const vuetify = createVuetify({
  icons: { defaultSet: 'nami', aliases, sets: { nami: namiSet, mdi } },
  theme: {
    defaultTheme: 'namiDark',
    themes: {
      namiDark: {
        dark: true,
        colors: {
          background: '#0b0e14',
          surface: '#11151d',
          'surface-bright': '#1a212c',
          'surface-light': '#161b24',
          'surface-variant': '#232a36',
          'on-surface-variant': '#8b94a3',
          primary: '#4c9aff',
          'primary-darken-1': '#2f7fe0',
          secondary: '#7c8aa5',
          accent: '#5fb8ff',
          error: '#f87171',
          info: '#60a5fa',
          success: '#34d399',
          warning: '#fbbf24',
        },
        variables: {
          'border-color': '#232a36',
          'border-opacity': 1,
          'high-emphasis-opacity': 0.95,
          'medium-emphasis-opacity': 0.72,
          'disabled-opacity': 0.42,
        },
      },
      namiLight: {
        dark: false,
        colors: {
          background: '#f6f7f9',
          surface: '#ffffff',
          'surface-bright': '#ffffff',
          'surface-light': '#eef1f5',
          'surface-variant': '#e2e7ee',
          'on-surface-variant': '#5b6472',
          primary: '#1f6feb',
          'primary-darken-1': '#1a5fd0',
          secondary: '#5b6472',
          accent: '#0969da',
          error: '#cf222e',
          info: '#0969da',
          success: '#1a7f37',
          warning: '#9a6700',
        },
        variables: {
          'border-color': '#d8dee7',
          'border-opacity': 1,
        },
      },
    },
  },
  defaults: {
    VCard: { variant: 'flat', border: true, rounded: 'lg' },
    VTextField: { variant: 'outlined', density: 'comfortable', hideDetails: 'auto' },
    VSelect: { variant: 'outlined', density: 'comfortable', hideDetails: 'auto' },
    VTextarea: { variant: 'outlined', density: 'comfortable', hideDetails: 'auto' },
    VBtn: { variant: 'flat', rounded: 'lg' },
    VChip: { rounded: 'md', size: 'small' },
    VTable: { density: 'comfortable' },
    VDialog: { maxWidth: 720 },
    VSnackbar: { location: 'top right', timeout: 5000 },
  },
});
