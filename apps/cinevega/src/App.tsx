/**
 * Cinevega for Vega OS
 * --------------------
 * A native React Native frontend for streaming Movies / TV / Anime.
 * Uses TMDB for metadata and VidSrc for video playback.
 *
 * Screens:
 * - Home: Content rows (Trending, Popular Movies, Popular TV)
 * - Search: Text search with results grid
 * - Detail: Movie/TV metadata, episodes, and play button
 * - Player: Video playback via VidSrc embed
 */
import {WebView} from '@amazon-devices/webview';
import * as React from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {Pressable} from '@amazon-devices/react-native-kepler';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
  useTVEventHandler,
  type HWEvent,
} from '@amazon-devices/react-native-kepler';
import {KeplerFileSystem} from '@amazon-devices/kepler-file-system';
import {Fyaisa, FyaisaError} from './fyaisaClient';

// --- Config ------------------------------------------------------------------
const TMDB_API_KEY = 'a7a6a0d8b0326f1e9f356cacd724b233';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

const BRIDGE_PORT = 47821;
const CINEVEGA_APP_ID = 'app.cinevega.main';
const HUB_CATALOG_URL =
  'https://raw.githubusercontent.com/AaronYTDev/FYAISA/main/catalog.json';
const STORE_PATH = '/data/bridge.json';
const APP_VERSION = '1.0.4';

// --- TMDB cache ---------------------------------------------------------------
// TMDB responses are cached to this app's private /data so the home screen
// loads instantly on relaunch and keeps working when the stick is offline or
// TMDB is slow. Each endpoint is stored as {expiresAt, data} keyed by a
// sanitized URL. TTLs: popular/trending 1 h, details 1 h, search 5 min.
const CACHE_DIR = '/data/cinevega-tmdb-cache';
const CACHE_TTL = {
  list: 60 * 60 * 1000,   // 1 h for trending / popular movies / popular TV
  detail: 60 * 60 * 1000, // 1 h for movie/TV details + seasons/episodes
  search: 5 * 60 * 1000,  // 5 min for search results
};
const cacheKey = (url: string) =>
  url.replace(/[^A-Za-z0-9]/g, '_').slice(0, 120);

const cacheGet = async (key: string): Promise<any | null> => {
  try {
    const file = `${CACHE_DIR}/${cacheKey(key)}.json`;
    if (!(await KeplerFileSystem.exists(file))) return null;
    const raw = await KeplerFileSystem.readFileAsString(file, 'UTF-8');
    const entry = JSON.parse(raw);
    if (entry.expiresAt && Date.now() < entry.expiresAt) return entry.data;
    return null;
  } catch {
    return null;
  }
};

const cacheSet = async (key: string, data: any, ttlMs: number) => {
  try {
    const file = `${CACHE_DIR}/${cacheKey(key)}.json`;
    await KeplerFileSystem.writeStringToFile(
      file,
      JSON.stringify({expiresAt: Date.now() + ttlMs, data}),
      'UTF-8',
    );
  } catch {
    // Cache write failures (e.g. cache dir not creatable) are non-fatal;
    // the app falls back to a live TMDB fetch.
  }
};

