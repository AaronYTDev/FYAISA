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
  View,
} from 'react-native';
import {Pressable} from '@amazon-devices/react-native-kepler';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
} from '@amazon-devices/react-native-kepler';
import {KeplerFileSystem} from '@amazon-devices/kepler-file-system';
import {Fyaisa, FyaisaError} from './fyaisaClient';

// --- Config ------------------------------------------------------------------
const TMDB_API_KEY = 'a7a6a0d8b0326f1e9f356cacd724b233';
const TMDB_READ_TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhN2E2YTBkOGIwMzI2ZjFlOWYzNTZjYWNkNzI0YjIzMyIsIm5iZiI6MTc5MDg5ODA5OC42OTI5OTk4LCJzdWIiOiI2YWJlZWZiMjBhZDZlY2MwOGE4OWQxYjUiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.-2yJbHFpoGmO6JayHtIEghF0k5ft_0gIdctIUIjkt3Q';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
const VIDSRC_BASE = 'https://vidsrc.to/embed';

const BRIDGE_PORT = 47821;
const CINEVEGA_APP_ID = 'app.cinevega.main';
const HUB_CATALOG_URL =
  'https://raw.githubusercontent.com/AaronYTDev/FYAISA/main/catalog.json';
const STORE_PATH = '/data/bridge.json';
const APP_VERSION = '1.0.0';

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
    const res = await fetch(
      `${TMDB_BASE}/trending/all/week?api_key=${TMDB_API_KEY}`,
    );
    const data = await res.json();
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
    const res = await fetch(
      `${TMDB_BASE}/movie/popular?api_key=${TMDB_API_KEY}`,
    );
    const data = await res.json();
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
    const res = await fetch(`${TMDB_BASE}/tv/popular?api_key=${TMDB_API_KEY}`);
    const data = await res.json();
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
    const res = await fetch(
      `${TMDB_BASE}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`,
    );
    const data = await res.json();
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
    const res = await fetch(
      `${TMDB_BASE}/movie/${id}?api_key=${TMDB_API_KEY}`,
    );
    const item = await res.json();
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
    const res = await fetch(`${TMDB_BASE}/tv/${id}?api_key=${TMDB_API_KEY}`);
    const item = await res.json();
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
    const res = await fetch(`${TMDB_BASE}/tv/${id}?api_key=${TMDB_API_KEY}`);
    const data = await res.json();
    return (data.seasons || [])
      .filter((s: any) => s.season_number > 0)
      .map((s: any) => ({
        season_number: s.season_number,
        name: s.name,
      }));
  },

  async seasonEpisodes(tvId: number, seasonNumber: number): Promise<Episode[]> {
    const res = await fetch(
      `${TMDB_BASE}/tv/${tvId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`,
    );
    const data = await res.json();
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
const vidsrc = {
  movieUrl(tmdbId: number): string {
    return `${VIDSRC_BASE}/movie/${tmdbId}`;
  },
  tvUrl(tmdbId: number, season: number, episode: number): string {
    return `${VIDSRC_BASE}/tv/${tmdbId}/${season}/${episode}`;
  },
};

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
  const [pairHost, setPairHost] = useState('');
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
        if (hubVersion && hubVersion !== APP_VERSION) {
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

  // Back handling
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

  const verifyPair = useCallback(async (sp: SavedPair) => {
    if (!sp.token) return;
    try {
      await Fyaisa.from({host: sp.host, token: sp.token, appId: CINEVEGA_APP_ID}).catalog();
      setHubStatus(prev => (prev && prev.startsWith('Allow') ? 'ElevSH connected' : prev));
    } catch (e: any) {
      if (e instanceof FyaisaError && e.status === 401) {
        await clearPair();
        setPair(null);
        setPairHost('');
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
      const host = (hostArg ?? pairHost).trim();
      if (!host) {
        setHubStatus('Enter your computer’s address first');
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
        const p = await Fyaisa.waitForApproval(host, code, BRIDGE_PORT, 2000, 600000, {
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
    setPairHost('');
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

  const playMovie = useCallback((item: MediaItem) => {
    setPlayerTitle(item.title);
    setPlayerUrl(vidsrc.movieUrl(item.id));
    setScreen('player');
  }, []);

  const playEpisode = useCallback((item: MediaItem, ep: Episode) => {
    setPlayerTitle(`${item.title} - S${ep.season_number} E${ep.episode_number}`);
    setPlayerUrl(vidsrc.tvUrl(item.id, ep.season_number, ep.episode_number));
    setScreen('player');
  }, []);

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
    return (
      <View style={styles.container}>
        <View style={styles.playerHeader}>
          <Text style={styles.playerTitle}>{playerTitle}</Text>
        </View>
        <WebView
          source={{uri: playerUrl}}
          style={styles.playerWebView}
          javaScriptEnabled
          domStorageEnabled
          allowsDefaultMediaControl
          mediaPlaybackRequiresUserAction={false}
          allowSystemKeyEvents={false}
        />
        <Pressable
          hasTVPreferredFocus
          style={({focused}) => [styles.backBtn, focused && styles.focusedRing]}
          onPress={() => setScreen('detail')}>
          <Text style={styles.backBtnText}>Back</Text>
        </Pressable>
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
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => (
              <Pressable
                key={k}
                style={focusRing}
                onPress={() => {
                    const newHost = k === '⌫' ? pairHost.slice(0, -1) : pairHost + k;
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
  playerHeader: {paddingHorizontal: 40, paddingTop: 20, paddingBottom: 12},
  playerTitle: {color: '#fff', fontSize: 24, fontWeight: '700'},
  playerWebView: {flex: 1, backgroundColor: '#000'},

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