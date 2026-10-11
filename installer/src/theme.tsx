/**
 * Themes for the FYAISA hub.
 *
 * A theme is a small palette (background, surface, text, accent, focus,
 * danger, success, warn) plus three effect choices: how buttons react to
 * focus, what the ambient background does, and how lively that background is.
 * Everything else — the darker "pressed" surfaces, the code green, the focus
 * ring colour — is *derived* from that palette, so a preset only has to name
 * the colours a human would actually pick and the rest stays consistent.
 *
 * Add-ons are deliberately out of scope: app logos and tile art are never
 * recoloured, no matter what theme is active.
 *
 * The choice is persisted to /data/theme.json through Amazon's KeplerFileSystem
 * (see the note in App.tsx on why AsyncStorage is not usable here).
 */
import * as React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {KeplerFileSystem} from '@amazon-devices/kepler-file-system';

export type BackgroundEffect = 'none' | 'aurora' | 'waves' | 'sweep';
export type ButtonEffect = 'flat' | 'glow' | 'outline';
export type WaveEnergy = 'calm' | 'normal' | 'party';

/** The colours a preset or a user actually picks. */
export type ThemePalette = {
  /** Page background (sits under the animated effects). */
  bg: string;
  /** Cards, rows, search box: the raised surfaces. */
  surface: string;
  /** Primary text, titles, brand. */
  text: string;
  /** Secondary text: summaries, tags, notes. */
  textDim: string;
  /** Tertiary text: ids, chevrons, placeholder. */
  textMuted: string;
  /** Accent: primary buttons and highlights. */
  accent: string;
  /** D-pad focus ring colour. */
  focus: string;
  /** Destructive actions. */
  danger: string;
  /** Confirm / install actions. */
  success: string;
  /** Warnings and "needs attention" text. */
  warn: string;
};

export type Theme = {
  /** Preset id, or "custom" once any individual setting is changed. */
  preset: string;
  name: string;
  palette: ThemePalette;
  buttonEffect: ButtonEffect;
  background: BackgroundEffect;
  energy: WaveEnergy;
};

/**
 * A theme with every derived colour resolved, which is what the stylesheet and
 * the background renderer actually consume.
 */
export type ResolvedTheme = ThemePalette & {
  surfaceAlt: string;
  surfaceKey: string;
  surfaceDeep: string;
  border: string;
  accentText: string;
  code: string;
  link: string;
  dangerSoft: string;
  dangerText: string;
  dangerChipText: string;
  textStrong: string;
  textSoft: string;
  textBody: string;
  buttonEffect: ButtonEffect;
  background: BackgroundEffect;
  energy: WaveEnergy;
};

/* ---------------------------------------------------------------------------
 * Colour maths. Small and dependency-free: parse a #rgb / #rrggbb string, mix
 * two of them, and pick readable text for a coloured chip.
 * ------------------------------------------------------------------------- */