const fetchCached = async (url: string, ttlMs: number): Promise<any> => {
  const cached = await cacheGet(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  await cacheSet(url, data, ttlMs);
  return data;
};

// --- Types -------------------------------------------------------------------
type MediaItem = {
  id: number;
  title: string;
  name?: string;
  media_type: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string;
  backdrop_path?: string;
  overview?: string;
  vote_average?: number;
  genre_ids?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
};

type Episode = {
  id: number;
  season_number: number;
  episode_number: number;
  name: string;
  overview?: string;
  still_path?: string;
};

type Season = {
  season_number: number;
  name: string;
  episodes?: Episode[];
};

// --- TMDB API ----------------------------------------------------------------
const tmdb = {
  async trending(): Promise<MediaItem[]> {
    const data = await fetchCached(
      `${TMDB_BASE}/trending/all/week?api_key=${TMDB_API_KEY}`,
      CACHE_TTL.list,
    );
    return (data.results || []).map((item: any) => ({
      id: item.id,
      title: item.title || item.name || '',
      name: item.name,
      media_type: item.media_type,
      release_date: item.release_date,
      first_air_date: item.first_air_date,
      poster_path: item.poster_path,
      backdrop_path: item.backdrop_path,
      overview: item.overview,
      vote_average: item.vote_average,
      genre_ids: item.genre_ids,
      number_of_seasons: item.number_of_seasons,
      number_of_episodes: item.number_of_episodes,
    }));
  },

  async popularMovies(): Promise<MediaItem[]> {
    const data = await fetchCached(
      `${TMDB_BASE}/movie/popular?api_key=${TMDB_API_KEY}`,
      CACHE_TTL.list,
    );
    return (data.results || []).map((item: any) => ({
      id: item.id,
      title: item.title || '',
      media_type: 'movie',
      release_date: item.release_date,
      poster_path: item.poster_path,
      backdrop_path: item.backdrop_path,
      overview: item.overview,
      vote_average: item.vote_average,
      genre_ids: item.genre_ids,
    }));
  },

  async popularTV(): Promise<MediaItem[]> {
    const data = await fetchCached(
      `${TMDB_BASE}/tv/popular?api_key=${TMDB_API_KEY}`,
      CACHE_TTL.list,
    );
    return (data.results || []).map((item: any) => ({
      id: item.id,
      title: item.name || '',
      media_type: 'tv',
      first_air_date: item.first_air_date,
      poster_path: item.poster_path,
      backdrop_path: item.backdrop_path,
      overview: item.overview,
      vote_average: item.vote_average,
      genre_ids: item.genre_ids,
      number_of_seasons: item.number_of_seasons,
      number_of_episodes: item.number_of_episodes,
    }));
  },

  async search(query: string): Promise<MediaItem[]> {
    const data = await fetchCached(
      `${TMDB_BASE}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`,
      CACHE_TTL.search,
    );
    return (data.results || [])
      .filter((item: any) => item.media_type === 'movie' || item.media_type === 'tv')
      .map((item: any) => ({
        id: item.id,
        title: item.title || item.name || '',
        name: item.name,
        media_type: item.media_type,
        release_date: item.release_date,
        first_air_date: item.first_air_date,
        poster_path: item.poster_path,
        backdrop_path: item.backdrop_path,
        overview: item.overview,
        vote_average: item.vote_average,
        genre_ids: item.genre_ids,
      }));
  },

  async movieDetails(id: number): Promise<MediaItem> {
    const item = await fetchCached(
      `${TMDB_BASE}/movie/${id}?api_key=${TMDB_API_KEY}`,
      CACHE_TTL.detail,
    );
    return {
      id: item.id,
      title: item.title || '',
      media_type: 'movie',
      release_date: item.release_date,
      poster_path: item.poster_path,
      backdrop_path: item.backdrop_path,
      overview: item.overview,
      vote_average: item.vote_average,
      genre_ids: item.genres?.map((g: any) => g.id),
    };
  },

  async tvDetails(id: number): Promise<MediaItem> {
    const item = await fetchCached(
      `${TMDB_BASE}/tv/${id}?api_key=${TMDB_API_KEY}`,
      CACHE_TTL.detail,
    );
    return {
      id: item.id,
      title: item.name || '',
      media_type: 'tv',
      first_air_date: item.first_air_date,
      poster_path: item.poster_path,
      backdrop_path: item.backdrop_path,
      overview: item.overview,
      vote_average: item.vote_average,
      genre_ids: item.genres?.map((g: any) => g.id),
      number_of_seasons: item.number_of_seasons,
      number_of_episodes: item.number_of_episodes,
    };
  },

  async tvSeasons(id: number): Promise<Season[]> {
    const data = await fetchCached(
      `${TMDB_BASE}/tv/${id}?api_key=${TMDB_API_KEY}`,
      CACHE_TTL.detail,
    );
    return (data.seasons || [])
      .filter((s: any) => s.season_number > 0)
      .map((s: any) => ({
        season_number: s.season_number,
        name: s.name,
      }));
  },

  async seasonEpisodes(tvId: number, seasonNumber: number): Promise<Episode[]> {
    const data = await fetchCached(
      `${TMDB_BASE}/tv/${tvId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`,
      CACHE_TTL.detail,
    );
    return (data.episodes || []).map((ep: any) => ({
      id: ep.id,
      season_number: ep.season_number,
      episode_number: ep.episode_number,
      name: ep.name,
      overview: ep.overview,
      still_path: ep.still_path,
    }));
  },
};

// --- VidSrc ------------------------------------------------------------------
// VidSrc embed URLs. Domains change often, so we keep a list of mirrors and
// try them in order when a video fails to load.
const VIDSRC_BASES = [
  'https://vidsrc.to/embed',
  'https://vidsrc.cc/embed',
  'https://vidsrc.xyz/embed',
  'https://vidsrc.pro/embed',
  'https://vidsrc.net/embed',
];

const vidsrc = {
  movieUrl(tmdbId: number, base: string): string {
    return `${base}/movie/${tmdbId}`;
  },
  tvUrl(tmdbId: number, season: number, episode: number, base: string): string {
    return `${base}/tv/${tmdbId}/${season}/${episode}`;
  },
};

/**
 * Build the embed URL for one mirror attempt. Attempts wrap at the list end so
 * a manual retry after all mirrors failed starts over at the first one.
 */
const buildPlayerUrl = (
  item: MediaItem,
  episode: Episode | null,
  attempt: number,
): string => {
  const base = VIDSRC_BASES[attempt % VIDSRC_BASES.length];
  return episode
    ? vidsrc.tvUrl(item.id, episode.season_number, episode.episode_number, base)
    : vidsrc.movieUrl(item.id, base);
};

// Subresources on a dying mirror can fire several error events in one burst;
// one failure per mirror per second is enough to walk the list.
const PLAYER_FAILURE_COOLDOWN_MS = 1000;

/** Home LANs are almost always 192.168.x.y. Open the ElevSH box with that much. */
const HOST_PREFIX = '192.168.';
/** Bare host only: strip anything pasted from a browser or the CLI. */
const normalizeHost = (raw: string): string =>
  String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .trim();
/** True only when the catalog advertises a newer build than the one installed. */
const isNewerVersion = (remote: string, local: string): boolean => {
  const parse = (v: string) =>
    String(v || '')
      .split('+')[0]
      .split('-')[0]
      .split('.')
      .map(part => parseInt(part, 10) || 0);
  const a = parse(remote);
  const b = parse(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
};

/** Reject junk before a pairing request wasting a round trip. */
const hostFilled = (h: string): boolean => {
  const host = normalizeHost(h);
  if (host === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every(part => parseInt(part, 10) <= 255);
  }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host);
};

/**
 * Injected into the VidSrc WebView on every load. The native side owns the
 * visible cursor: it moves a React Native overlay on D-pad presses and calls
 * __cinevegaSetCursorRatio so this page clicks at the exact same spot. OK clicks
 * the play control (or whatever is under the pointer); Menu toggles cursor mode.
 * Clicks are single-flighted so the page's keydown handler and the native remote
 * hook cannot fire twice. The DOM cursor here is only a fallback click anchor.
 */
const PLAYER_CURSOR_SCRIPT = `
(function () {
  var mode = 'cursor';
  var cur = {x: -1, y: -1};
  var cursorEl = null;
  var toastEl = null;
  var toastTimer = 0;
  var lastClick = 0;
  var lastActivity = 0;

  function post(obj) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch (e) {}
  }
  function log(msg) { post({type: 'LOG', message: msg}); }
  function activity() {
    var now = Date.now();
    if (now - lastActivity > 250) {
      lastActivity = now;
      post({type: 'PLAYER_ACTIVITY'});
    }
  }

  function toast(text) {
    try {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      window.clearTimeout(toastTimer);
      toastEl = document.createElement('div');
      toastEl.textContent = text;
      toastEl.style.cssText =
        'position:fixed;left:50%;top:7%;transform:translateX(-50%);' +
        'z-index:2147483647;pointer-events:none;' +
        'background:rgba(0,0,0,0.82);color:#fff;' +
        'font:600 16px sans-serif;padding:10px 18px;border-radius:999px;';
      (document.body || document.documentElement).appendChild(toastEl);
      toastTimer = window.setTimeout(function () {
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
        toastEl = null;
      }, 1600);
    } catch (e) {}
  }

  var ARROW_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='22' height='24'>" +
    "<path d='M3 1 L3 19 L8 14.5 L11 21 L14.5 20 L11.5 14 L18 13.5 Z' " +
    "fill='white' stroke='black' stroke-width='1.4' stroke-linejoin='round'/></svg>";

  function ensureCursor() {
    if (cursorEl && cursorEl.parentNode) return;
    cursorEl = document.createElement('div');
    cursorEl.style.cssText =
      'position:fixed;width:22px;height:24px;z-index:2147483647;' +
      'pointer-events:none;display:none;background-repeat:no-repeat;' +
      'background-image:url("data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(ARROW_SVG) + '");';
    (document.body || document.documentElement).appendChild(cursorEl);
  }

  function drawCursor() {
    ensureCursor();
    cursorEl.style.left = cur.x + 'px';
    cursorEl.style.top = cur.y + 'px';
    cursorEl.style.display = 'block';
  }

  function moveCursor(key) {
    var step = 48;
    if (key === 'ArrowUp') cur.y -= step;
    if (key === 'ArrowDown') cur.y += step;
    if (key === 'ArrowLeft') cur.x -= step;
    if (key === 'ArrowRight') cur.x += step;
    cur.x = Math.max(0, Math.min(window.innerWidth - 1, cur.x));
    cur.y = Math.max(0, Math.min(window.innerHeight - 1, cur.y));
    drawCursor();
    activity();
  }

  // Native overlay is the source of truth for position. It sends normalized
  // coordinates so CSS px vs RN dp scaling cannot desync the click target.
  window.__cinevegaSetCursorRatio = function (fx, fy) {
    if (typeof fx !== 'number' || typeof fy !== 'number') return;
    cur.x = Math.max(0, Math.min(window.innerWidth - 1, fx * window.innerWidth));
    cur.y = Math.max(0, Math.min(window.innerHeight - 1, fy * window.innerHeight));
    if (mode === 'cursor') drawCursor();
  };

  window.__cinevegaToggleCursor = function () {
    mode = mode === 'cursor' ? 'page' : 'cursor';
    post({type: 'PLAYER_CURSOR_MODE', on: mode === 'cursor'});
    if (mode === 'cursor') {
      if (cur.x < 0) {
        cur.x = Math.floor(window.innerWidth / 2);
        cur.y = Math.floor(window.innerHeight / 2);
      }
      drawCursor();
      toast('Cursor mode: arrows move, OK clicks');
    } else {
      if (cursorEl && cursorEl.parentNode) cursorEl.style.display = 'none';
      toast('D-pad controls the player');
    }
    activity();
    log('cursor mode ' + mode);
  };

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    var s = window.getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }

  function playButton() {
    var list = document.querySelectorAll(
      'button,[role=button],a,input[type=button],input[type=submit]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var text = ((el.textContent || el.value || '') + ' ' +
        (el.getAttribute('aria-label') || '')).toLowerCase();
      if (/play|start|resume|watch|continue|click here|unmute/.test(text)) {
        return el;
      }
    }
    return null;
  }

  function dispatchClick(target, x, y) {
    target.dispatchEvent(new MouseEvent('mousemove',
      {bubbles: true, cancelable: true, clientX: x, clientY: y}));
    target.dispatchEvent(new PointerEvent('pointerdown',
      {bubbles: true, cancelable: true, clientX: x, clientY: y,
       button: 0, buttons: 1, pointerId: 1, isPrimary: true,
       pointerType: 'mouse'}));
    target.dispatchEvent(new MouseEvent('mousedown',
      {bubbles: true, cancelable: true, clientX: x, clientY: y,
       button: 0, buttons: 1}));
    target.dispatchEvent(new PointerEvent('pointerup',
      {bubbles: true, cancelable: true, clientX: x, clientY: y,
       button: 0, buttons: 0, pointerId: 1, isPrimary: true,
       pointerType: 'mouse'}));
    target.dispatchEvent(new MouseEvent('mouseup',
      {bubbles: true, cancelable: true, clientX: x, clientY: y,
       button: 0, buttons: 0}));
    target.dispatchEvent(new MouseEvent('click',
      {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0}));
  }

  window.__cinevegaClick = function () {
    var now = Date.now();
    if (now - lastClick < 350) {
      log('click ignored (double)');
      return;
    }
    lastClick = now;
    activity();
    try {
      var target = null;
      var x = 0;
      var y = 0;
      var how = '';
      if (mode === 'cursor') {
        x = cur.x;
        y = cur.y;
        target = document.elementFromPoint(x, y);
        how = 'cursor';
      } else {
        target = playButton();
        if (target) {
          var r = target.getBoundingClientRect();
          x = Math.floor(r.left + r.width / 2);
          y = Math.floor(r.top + r.height / 2);
          how = 'play button';
        } else {
          var video = document.querySelector('video');
          if (video && video.paused) {
            try {
              var p = video.play();
              if (p && p.catch) p.catch(function () {});
            } catch (e) {}
            log('click: video.play()');
            return;
          }
          x = Math.floor(window.innerWidth / 2);
          y = Math.floor(window.innerHeight / 2);
          target = document.elementFromPoint(x, y);
          how = 'center';
        }
      }
      if (!target) {
        log('click: nothing under ' + how);
        return;
      }
      var tag = target.tagName || '';
      var role = target.getAttribute && target.getAttribute('role');
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' ||
          tag === 'LABEL' || role === 'button' || target.onclick) {
        target.click();
      } else {
        dispatchClick(target, x, y);
      }
      log('click: ' + how + ' -> ' + tag + '.' + (target.className || '-'));
    } catch (e) {
      log('click failed: ' + e);
    }
  };

  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.__cinevegaClick();
      return;
    }
    if (k === 'ArrowUp' || k === 'ArrowDown' ||
        k === 'ArrowLeft' || k === 'ArrowRight') {
      if (mode === 'cursor') {
        e.preventDefault();
        e.stopImmediatePropagation();
        moveCursor(k);
      } else {
        activity();
      }
      return;
    }
    activity();
  }, true);

  post({type: 'PLAYER_CURSOR_MODE', on: true});
  log('player cursor script ready');
  true;
})();
`;
const PLAYER_CLICK_SCRIPT =
  'window.__cinevegaClick&&window.__cinevegaClick();true;';
const PLAYER_CURSOR_TOGGLE_SCRIPT =
  'window.__cinevegaToggleCursor&&window.__cinevegaToggleCursor();true;';
const buildCursorSetScript = (x: number, y: number) =>
  `window.__cinevegaSetCursorRatio&&window.__cinevegaSetCursorRatio(${x.toFixed(4)},${y.toFixed(4)});true;`;
/** One D-pad press moves the overlay ~6% of the viewport. */
const CURSOR_STEP = 0.06;
const moveCursorPos = (
  pos: {x: number; y: number},
  type: string | undefined,
): {x: number; y: number} => {
  let {x, y} = pos;
  if (type === 'up' || type === 'ArrowUp') y -= CURSOR_STEP;
  else if (type === 'down' || type === 'ArrowDown') y += CURSOR_STEP;
  else if (type === 'left' || type === 'ArrowLeft') x -= CURSOR_STEP;
  else if (type === 'right' || type === 'ArrowRight') x += CURSOR_STEP;
  else return pos;
  return {x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y))};
};
/** Native chrome hides this long after the last remote or cursor activity. */
const PLAYER_CHROME_MS = 4000;