const hexToRgb = (hex: string): [number, number, number] => {
  let h = String(hex || '').replace('#', '').trim();
  if (h.length === 3) {
    h = h
      .split('')
      .map(c => c + c)
      .join('');
  }
  const n = parseInt(h || '000000', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgbToHex = (r: number, g: number, b: number) =>
  '#' +
  [r, g, b]
    .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('');

/** Linear blend: 0 => a, 1 => b. */
const mix = (a: string, b: string, t: number) => {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
};

const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

/** Readable text colour for a filled chip/button. */
const contrastOn = (hex: string) => (luminance(hex) > 0.6 ? '#101014' : '#ffffff');

/** Sentinel value for the animated rainbow option. */
export const RAINBOW = 'rainbow';

const isRainbow = (v: string) => v === RAINBOW;

/** Vivid (fully saturated) rainbow colour for a hue in degrees. */
const hueToHex = (hue: number): string => {
  const h = ((hue % 360) + 360) % 360;
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [1, x, 0];
  else if (h < 120) [r, g, b] = [x, 1, 0];
  else if (h < 180) [r, g, b] = [0, 1, x];
  else if (h < 240) [r, g, b] = [0, x, 1];
  else if (h < 300) [r, g, b] = [x, 0, 1];
  else [r, g, b] = [1, 0, x];
  return `#${[r, g, b]
    .map(v => Math.round(v * 255).toString(16).padStart(2, '0'))
    .join('')}`;
};

/**
 * Phase offsets per palette channel, so a rainbow background, surface, accent
 * and ring never land on the same hue and wipe each other out.
 */
const RAINBOW_OFFSET: Record<keyof ThemePalette, number> = {
  bg: 0,
  surface: 60,
  text: 180,
  textDim: 0,
  textMuted: 0,
  accent: 120,
  focus: 240,
  danger: 300,
  success: 200,
  warn: 40,
};

/** Replace every palette field set to "rainbow" with its current animated hex. */
const resolveRainbows = (palette: ThemePalette, hue: number): ThemePalette => {
  if (!Object.values(palette).some(isRainbow)) return palette;
  const out = {...palette};
  (Object.keys(out) as (keyof ThemePalette)[]).forEach(k => {
    if (out[k] === RAINBOW) {
      out[k] = hueToHex(hue * 360 + RAINBOW_OFFSET[k]);
    }
  });
  return out;
};

export const resolveTheme = (theme: Theme, hue = 0): ResolvedTheme => {
  const c = resolveRainbows(theme.palette, hue);
  return {
    ...c,
    // Nudged surfaces so nested panels read as "above" the card they sit on,
    // in both dark and light palettes (mix toward the text colour, not white).
    surfaceAlt: mix(c.surface, c.text, 0.06),
    surfaceKey: mix(c.surface, c.text, 0.1),
    surfaceDeep: mix(c.surface, c.bg, 0.6),
    border: mix(c.surface, c.text, 0.14),
    accentText: contrastOn(c.accent),
    code: mix(c.success, '#ffffff', 0.45),
    link: mix(c.accent, '#ffffff', 0.45),
    dangerSoft: mix(c.danger, c.bg, 0.78),
    dangerText: mix(c.danger, '#ffffff', 0.4),
    dangerChipText: contrastOn(mix(c.danger, c.bg, 0.78)),
    textStrong: c.text,
    textSoft: mix(c.text, c.textDim, 0.5),
    textBody: mix(c.text, c.textDim, 0.8),
    buttonEffect: theme.buttonEffect,
    background: theme.background,
    energy: theme.energy,
  };
};

/* ---------------------------------------------------------------------------
 * Presets.
 * ------------------------------------------------------------------------- */
const CLASSIC_PALETTE: ThemePalette = {
  bg: '#0b0b0f',
  surface: '#16161d',
  text: '#ffffff',
  textDim: '#8b8b99',
  textMuted: '#6f6f80',
  accent: '#165a8c',
  focus: '#ffb02e',
  danger: '#e50914',
  success: '#1c7d32',
  warn: '#ffb300',
};

const preset = (
  id: string,
  name: string,
  palette: Partial<ThemePalette>,
  effects: Partial<Pick<Theme, 'buttonEffect' | 'background' | 'energy'>> = {},
): Theme => ({
  preset: id,
  name,
  palette: {...CLASSIC_PALETTE, ...palette},
  buttonEffect: effects.buttonEffect ?? 'flat',
  background: effects.background ?? 'none',
  energy: effects.energy ?? 'normal',
});

export const PRESETS: Record<string, Theme> = {
  classic: preset('classic', 'FYAISA Classic', {}, {buttonEffect: 'flat', background: 'none'}),
  midnight: preset(
    'midnight',
    'Midnight',
    {
      bg: '#000000',
      surface: '#0e0e12',
      text: '#f2f2f7',
      textDim: '#8a8a99',
      textMuted: '#5c5c6b',
      accent: '#3d7bff',
      focus: '#6ea8ff',
      danger: '#ff4d4d',
      success: '#2e9e4f',
      warn: '#ffc043',
    },
    {buttonEffect: 'glow', background: 'aurora', energy: 'calm'},
  ),
  nord: preset(
    'nord',
    'Nord',
    {
      bg: '#12161c',
      surface: '#1b222c',
      text: '#eceff4',
      textDim: '#9aa5b3',
      textMuted: '#6b7686',
      accent: '#5e81ac',
      focus: '#88c0d0',
      danger: '#bf616a',
      success: '#a3be8c',
      warn: '#ebcb8b',
    },
    {buttonEffect: 'outline', background: 'aurora', energy: 'calm'},
  ),
  synthwave: preset(
    'synthwave',
    'Synthwave',
    {
      bg: '#14082a',
      surface: '#1e0f3a',
      text: '#f7f0ff',
      textDim: '#a58fd0',
      textMuted: '#7c66ad',
      accent: '#ff2e97',
      focus: '#00e5ff',
      danger: '#ff5470',
      success: '#3ddc97',
      warn: '#ffcc66',
    },
    {buttonEffect: 'glow', background: 'waves', energy: 'party'},
  ),
  forest: preset(
    'forest',
    'Forest',
    {
      bg: '#0c140f',
      surface: '#122016',
      text: '#eaf4ec',
      textDim: '#8aa992',
      textMuted: '#63806b',
      accent: '#2e9e4f',
      focus: '#a5d6a7',
      danger: '#e57373',
      success: '#43a047',
      warn: '#d4b106',
    },
    {buttonEffect: 'flat', background: 'waves', energy: 'normal'},
  ),
  sunset: preset(
    'sunset',
    'Sunset',
    {
      bg: '#1a0f0b',
      surface: '#241512',
      text: '#fdeee6',
      textDim: '#c08a72',
      textMuted: '#9a6a55',
      accent: '#f4511e',
      focus: '#ffb74d',
      danger: '#ff5252',
      success: '#43a047',
      warn: '#ffca28',
    },
    {buttonEffect: 'glow', background: 'sweep', energy: 'normal'},
  ),
  ocean: preset(
    'ocean',
    'Ocean',
    {
      bg: '#07161c',
      surface: '#0e2028',
      text: '#e6f7fb',
      textDim: '#86a9b4',
      textMuted: '#5f8089',
      accent: '#00acc1',
      focus: '#4dd0e1',
      danger: '#ff6b6b',
      success: '#009688',
      warn: '#ffd54f',
    },
    {buttonEffect: 'flat', background: 'waves', energy: 'calm'},
  ),
  daylight: preset(
    'daylight',
    'Daylight',
    {
      bg: '#eef1f6',
      surface: '#ffffff',
      text: '#16161d',
      textDim: '#55556a',
      textMuted: '#7a7a8c',
      accent: '#165a8c',
      focus: '#ff8f00',
      danger: '#c62828',
      success: '#2e7d32',
      warn: '#b26a00',
    },
    {buttonEffect: 'outline', background: 'none', energy: 'normal'},
  ),
};

export const PRESET_LIST: Theme[] = [
  PRESETS.classic,
  PRESETS.midnight,
  PRESETS.nord,
  PRESETS.synthwave,
  PRESETS.forest,
  PRESETS.sunset,
  PRESETS.ocean,
  PRESETS.daylight,
];

export const DEFAULT_THEME: Theme = PRESETS.classic;

/* ---------------------------------------------------------------------------
 * Choices offered by the Themes screen.
 * ------------------------------------------------------------------------- */
export const ACCENT_SWATCHES = [
  '#165a8c', '#3d7bff', '#00acc1', '#00bfa5', '#2e9e4f', '#43a047',
  '#ffb02e', '#f4511e', '#e50914', '#ff2e97', '#7c4dff', '#c6ff00', RAINBOW,
];

export const BG_SWATCHES = [
  '#0b0b0f', '#000000', '#12161c', '#14082a', '#0c140f', '#1a0f0b',
  '#07161c', '#1c1c22', '#241d33', '#0f1a2b', '#eef1f6', '#f5f0e8', RAINBOW,
];

export const SURFACE_SWATCHES = [
  '#16161d', '#0e0e12', '#1b222c', '#1e0f3a', '#122016', '#241512',
  '#0e2028', '#232337', '#2a2440', '#12263a', '#ffffff', '#f0ede6', RAINBOW,
];

export const FOCUS_SWATCHES = [
  '#ffb02e', '#ffb74d', '#ff8f00', '#e50914', '#7c4dff', '#6ea8ff',
  '#88c0d0', '#00e5ff', '#4dd0e1', '#a5d6a7', '#ffffff', '#0b0b0f', RAINBOW,
];

export const BUTTON_EFFECTS: {id: ButtonEffect; label: string}[] = [
  {id: 'flat', label: 'Flat'},
  {id: 'glow', label: 'Glow'},
  {id: 'outline', label: 'Outline'},
];

export const BACKGROUNDS: {id: BackgroundEffect; label: string}[] = [
  {id: 'none', label: 'Off'},
  {id: 'aurora', label: 'Aurora'},
  {id: 'waves', label: 'Waves'},
  {id: 'sweep', label: 'Sweep'},
];

export const ENERGIES: {id: WaveEnergy; label: string}[] = [
  {id: 'calm', label: 'Calm'},
  {id: 'normal', label: 'Normal'},
  {id: 'party', label: 'Party'},
];

/* ---------------------------------------------------------------------------
 * Persistence.
 * ------------------------------------------------------------------------- */
const THEME_PATH = '/data/theme.json';

const isButtonEffect = (v: any): v is ButtonEffect =>
  v === 'flat' || v === 'glow' || v === 'outline';
const isBackground = (v: any): v is BackgroundEffect =>
  v === 'none' || v === 'aurora' || v === 'waves' || v === 'sweep';
const isEnergy = (v: any): v is WaveEnergy =>
  v === 'calm' || v === 'normal' || v === 'party';

/**
 * Coerce whatever is on disk into a complete theme. A hand-edited or older
 * file can't be allowed to drop a colour and paint something unreadable, so
 * anything missing falls back to the Classic value.
 */
export const normalizeTheme = (raw: any): Theme => {
  const base = DEFAULT_THEME;
  if (!raw || typeof raw !== 'object') {
    return {...base, palette: {...base.palette}};
  }
  const rawPalette = raw.palette && typeof raw.palette === 'object' ? raw.palette : {};
  const palette = {...base.palette} as ThemePalette;
  (Object.keys(base.palette) as (keyof ThemePalette)[]).forEach(k => {
    const v = rawPalette[k];
    if (v === RAINBOW) {
      palette[k] = RAINBOW;
    } else if (typeof v === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(v.trim())) {
      palette[k] = v.startsWith('#') ? v : `#${v}`;
    }
  });
  return {
    preset: typeof raw.preset === 'string' && raw.preset ? raw.preset : base.preset,
    name: typeof raw.name === 'string' && raw.name ? raw.name : base.name,
    palette,
    buttonEffect: isButtonEffect(raw.buttonEffect) ? raw.buttonEffect : base.buttonEffect,
    background: isBackground(raw.background) ? raw.background : base.background,
    energy: isEnergy(raw.energy) ? raw.energy : base.energy,
  };
};

const saveTheme = async (theme: Theme) => {
  try {
    // Same pattern as the pairing file: remove first, writeStringToFile does
    // not overwrite an existing file on Kepler.
    await KeplerFileSystem.removeFile(THEME_PATH).catch(() => {});
    await KeplerFileSystem.writeStringToFile(THEME_PATH, JSON.stringify(theme), 'UTF-8');
  } catch (e: any) {
    console.warn(`[FYAISA] could not save theme: ${e?.message || e}`);
  }
};

const loadTheme = async (): Promise<Theme | null> => {
  try {
    if (!(await KeplerFileSystem.exists(THEME_PATH))) {
      return null;
    }
    const raw = await KeplerFileSystem.readFileAsString(THEME_PATH, 'UTF-8');
    return normalizeTheme(JSON.parse(raw));
  } catch (e: any) {
    console.warn(`[FYAISA] could not read theme: ${e?.message || e}`);
    return null;
  }
};

/* ---------------------------------------------------------------------------
 * Context.
 * ------------------------------------------------------------------------- */
/** A change a caller can make: any top-level field, with the palette partial. */
export type ThemePatch = Partial<Omit<Theme, 'palette'>> & {palette?: Partial<ThemePalette>};

type ThemeContextValue = {
  theme: Theme;
  resolved: ResolvedTheme;
  styles: any;
  /** Current hue colour (what the rainbow swatch tiles show). */
  rainbowHex: string;
  setTheme: (t: Theme) => void;
  applyPreset: (id: string) => void;
  patch: (p: ThemePatch) => void;
  resetTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const useAppTheme = (): ThemeContextValue => {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useAppTheme must be used inside a ThemeProvider');
  }
  return value;
};

/**
 * Holds the active theme, loads/saves it to disk, and publishes the resolved
 * stylesheet. `makeStyles` lives in App.tsx (it knows the layout) and is
 * re-run whenever the palette changes.
 */
export const ThemeProvider = ({
  makeStyles,
  children,
}: {
  makeStyles: (theme: ResolvedTheme) => any;
  children: React.ReactNode;
}) => {
  const [theme, setThemeState] = useState<Theme>(() => ({
    ...DEFAULT_THEME,
    palette: {...DEFAULT_THEME.palette},
  }));
  const [ready, setReady] = useState(false);
  const [hue, setHue] = useState(0);

  const rainbowActive = useMemo(
    () => (Object.values(theme.palette) as string[]).some(isRainbow),
    [theme],
  );

  // While any colour channel is set to "rainbow", keep a hue clock advancing
  // (a full smooth sweep every ~5 s). The resolved palette below re-derives
  // from it every frame, so every use of that channel animates in place.
  useEffect(() => {
    if (!rainbowActive) return;
    const start = Date.now();
    const iv = setInterval(() => setHue(((Date.now() - start) / 5000) % 1), 33);
    return () => clearInterval(iv);
  }, [rainbowActive]);

  // Restore the saved theme once, on launch.
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await loadTheme();
      if (alive && saved) {
        setThemeState(saved);
      }
      if (alive) {
        setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Persist on every change, but only after the initial restore so we don't
  // clobber a saved theme with the default before it loads.
  useEffect(() => {
    if (ready) {
      saveTheme(theme);
    }
  }, [theme, ready]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);

  const applyPreset = useCallback((id: string) => {
    const p = PRESETS[id] ?? DEFAULT_THEME;
    setThemeState({...p, palette: {...p.palette}});
  }, []);

  /**
   * Change individual settings. The palette is merged shallowly so callers can
   * pass just the one colour they touched; any manual edit flips the theme to
   * "Custom" so the preset list stops claiming a preset is active.
   */
  const patch = useCallback((p: ThemePatch) => {
    setThemeState(prev => {
      const next: Theme = {
        ...prev,
        ...p,
        palette: {...prev.palette, ...(p.palette ?? {})},
      };
      next.preset = 'custom';
      next.name = 'Custom';
      return next;
    });
  }, []);

  const resetTheme = useCallback(() => applyPreset(DEFAULT_THEME.preset), [applyPreset]);

  const resolved = useMemo(() => resolveTheme(theme, hue), [theme, hue]);
  const styles = useMemo(() => makeStyles(resolved), [resolved, makeStyles]);
  const rainbowHex = hueToHex(hue * 360);

  const value = useMemo<ThemeContextValue>(
    () => ({theme, resolved, styles, rainbowHex, setTheme, applyPreset, patch, resetTheme}),
    [theme, resolved, styles, rainbowHex, setTheme, applyPreset, patch, resetTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