// --- ElevSH pairing persistence ----------------------------------------------
type SavedPair = {host: string; token?: string};

const savePair = async (p: SavedPair) => {
  try {
    await KeplerFileSystem.removeFile(STORE_PATH).catch(() => {});
    await KeplerFileSystem.writeStringToFile(STORE_PATH, JSON.stringify(p), 'UTF-8');
  } catch {}
};

const loadPair = async (): Promise<SavedPair | null> => {
  try {
    if (!(await KeplerFileSystem.exists(STORE_PATH))) return null;
    const p = JSON.parse(await KeplerFileSystem.readFileAsString(STORE_PATH, 'UTF-8'));
    return p && p.host ? (p as SavedPair) : null;
  } catch {
    return null;
  }
};

const clearPair = async () => {
  try {
    await KeplerFileSystem.removeFile(STORE_PATH);
  } catch {}
};

// --- TV focus ring -----------------------------------------------------------
const focusRing = ({focused}: {focused: boolean}) =>
  [styles.focusBase, focused && styles.focusedRing];
const menuFocus = ({focused}: {focused: boolean}) =>
  [styles.menuBtnWrap, focusRing({focused})];

// --- Main App ----------------------------------------------------------------
export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [screen, setScreen] = useState<'home' | 'search' | 'detail' | 'player'>('home');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // FYAISA panel
  const [menu, setMenu] = useState<'hidden' | 'menu' | 'pair'>('menu');
  const [pair, setPair] = useState<SavedPair | null>(null);
  const [pairHost, setPairHost] = useState(HOST_PREFIX);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [hubStatus, setHubStatus] = useState('Checking the FYAISA hub…');
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [job, setJob] = useState<{status: string; log: string[]} | null>(null);

  // Home screen data
  const [trending, setTrending] = useState<MediaItem[]>([]);
  const [popularMovies, setPopularMovies] = useState<MediaItem[]>([]);
  const [popularTV, setPopularTV] = useState<MediaItem[]>([]);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MediaItem[]>([]);

  // Detail
  const [detailItem, setDetailItem] = useState<MediaItem | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [episodes, setEpisodes] = useState<Episode[]>([]);

  // Player
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const [playerTitle, setPlayerTitle] = useState('');
  const [playerItem, setPlayerItem] = useState<MediaItem | null>(null);
  const [playerEpisode, setPlayerEpisode] = useState<Episode | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playerNotice, setPlayerNotice] = useState<string | null>(null);
  const [playerChromeVisible, setPlayerChromeVisible] = useState(true);
  const [cursorMode, setCursorMode] = useState(true);
  const [cursorPos, setCursorPos] = useState({x: 0.5, y: 0.5});
  const playerWebRef = useRef<any>(null);
  const playerChromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorModeRef = useRef(true);
  const cursorPosRef = useRef({x: 0.5, y: 0.5});
  const {width: winWidth, height: winHeight} = useWindowDimensions();
  const playerAttemptRef = useRef(0);
  const lastPlayerFailRef = useRef(0);

  // Load home data
  useEffect(() => {
    loadHomeData();
  }, []);

  const loadHomeData = async () => {
    setLoading(true);
    try {
      const [trend, movies, tv] = await Promise.all([
        tmdb.trending(),
        tmdb.popularMovies(),
        tmdb.popularTV(),
      ]);
      setTrending(trend);
      setPopularMovies(movies);
      setPopularTV(tv);
    } catch (e: any) {
      setError(e?.message || 'Failed to load content');
    } finally {
      setLoading(false);
      hideSplashScreenCallback();
    }
  };

  // FYAISA panel: load saved pairing + check hub
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(HUB_CATALOG_URL);
        const cat = await res.json();
        if (cancelled) return;
        const entry = (cat.apps || []).find((a: any) => a.id === CINEVEGA_APP_ID);
        const hubVersion = entry?.version;
        setHubStatus(
          `FYAISA hub: ${(cat.apps || []).length} app(s) · Cinevega ${
            hubVersion ? `v${hubVersion}` : 'listed'
          }`,
        );
        if (hubVersion && isNewerVersion(hubVersion, APP_VERSION)) {
          setUpdateVersion(hubVersion);
        }
      } catch {
        if (!cancelled) setHubStatus('FYAISA hub unreachable (offline?)');
      }

      const saved = await loadPair();
      if (cancelled || !saved) return;
      if (saved.token) {
        setPair(saved);
        verifyPair(saved);
        return;
      }
      setPairHost(saved.host);
      startPair(saved.host);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Back handling.
  //
  // The player runs with allowSystemKeyEvents={false} so the VidSrc page gets
  // the D-pad and Enter it needs — but that also traps focus inside the
  // WebView, so the on-screen Back button can't be D-pad-reached while a
  // video plays. Catch Back natively here so the hardware Back button always
  // exits the player, no matter where focus is.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (menu !== 'hidden') {
        setMenu('hidden');
        return true;
      }
      if (screen === 'player') {
        setScreen('detail');
        return true;
      }
      if (screen === 'detail') {
        setScreen('home');
        return true;
      }
      if (screen === 'search') {
        setScreen('home');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [screen, menu]);

  // Player chrome hides while a movie plays and comes back on remote activity.
  // Any event in the player counts; page-side arrow/cursor moves post the same
  // reveal through onMessage. Errors and mirror notices hold it open.
  const revealPlayerChrome = useCallback(() => {
    setPlayerChromeVisible(true);
    if (playerChromeTimerRef.current) clearTimeout(playerChromeTimerRef.current);
    playerChromeTimerRef.current = setTimeout(() => {
      setPlayerChromeVisible(false);
    }, PLAYER_CHROME_MS);
  }, []);

  useEffect(() => {
    if (screen !== 'player' || playerError || playerNotice) {
      if (playerChromeTimerRef.current) clearTimeout(playerChromeTimerRef.current);
      playerChromeTimerRef.current = null;
      setPlayerChromeVisible(true);
      return;
    }
    revealPlayerChrome();
    return () => {
      if (playerChromeTimerRef.current) clearTimeout(playerChromeTimerRef.current);
      playerChromeTimerRef.current = null;
    };
  }, [screen, playerError, playerNotice, revealPlayerChrome]);

  // TV event handler for the player. The native overlay is the cursor: D-pad
  // presses move it and mirror the position into the page so OK clicks at the
  // same spot. Menu toggles cursor mode, OK clicks, Back exits. The injected
  // page script single-flights clicks, so its Enter handler cannot double-fire.
  useTVEventHandler(
    useCallback((event: HWEvent) => {
      if (event.eventKeyAction !== 0) {
        return; // act on the press, not the release
      }
      if (screen !== 'player') {
        return;
      }
      revealPlayerChrome();
      const type = event.eventType;
      if (type === 'back') {
        setScreen('detail');
        return;
      }
      const web = playerWebRef.current as any;
      if (!web?.injectJavaScript) return;
      try {
        if (type === 'menu') {
          web.injectJavaScript(PLAYER_CURSOR_TOGGLE_SCRIPT);
        } else if (type === 'select') {
          web.injectJavaScript(PLAYER_CLICK_SCRIPT);
        } else if (cursorModeRef.current) {
          const next = moveCursorPos(cursorPosRef.current, type);
          if (next !== cursorPosRef.current) {
            cursorPosRef.current = next;
            setCursorPos(next);
            web.injectJavaScript(buildCursorSetScript(next.x, next.y));
          }
        }
      } catch (err) {
        console.warn('[cinevega] remote inject failed:', err);
      }
    }, [screen, revealPlayerChrome]),
  );

  // Discover the bridge on this PC via the reverse tunnel (fyaisa connect
  // --lan exposes it on the Fire TV's own 127.0.0.1:47821). Tries once on
  // launch and offers a Discover button in the pairing menu, so no IP typing.
  const discoverBridge = useCallback(async () => {
    const host = '127.0.0.1';
    try {
      setHubStatus('Looking for ElevSH on this PC…');
      const res = await fetch(`http://${host}:${BRIDGE_PORT}/ping`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      console.info('[cinevega] discovered ElevSH on 127.0.0.1');
      setPairHost(host);
      setHubStatus(`ElevSH found at ${host}:${BRIDGE_PORT} — press Connect`);
    } catch {
      setHubStatus('No ElevSH found on this PC — run `fyaisa connect --lan`, or type the address below.');
    }
  }, []);

  // Restore a previous pairing on launch; auto-discover if there's no saved
  // pairing and no host typed yet.
  useEffect(() => {
    let dead = false;
    (async () => {
      const saved = await loadPair();
      if (dead || saved) return;
      // No saved pairing: try the reverse tunnel first, so the user never has
      // to type an address when `fyaisa connect --lan` is running.
      await discoverBridge();
    })();
    return () => {
      dead = true;
    };
  }, [discoverBridge]);

  const verifyPair = useCallback(async (sp: SavedPair) => {
    if (!sp.token) return;
    try {
      await Fyaisa.from({host: sp.host, token: sp.token, appId: CINEVEGA_APP_ID}).catalog();
      setHubStatus(prev => (prev && prev.startsWith('Allow') ? 'ElevSH connected' : prev));
    } catch (e: any) {
      if (e instanceof FyaisaError && e.status === 401) {
        await clearPair();
        setPair(null);
        setPairHost(HOST_PREFIX);
        setHubStatus('ElevSH pairing expired — pair again from the menu');
      } else if (e instanceof FyaisaError && e.code === 'access_denied') {
        setHubStatus('ElevSH access denied for Cinevega — allow it in FYAISA');
      } else if (e instanceof FyaisaError && e.code === 'access_required') {
        setHubStatus('Allow Cinevega in FYAISA → ElevSH');
      } else {
        setHubStatus('ElevSH offline right now');
      }
    }
  }, []);

  const startPair = useCallback(
    async (hostArg?: string) => {
      const host = normalizeHost(hostArg ?? pairHost);
      if (!hostFilled(host)) {
        setHubStatus('Enter a complete address, e.g. 192.168.1.50');
        return;
      }
      try {
        setHubStatus('Requesting ElevSH pairing…');
        const {code, autoApproved} = await Fyaisa.requestCode(host, BRIDGE_PORT, CINEVEGA_APP_ID);
        setPairCode(code);
        await savePair({host});
        setHubStatus(
          autoApproved
            ? 'ElevSH access already allowed — connecting…'
            : `Allow Cinevega in FYAISA → ElevSH (code ${code})`,
        );
        const p = await Fyaisa.waitForApproval(host, code, BRIDGE_PORT, 1000, 600000, {
          appId: CINEVEGA_APP_ID,
        });
        await savePair(p);
        setPair(p);
        setPairCode(null);
        setHubStatus('ElevSH connected — updates install through it');
        setMenu('menu');
        verifyPair(p);
      } catch (e: any) {
        setPairCode(null);
        setHubStatus(
          e instanceof FyaisaError && e.code === 'access_denied'
            ? 'ElevSH access denied for Cinevega — allow it in FYAISA'
            : `Pairing failed: ${e?.message || e}`,
        );
      }
    },
    [pairHost, verifyPair],
  );

  const forget = useCallback(async () => {
    await clearPair();
    setPair(null);
    setPairHost(HOST_PREFIX);
    setHubStatus('ElevSH pairing forgotten');
  }, []);

  const updateViaPc = useCallback(async () => {
    const token = pair?.token;
    if (!pair || !token) return;
    try {
      const fy = Fyaisa.from({host: pair.host, token, appId: CINEVEGA_APP_ID});
      const {jobId} = await fy.install(CINEVEGA_APP_ID);
      setJob({status: 'queued', log: []});
      const iv = setInterval(async () => {
        try {
          const j = await fy.job(jobId);
          setJob({status: j.status, log: (j.log || []).slice(-8)});
          if (j.status === 'done' || j.status === 'error') {
            clearInterval(iv);
          }
        } catch (e: any) {
          clearInterval(iv);
          setJob(prev => ({
            status: 'error',
            log: [...(prev?.log || []), 'bridge unreachable'],
          }));
        }
      }, 2500);
    } catch (e: any) {
      setJob({status: 'error', log: [String(e?.message || e)]});
    }
  }, [pair]);

  const openDetail = useCallback(async (item: MediaItem) => {
    setScreen('detail');
    setDetailItem(item);
    setSeasons([]);
    setEpisodes([]);
    setSelectedSeason(1);
    try {
      if (item.media_type === 'movie') {
        const details = await tmdb.movieDetails(item.id);
        setDetailItem(details);
      } else {
        const details = await tmdb.tvDetails(item.id);
        setDetailItem(details);
        const seasonList = await tmdb.tvSeasons(item.id);
        setSeasons(seasonList);
        if (seasonList.length > 0) {
          const eps = await tmdb.seasonEpisodes(item.id, seasonList[0].season_number);
          setEpisodes(eps);
          setSelectedSeason(seasonList[0].season_number);
        }
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load details');
    }
  }, []);

  /** Load one mirror for the current title. Also backs the manual retry. */
  const loadPlayerAttempt = useCallback(
    (attempt: number) => {
      if (!playerItem) return;
      playerAttemptRef.current = attempt;
      setPlayerError(null);
      setPlayerNotice(
        attempt > 0
          ? `Mirror ${attempt + 1}/${VIDSRC_BASES.length}`
          : null,
      );
      setPlayerUrl(buildPlayerUrl(playerItem, playerEpisode, attempt));
    },
    [playerItem, playerEpisode],
  );

  /**
   * Mirror domains rot independently. Advance automatically on a main-frame
   * failure and only surface the error once every mirror has been tried.
   */
  const handlePlayerFailure = useCallback(
    (reason: string) => {
      const now = Date.now();
      if (now - lastPlayerFailRef.current < PLAYER_FAILURE_COOLDOWN_MS) return;
      lastPlayerFailRef.current = now;
      console.warn(`[cinevega] ${reason}`);
      const next = playerAttemptRef.current + 1;
      if (next < VIDSRC_BASES.length) {
        loadPlayerAttempt(next);
      } else {
        setPlayerNotice(null);
        setPlayerError(`${reason} — all ${VIDSRC_BASES.length} mirrors failed.`);
      }
    },
    [loadPlayerAttempt],
  );

  // Vega's WebView fires onError/onHttpError for subresources too. A dead
  // tracker must not burn through the mirror list.
  const isMainFrameFailure = useCallback(
    (event: any): boolean => {
      const native = event?.nativeEvent || {};
      if (native.isMainFrame === false) return false;
      if (!native.url) return true;
      try {
        const current = new URL(playerUrl || VIDSRC_BASES[0]);
        return (new URL(native.url) as any).hostname === (current as any).hostname;
      } catch {
        return true;
      }
    },
    [playerUrl],
  );

  // Mirror changes remount the WebView contents. Re-inject on every load, and
  // restore cursor mode when a mirror swap happens mid-cursor.
  const handlePlayerLoad = useCallback(() => {
    const web = playerWebRef.current as any;
    if (!web?.injectJavaScript) {
      console.warn('[cinevega] injectJavaScript unavailable on player WebView');
      return;
    }
    try {
      // The script now boots in cursor mode, so mirror the native position in
      // and only toggle off if the user had switched back to D-pad control.
      web.injectJavaScript(PLAYER_CURSOR_SCRIPT);
      web.injectJavaScript(
        buildCursorSetScript(cursorPosRef.current.x, cursorPosRef.current.y),
      );
      if (!cursorModeRef.current) {
        web.injectJavaScript(PLAYER_CURSOR_TOGGLE_SCRIPT);
      }
    } catch (err) {
      console.warn('[cinevega] player inject failed:', err);
    }
  }, []);

  const handlePlayerMessage = useCallback(
    (event: any) => {
      let msg: any;
      try {
        msg = JSON.parse(event?.nativeEvent?.data || '');
      } catch {
        return; // not our JSON
      }
      if (msg?.type === 'PLAYER_CURSOR_MODE') {
        const on = !!msg.on;
        cursorModeRef.current = on;
        setCursorMode(on);
        revealPlayerChrome();
      } else if (msg?.type === 'PLAYER_ACTIVITY') {
        revealPlayerChrome();
      } else if (msg?.type === 'LOG') {
        console.info(`[cinevega] web: ${msg.message}`);
      }
    },
    [revealPlayerChrome],
  );

  const startPlayback = useCallback((item: MediaItem, episode: Episode | null) => {
    cursorModeRef.current = true;
    setCursorMode(true);
    cursorPosRef.current = {x: 0.5, y: 0.5};
    setCursorPos({x: 0.5, y: 0.5});
    setPlayerChromeVisible(true);
    setPlayerTitle(
      episode
        ? `${item.title} - S${episode.season_number} E${episode.episode_number}`
        : item.title,
    );
    setPlayerError(null);
    setPlayerNotice(null);
    setPlayerItem(item);
    setPlayerEpisode(episode);
    playerAttemptRef.current = 0;
    lastPlayerFailRef.current = 0;
    setPlayerUrl(buildPlayerUrl(item, episode, 0));
    setScreen('player');
  }, []);

  const playMovie = useCallback(
    (item: MediaItem) => startPlayback(item, null),
    [startPlayback],
  );

  const playEpisode = useCallback(
    (item: MediaItem, ep: Episode) => startPlayback(item, ep),
    [startPlayback],
  );

  const doSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setLoading(true);
    try {
      const results = await tmdb.search(query);
      setSearchResults(results);
    } catch (e: any) {
      setError(e?.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSeason = useCallback(
    async (seasonNumber: number) => {
      if (!detailItem) return;
      setSelectedSeason(seasonNumber);
      setLoading(true);
      try {
        const eps = await tmdb.seasonEpisodes(detailItem.id, seasonNumber);
        setEpisodes(eps);
      } catch (e: any) {
        setError(e?.message || 'Failed to load episodes');
      } finally {
        setLoading(false);
      }
    },
    [detailItem],
  );

  // --- Render: Home Screen ---------------------------------------------------
  const renderHome = () => (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.brand}>Cinevega</Text>
        <Text style={styles.tagline}>Movies · TV · Anime</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {loading && trending.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.dim}>Loading content…</Text>
          </View>
        ) : (
          <>
            {trending.length > 0 && (
              <ContentRow title="Trending" items={trending} onSelect={openDetail} />
            )}
            {popularMovies.length > 0 && (
              <ContentRow title="Popular Movies" items={popularMovies} onSelect={openDetail} />
            )}
            {popularTV.length > 0 && (
              <ContentRow title="Popular TV Shows" items={popularTV} onSelect={openDetail} />
            )}
          </>
        )}
      </ScrollView>

      <View style={styles.toolbar}>
        <Pressable
          focusable
          style={({focused}) => [styles.searchBtn, focused && styles.focusedRing]}
          onPress={() => setScreen('search')}>
          <Text style={styles.searchBtnText}>Search</Text>
        </Pressable>
      </View>

      {menu !== 'hidden' && (
        <FyaisaMenu
          menu={menu}
          setMenu={setMenu}
          hubStatus={hubStatus}
          pair={pair}
          pairHost={pairHost}
          setPairHost={setPairHost}
          pairCode={pairCode}
          updateVersion={updateVersion}
          job={job}
          onPair={() => startPair()}
          onDiscover={discoverBridge}
          onForget={forget}
          onUpdate={updateViaPc}
          onDismiss={() => setMenu('hidden')}
        />
      )}
    </View>
  );

  // --- Render: Search Screen ------------------------------------------------
  const renderSearch = () => (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.brand}>Search</Text>
      </View>

      <SearchBar
        value={searchQuery}
        onChangeText={setSearchQuery}
        onSubmit={doSearch}
      />

      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
        ) : searchResults.length > 0 ? (
          <MediaGrid items={searchResults} onSelect={openDetail} />
        ) : searchQuery ? (
          <Text style={styles.dim}>No results for "{searchQuery}"</Text>
        ) : (
          <Text style={styles.dim}>Type to search</Text>
        )}
      </ScrollView>

      <Pressable
        hasTVPreferredFocus
        style={({focused}) => [styles.backBtn, focused && styles.focusedRing]}
        onPress={() => setScreen('home')}>
        <Text style={styles.backBtnText}>Back</Text>
      </Pressable>
    </View>
  );

  // --- Render: Detail Screen -------------------------------------------------
  const renderDetail = () => {
    if (!detailItem) return null;
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.detailHeader}>
            {detailItem.backdrop_path ? (
              <Image
                source={{uri: `${TMDB_IMG}${detailItem.backdrop_path}`}}
                style={styles.detailBackdrop}
              />
            ) : (
              <View style={styles.detailBackdropPlaceholder} />
            )}
            <View style={styles.detailInfo}>
              <Text style={styles.detailTitle}>{detailItem.title}</Text>
              <View style={styles.detailMeta}>
                {(detailItem.release_date || detailItem.first_air_date) && (
                  <Text style={styles.detailMetaText}>
                    {(detailItem.release_date || detailItem.first_air_date || '').slice(0, 4)}
                  </Text>
                )}
                {detailItem.vote_average && detailItem.vote_average > 0 && (
                  <Text style={styles.detailMetaText}>★ {detailItem.vote_average.toFixed(1)}</Text>
                )}
                <Text style={styles.detailMetaText}>
                  {detailItem.media_type === 'movie' ? 'Movie' : 'TV'}
                </Text>
              </View>
            </View>
          </View>

          {detailItem.overview && (
            <Text style={styles.detailOverview}>{detailItem.overview}</Text>
          )}

          {/* Play button for movies */}
          {detailItem.media_type === 'movie' && (
            <View style={styles.actionRow}>
              <Pressable
                hasTVPreferredFocus
                style={({focused}) => [styles.playBtn, focused && styles.focusedRing]}
                onPress={() => playMovie(detailItem)}>
                <Text style={styles.playBtnText}>Play</Text>
              </Pressable>
            </View>
          )}

          {/* Seasons and episodes for TV */}
          {detailItem.media_type === 'tv' && seasons.length > 0 && (
            <View style={styles.episodesSection}>
              <Text style={styles.sectionTitle}>Seasons</Text>
              <View style={styles.seasonRow}>
                {seasons.map(s => (
                  <Pressable
                    key={s.season_number}
                    style={({focused}) => [
                      styles.seasonBtn,
                      selectedSeason === s.season_number && styles.seasonBtnActive,
                      focused && styles.focusedRing,
                    ]}
                    onPress={() => loadSeason(s.season_number)}>
                    <Text
                      style={[
                        styles.seasonBtnText,
                        selectedSeason === s.season_number && styles.seasonBtnTextActive,
                      ]}>
                      {s.name}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {loading ? (
                <ActivityIndicator size="small" color="#fff" style={{marginTop: 12}} />
              ) : (
                <View style={styles.episodesList}>
                  {episodes.map(ep => (
                    <Pressable
                      key={ep.id}
                      style={({focused}) => [styles.episodeBtn, focused && styles.focusedRing]}
                      onPress={() => playEpisode(detailItem, ep)}>
                      <Text style={styles.episodeBtnText}>
                        E{ep.episode_number}
                      </Text>
                      {ep.name && <Text style={styles.episodeTitle}>{ep.name}</Text>}
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}
        </ScrollView>

        <Pressable
          hasTVPreferredFocus
          style={({focused}) => [styles.backBtn, focused && styles.focusedRing]}
          onPress={() => setScreen('home')}>
          <Text style={styles.backBtnText}>Back</Text>
        </Pressable>
      </View>
    );
  };

  // --- Render: Player Screen -------------------------------------------------
  const renderPlayer = () => {
    if (!playerUrl) return null;
    if (playerError) {
      return (
        <View style={styles.container}>
          <View style={styles.playerErrorContainer}>
            <Text style={styles.playerErrorText}>{playerError}</Text>
            <Pressable
              hasTVPreferredFocus
              style={({focused}) => [styles.retryBtn, focused && styles.focusedRing]}
              onPress={() => loadPlayerAttempt(0)}>
              <Text style={styles.retryBtnText}>Try mirrors again</Text>
            </Pressable>
            <Pressable
              style={({focused}) => [styles.backBtn, focused && styles.focusedRing]}
              onPress={() => setScreen('detail')}>
              <Text style={styles.backBtnText}>Back</Text>
            </Pressable>
          </View>
        </View>
      );
    }
    return (
      <View style={styles.container}>
        <WebView
          ref={playerWebRef}
          source={{uri: playerUrl}}
          style={styles.playerWebView}
          javaScriptEnabled
          domStorageEnabled
          allowsDefaultMediaControl
          mediaPlaybackRequiresUserAction={false}
          allowSystemKeyEvents={false}
          hasTVPreferredFocus
          // VidSrc embeds check the referer; sending the VidSrc host as the
          // referer helps the player accept the request. Not in Amazon's prop
          // type, same cast the other WebView apps use.
          {...({originWhitelist: ['*']} as any)}
          onLoad={handlePlayerLoad}
          onMessage={handlePlayerMessage}
          onHttpError={(event: any) => {
            if (!isMainFrameFailure(event)) return;
            handlePlayerFailure(`VidSrc HTTP ${event?.nativeEvent?.statusCode}`);
          }}
          onError={(event: any) => {
            if (!isMainFrameFailure(event)) return;
            handlePlayerFailure(
              `VidSrc load error: ${event?.nativeEvent?.description || 'unknown'}`,
            );
          }}
        />
        {/* Chrome unmounts when hidden: no invisible Pressable can steal D-pad
            focus from the page, and OK always reaches the video's play button. */}
        {playerChromeVisible ? (
          <View style={styles.playerChrome} pointerEvents="none">
            <Text style={styles.playerChromeTitle}>{playerTitle}</Text>
            <Text style={styles.playerChromeHint}>
              {cursorMode
                ? 'Cursor: arrows move · OK clicks · Menu: D-pad'
                : 'OK clicks play · Menu: cursor · Back exits'}
            </Text>
          </View>
        ) : null}
        {playerNotice ? (
          <View style={styles.playerNotice} pointerEvents="none">
            <Text style={styles.playerNoticeText}>{playerNotice}</Text>
          </View>
        ) : null}
        {/* Native cursor overlay. This is the visible pointer; the DOM cursor is
            only a click anchor. pointerEvents=none keeps D-pad focus on the page. */}
        {cursorMode ? (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <View
              style={[
                styles.cursorHalo,
                {
                  left: cursorPos.x * winWidth - 26,
                  top: cursorPos.y * winHeight - 26,
                },
              ]}
            />
            <View
              style={[
                styles.cursorArrow,
                {
                  left: cursorPos.x * winWidth - 2,
                  top: cursorPos.y * winHeight - 2,
                },
              ]}
            />
          </View>
        ) : null}
      </View>
    );
  };

  // --- Main Render -----------------------------------------------------------
  return (
    <View style={styles.root}>
      {screen === 'home' && renderHome()}
      {screen === 'search' && renderSearch()}
      {screen === 'detail' && renderDetail()}
      {screen === 'player' && renderPlayer()}
    </View>
  );
};

// --- Components --------------------------------------------------------------

type ContentRowProps = {
  title: string;
  items: MediaItem[];
  onSelect: (item: MediaItem) => void;
};

const ContentRow = ({title, items, onSelect}: ContentRowProps) => (
  <View style={styles.row}>
    <Text style={styles.rowTitle}>{title}</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowContent}>
      {items.map(item => (
        <Pressable
          key={`${item.media_type}-${item.id}`}
          style={({focused}) => [styles.card, focused && styles.focusedRing]}
          onPress={() => onSelect(item)}>
          {item.poster_path ? (
            <Image
              source={{uri: `${TMDB_IMG}${item.poster_path}`}}
              style={styles.cardPoster}
            />
          ) : (
            <View style={styles.cardPosterPlaceholder}>
              <Text style={styles.cardPosterPlaceholderText}>
                {item.title[0] || '?'}
              </Text>
            </View>
          )}
          <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
        </Pressable>
      ))}
    </ScrollView>
  </View>
);

type MediaGridProps = {
  items: MediaItem[];
  onSelect: (item: MediaItem) => void;
};

const MediaGrid = ({items, onSelect}: MediaGridProps) => (
  <View style={styles.grid}>
    {items.map(item => (
      <Pressable
        key={`${item.media_type}-${item.id}`}
        style={({focused}) => [styles.gridItem, focused && styles.focusedRing]}
        onPress={() => onSelect(item)}>
        {item.poster_path ? (
          <Image
            source={{uri: `${TMDB_IMG}${item.poster_path}`}}
            style={styles.gridPoster}
          />
        ) : (
          <View style={styles.gridPosterPlaceholder}>
            <Text style={styles.gridPosterPlaceholderText}>
              {item.title[0] || '?'}
            </Text>
          </View>
        )}
        <Text style={styles.gridTitle} numberOfLines={2}>{item.title}</Text>
      </Pressable>
    ))}
  </View>
);

type SearchBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (query: string) => void;
};

const SearchBar = ({value, onChangeText, onSubmit}: SearchBarProps) => {
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  if (keyboardOpen) {
    return (
      <View style={styles.keyboardOverlay}>
        <Text style={styles.keyboardTitle}>Search</Text>
        <Text style={styles.keyboardQuery}>{value || ' '}</Text>
        <View style={styles.keyboardGrid}>
          {'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').map(k => (
            <Pressable
              key={k}
              style={({focused}) => [styles.key, focused && styles.focusedRing]}
              onPress={() => onChangeText(value + k)}>
              <Text style={styles.keyText}>{k}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.keyboardRow}>
          <Pressable
            style={({focused}) => [styles.keyWide, focused && styles.focusedRing]}
            onPress={() => onChangeText(value.slice(0, -1))}>
            <Text style={styles.keyText}>⌫</Text>
          </Pressable>
          <Pressable
            style={({focused}) => [styles.keyWide, focused && styles.focusedRing]}
            onPress={() => onChangeText('')}>
            <Text style={styles.keyText}>Clear</Text>
          </Pressable>
          <Pressable
            style={({focused}) => [styles.keyWide, focused && styles.focusedRing]}
            onPress={() => {
              setKeyboardOpen(false);
              onSubmit(value);
            }}>
            <Text style={styles.keyText}>Done</Text>
          </Pressable>
        </View>
        <Pressable
          style={({focused}) => [styles.keyWide, focused && styles.focusedRing]}
          onPress={() => setKeyboardOpen(false)}>
          <Text style={styles.keyText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.searchBarContainer}>
      <Pressable
        focusable
        style={({focused}) => [styles.searchInput, focused && styles.focusedRing]}
        onPress={() => setKeyboardOpen(true)}>
        <Text style={[styles.searchPlaceholder, value && styles.searchValue]}>
          {value || 'Search movies, TV…'}
        </Text>
      </Pressable>
    </View>
  );
};

type FyaisaMenuProps = {
  menu: 'hidden' | 'menu' | 'pair';
  setMenu: (m: 'hidden' | 'menu' | 'pair') => void;
  hubStatus: string;
  pair: SavedPair | null;
  pairHost: string;
  setPairHost: (h: string) => void;
  pairCode: string | null;
  updateVersion: string | null;
  job: {status: string; log: string[]} | null;
  onPair: () => void;
  onDiscover: () => void;
  onForget: () => void;
  onUpdate: () => void;
  onDismiss: () => void;
};

const FyaisaMenu = ({
  menu,
  setMenu,
  hubStatus,
  pair,
  pairHost,
  setPairHost,
  pairCode,
  updateVersion,
  job,
  onPair,
  onDiscover,
  onForget,
  onUpdate,
  onDismiss,
}: FyaisaMenuProps) => (
  <View style={styles.menuOverlay}>
    <View style={styles.menuCard}>
      <Text style={styles.menuTitle}>Cinevega v{APP_VERSION}</Text>
      <Text style={styles.menuStatus}>{hubStatus}</Text>
      {pair && <Text style={styles.menuPaired}>Paired with {pair.host}</Text>}

      {menu === 'pair' ? (
        <>
          <Text style={styles.menuHint}>
            Enter your computer’s address, then Get pairing code.
          </Text>
          <View style={styles.keypad}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫', 'C'].map(k => (
              <Pressable
                key={k}
                style={focusRing}
                onPress={() => {
                  const newHost =
                    k === 'C' ? HOST_PREFIX
                    : k === '⌫' ? pairHost.slice(0, -1)
                    : pairHost + k;
                  setPairHost(newHost);
                }}>
                <View style={styles.key}>
                  <Text style={styles.keyText}>{k}</Text>
                </View>
              </Pressable>
            ))}
          </View>
          <Text style={styles.menuHost}>{pairHost || '…'}</Text>
          {pairCode && <Text style={styles.menuCode}>Code: {pairCode}</Text>}
          <Pressable style={menuFocus} onPress={onDiscover}>
            <View style={styles.menuBtnGhost}>
              <Text style={styles.menuBtnText}>Discover this PC</Text>
            </View>
          </Pressable>
          <Pressable hasTVPreferredFocus style={menuFocus} onPress={onPair}>
            <View style={styles.menuBtn}>
              <Text style={styles.menuBtnText}>
                {pairCode ? 'Waiting…' : 'Get pairing code'}
              </Text>
            </View>
          </Pressable>
          <Pressable style={menuFocus} onPress={() => setMenu('menu')}>
            <View style={styles.menuBtnGhost}>
              <Text style={styles.menuBtnText}>Back</Text>
            </View>
          </Pressable>
        </>
      ) : (
        <>
          {updateVersion && (
            <Pressable hasTVPreferredFocus style={menuFocus} onPress={onUpdate}>
              <View style={styles.menuBtn}>
                <Text style={styles.menuBtnText}>Update to v{updateVersion}</Text>
              </View>
            </Pressable>
          )}
          <Pressable
            hasTVPreferredFocus={!updateVersion}
            style={menuFocus}
            onPress={() => setMenu('pair')}>
            <View style={styles.menuBtnGhost}>
              <Text style={styles.menuBtnText}>
                {pair ? 'Change ElevSH host' : 'Pair with ElevSH'}
              </Text>
            </View>
          </Pressable>
          {pair && (
            <Pressable style={menuFocus} onPress={onForget}>
              <View style={styles.menuBtnGhost}>
                <Text style={styles.menuBtnText}>Forget ElevSH</Text>
              </View>
            </Pressable>
          )}
          <Pressable style={menuFocus} onPress={onDismiss}>
            <View style={styles.menuBtnGhost}>
              <Text style={styles.menuBtnText}>Continue to Cinevega</Text>
            </View>
          </Pressable>
          {job && (
            <>
              <Text style={styles.menuJobStatus}>Update: {job.status}</Text>
              {job.log.map((l, i) => (
                <Text key={i} style={styles.menuJobLine} numberOfLines={2}>{l}</Text>
              ))}
            </>
          )}
        </>
      )}
    </View>
  </View>
);

// --- Styles ------------------------------------------------------------------
const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0b0b0f'},
  container: {flex: 1, backgroundColor: '#0b0b0f'},
  header: {paddingHorizontal: 40, paddingTop: 36, paddingBottom: 18},
  brand: {color: '#fff', fontSize: 40, fontWeight: '700'},
  tagline: {color: '#8b8b99', fontSize: 17, marginTop: 4},
  content: {paddingHorizontal: 40, paddingBottom: 40},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  dim: {color: '#77778a', fontSize: 16, marginTop: 12},

  // Content rows
  row: {marginBottom: 28},
  rowTitle: {color: '#fff', fontSize: 22, fontWeight: '600', marginBottom: 12},
  rowContent: {paddingRight: 40},
  card: {
    width: 160,
    marginRight: 14,
    backgroundColor: '#16161d',
    borderRadius: 10,
    borderWidth: 4,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  cardPoster: {width: 160, height: 240, borderRadius: 6},
  cardPosterPlaceholder: {
    width: 160,
    height: 240,
    borderRadius: 6,
    backgroundColor: '#1e1e28',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardPosterPlaceholderText: {color: '#6f6f80', fontSize: 48, fontWeight: '700'},
  cardTitle: {color: '#fff', fontSize: 14, marginTop: 8, paddingHorizontal: 4},

  // Grid
  grid: {flexDirection: 'row', flexWrap: 'wrap'},
  gridItem: {
    width: 160,
    marginRight: 14,
    marginBottom: 20,
    backgroundColor: '#16161d',
    borderRadius: 10,
    borderWidth: 4,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  gridPoster: {width: 160, height: 240, borderRadius: 6},
  gridPosterPlaceholder: {
    width: 160,
    height: 240,
    borderRadius: 6,
    backgroundColor: '#1e1e28',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridPosterPlaceholderText: {color: '#6f6f80', fontSize: 48, fontWeight: '700'},
  gridTitle: {color: '#fff', fontSize: 14, marginTop: 8, paddingHorizontal: 4},

  // Search
  searchBarContainer: {paddingHorizontal: 40, paddingBottom: 16},
  searchInput: {
    backgroundColor: '#16161d',
    borderRadius: 10,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  searchPlaceholder: {color: '#6f6f80', fontSize: 18},
  searchValue: {color: '#fff', fontSize: 18},
  keyboardOverlay: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    padding: 40,
  },
  keyboardTitle: {color: '#fff', fontSize: 32, fontWeight: '700', marginBottom: 8},
  keyboardQuery: {color: '#7ee787', fontSize: 24, fontFamily: 'monospace', marginBottom: 20},
  keyboardGrid: {flexDirection: 'row', flexWrap: 'wrap'},
  keyboardRow: {flexDirection: 'row', marginTop: 8},
  key: {
    width: 56,
    height: 48,
    margin: 3,
    borderRadius: 8,
    backgroundColor: '#23232d',
    borderWidth: 3,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyWide: {
    width: 120,
    height: 48,
    margin: 3,
    borderRadius: 8,
    backgroundColor: '#23232d',
    borderWidth: 3,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: {color: '#fff', fontSize: 20},

  // Detail
  detailHeader: {flexDirection: 'row', marginBottom: 20},
  detailBackdrop: {width: 320, height: 180, borderRadius: 10, marginRight: 20},
  detailBackdropPlaceholder: {
    width: 320,
    height: 180,
    borderRadius: 10,
    backgroundColor: '#1e1e28',
    marginRight: 20,
  },
  detailInfo: {flex: 1},
  detailTitle: {color: '#fff', fontSize: 32, fontWeight: '700'},
  detailMeta: {flexDirection: 'row', marginTop: 8},
  detailMetaText: {color: '#b9b9c6', fontSize: 15, marginRight: 12},
  detailOverview: {color: '#a9a9b8', fontSize: 16, lineHeight: 24, marginBottom: 20},

  // Actions
  actionRow: {flexDirection: 'row', alignItems: 'center', marginBottom: 20},
  playBtn: {
    backgroundColor: '#1c7d32',
    borderRadius: 6,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderWidth: 4,
    borderColor: 'transparent',
    marginRight: 12,
  },
  playBtnText: {color: '#fff', fontSize: 18, fontWeight: '600'},

  // Episodes
  episodesSection: {marginTop: 8},
  sectionTitle: {color: '#fff', fontSize: 20, fontWeight: '600', marginBottom: 12},
  seasonRow: {flexDirection: 'row', flexWrap: 'wrap', marginBottom: 16},
  seasonBtn: {
    backgroundColor: '#1e1e28',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 10,
    marginBottom: 8,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  seasonBtnActive: {backgroundColor: '#1c7d32'},
  seasonBtnText: {color: '#fff', fontSize: 14, fontWeight: '600'},
  seasonBtnTextActive: {color: '#fff'},
  episodesList: {flexDirection: 'row', flexWrap: 'wrap'},
  episodeBtn: {
    backgroundColor: '#1e1e28',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginRight: 10,
    marginBottom: 10,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  episodeBtnText: {color: '#fff', fontSize: 15, fontWeight: '600'},
  episodeTitle: {color: '#8b8b99', fontSize: 12, marginTop: 2},

  // Player
  playerWebView: {flex: 1, backgroundColor: '#000'},
  playerChrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 40,
    paddingTop: 18,
    paddingBottom: 26,
    backgroundColor: 'rgba(0,0,0,0.58)',
  },
  playerChromeTitle: {color: '#fff', fontSize: 20, fontWeight: '700'},
  playerChromeHint: {color: '#c9c9d4', fontSize: 13, marginTop: 6},
  playerNotice: {
    position: 'absolute',
    top: 92,
    left: 40,
    backgroundColor: 'rgba(0,0,0,0.78)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
  },
  playerNoticeText: {color: '#ffb02e', fontSize: 14},
  cursorHalo: {
    position: 'absolute',
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.92)',
    backgroundColor: 'rgba(0,0,0,0.22)',
    shadowColor: '#000',
    shadowOpacity: 0.9,
    shadowRadius: 6,
    elevation: 8,
  },
  cursorArrow: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftWidth: 10,
    borderRightWidth: 10,
    borderBottomWidth: 20,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#fff',
    transform: [{rotate: '35deg'}],
    shadowColor: '#000',
    shadowOpacity: 1,
    shadowRadius: 3,
  },
  playerErrorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    backgroundColor: '#0b0b0f',
  },
  playerErrorText: {
    color: '#ff6b6b',
    fontSize: 18,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 24,
  },
  retryBtn: {
    backgroundColor: '#1c7d32',
    borderRadius: 6,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderWidth: 4,
    borderColor: 'transparent',
    marginBottom: 12,
  },
  retryBtnText: {color: '#fff', fontSize: 18, fontWeight: '600'},

  // Toolbar
  toolbar: {
    flexDirection: 'row',
    paddingHorizontal: 40,
    paddingBottom: 16,
  },
  searchBtn: {
    backgroundColor: '#16161d',
    borderRadius: 10,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  searchBtnText: {color: '#fff', fontSize: 18, fontWeight: '600'},

  // Back button
  backBtn: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    backgroundColor: '#e50914',
    paddingHorizontal: 28,
    paddingVertical: 13,
    borderRadius: 6,
    borderWidth: 4,
    borderColor: 'transparent',
  },
  backBtnText: {color: '#fff', fontSize: 18},

  // FYAISA menu
  menuOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6,6,10,0.94)',
    padding: 56,
    justifyContent: 'center',
  },
  menuCard: {maxWidth: 940},
  menuTitle: {color: '#ffffff', fontSize: 40, fontWeight: '700'},
  menuStatus: {color: '#7ee787', fontSize: 17, marginTop: 14},
  menuPaired: {color: '#9fd0ff', fontSize: 15, marginTop: 4},
  menuHint: {color: '#a9a9b8', fontSize: 15, marginTop: 12, lineHeight: 21},
  menuHost: {color: '#ffffff', fontSize: 26, fontFamily: 'monospace', marginTop: 10},
  menuCode: {color: '#ffb02e', fontSize: 24, fontWeight: '700', marginTop: 8},
  keypad: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, maxWidth: 456},
  menuBtn: {
    backgroundColor: '#1c7d32',
    borderRadius: 6,
    paddingHorizontal: 24,
    paddingVertical: 12,
    alignSelf: 'flex-start',
    marginTop: 16,
  },
  menuBtnGhost: {
    backgroundColor: '#1e1e28',
    borderRadius: 6,
    paddingHorizontal: 24,
    paddingVertical: 12,
    alignSelf: 'flex-start',
    marginTop: 12,
  },
  menuBtnWrap: {marginTop: 16},
  menuBtnText: {color: '#ffffff', fontSize: 18},
  menuJobStatus: {color: '#7ee787', fontSize: 15, marginTop: 14},
  menuJobLine: {
    color: '#8b8b99',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },

  // Focus ring
  focusBase: {
    borderWidth: 4,
    borderColor: 'transparent',
  },
  focusedRing: {
    borderColor: '#ffb02e',
    shadowColor: '#ffb02e',
    shadowOpacity: 0.85,
    shadowRadius: 10,
    shadowOffset: {width: 0, height: 0},
    elevation: 10,
  },
});

export default App;