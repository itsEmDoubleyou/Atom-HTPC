// TMDb-Anbindung: Anfragen an die API, Topshelf-Inhalte (beliebteste Titel je Anbieter), Bilder für den
// Bildschirmschoner und die Prüfung des API-Keys. Hängt nur von den Einstellungen ab (settings-store.js).
const https = require('https');
const { readBgSettings } = require('./settings-store');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/original';

// Einfacher GET-Request gegen die TMDb-API, gibt das geparste JSON zurück
function tmdbRequest(pathAndQuery, apiKey) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error('NO_API_KEY'));
      return;
    }
    const separator = pathAndQuery.includes('?') ? '&' : '?';
    const url = `${TMDB_BASE}${pathAndQuery}${separator}api_key=${encodeURIComponent(apiKey)}&language=de-DE`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

// ---------- Topshelf: aktuell beliebteste Inhalte je TMDb-Anbieter ----------
// Annäherung, nicht identisch mit dem, was der Dienst selbst als "Trending" zeigt:
// "verfügbar auf diesem Anbieter, nach TMDb-Popularität sortiert".
const topshelfCache = new Map(); // providerId -> { timestamp, items }
const TOPSHELF_CACHE_MS = 60 * 60 * 1000; // 1 Stunde - TMDb-Popularität ändert sich nicht sekündlich
const TOPSHELF_ITEM_COUNT = 8;

async function fetchTopshelfContent(providerId) {
  const cached = topshelfCache.get(providerId);
  if (cached && (Date.now() - cached.timestamp) < TOPSHELF_CACHE_MS) {
    return cached.items;
  }

  const apiKey = readBgSettings().tmdbApiKey;
  if (!apiKey) return [];

  try {
    const [movieRes, tvRes] = await Promise.all([
      tmdbRequest(`/discover/movie?with_watch_providers=${providerId}&watch_region=DE&sort_by=popularity.desc`, apiKey),
      tmdbRequest(`/discover/tv?with_watch_providers=${providerId}&watch_region=DE&sort_by=popularity.desc`, apiKey)
    ]);

    const combined = [
      ...(movieRes.results || []).map(r => ({ ...r, mediaType: 'movie', displayTitle: r.title })),
      ...(tvRes.results || []).map(r => ({ ...r, mediaType: 'tv', displayTitle: r.name }))
    ]
      .filter(r => r.backdrop_path) // ohne Hintergrundbild macht die Vorschau keinen Sinn
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      .slice(0, TOPSHELF_ITEM_COUNT);

    // Logo pro Titel separat nachladen (eigener TMDb-Endpunkt), parallel statt nacheinander
    const withLogos = await Promise.all(combined.map(async (item) => {
      let logoUrl = '';
      try {
        const images = await tmdbRequest(`/${item.mediaType}/${item.id}/images`, apiKey);
        const logos = images.logos || [];
        const logo = logos.find(l => l.iso_639_1 === 'de') || logos.find(l => l.iso_639_1 === 'en') || logos[0];
        if (logo) logoUrl = `https://image.tmdb.org/t/p/w500${logo.file_path}`;
      } catch (err) {
        // kein Logo verfügbar - UI zeigt dann einfach nur den Titel als Text
      }

      return {
        id: item.id,
        mediaType: item.mediaType,
        title: item.displayTitle,
        overview: item.overview || '',
        backdropUrl: `https://image.tmdb.org/t/p/original${item.backdrop_path}`,
        posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
        logoUrl
      };
    }));

    topshelfCache.set(providerId, { timestamp: Date.now(), items: withLogos });
    return withLogos;
  } catch (err) {
    console.error('Topshelf-Inhalte konnten nicht geladen werden:', err);
    return [];
  }
}

// ---------- Bildschirmschoner: Bilder aktuell beliebter Filme ----------
// Querformat-Hintergrundbilder der beliebtesten Filme (TMDb "popular", Region DE), ein paar Seiten = rund 60 Filme.
// Pro Bild gibt es { url, id, title, overview } (für die Zusatzinfo mit Pfeil runter); das Logo wird erst bei Bedarf geholt
// (fetchMovieLogo), damit der Start nicht von rund 60 weiteren Anfragen abhängt.
// Die Liste wird zwischengespeichert; schlägt eine Aktualisierung fehl, bleibt die alte Liste erhalten, und ein
// Fehlschlag wird nicht bei jeder Eingabe neu versucht (kurze Sperrzeit).
const popularImages = { items: [], timestamp: 0, failedAt: 0, inflight: null };
const POPULAR_IMAGES_CACHE_MS = 60 * 60 * 1000;
const POPULAR_IMAGES_RETRY_MS = 30 * 1000;
const POPULAR_IMAGES_PAGES = 3;

function fetchPopularMovieImages() {
  const c = popularImages;
  if (c.items.length && (Date.now() - c.timestamp) < POPULAR_IMAGES_CACHE_MS) return Promise.resolve(c.items);
  if (c.inflight) return c.inflight;
  if (Date.now() - c.failedAt < POPULAR_IMAGES_RETRY_MS) return Promise.resolve(c.items);
  const apiKey = readBgSettings().tmdbApiKey;
  if (!apiKey) return Promise.resolve(c.items);

  c.inflight = (async () => {
    try {
      const pages = Array.from({ length: POPULAR_IMAGES_PAGES }, (_, i) => i + 1);
      const settled = await Promise.allSettled(pages.map((page) => tmdbRequest(`/movie/popular?region=DE&page=${page}`, apiKey)));
      const byUrl = new Map();
      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        for (const movie of (result.value && result.value.results) || []) {
          if (!movie || !movie.backdrop_path) continue;
          const url = `${TMDB_IMAGE_BASE}${movie.backdrop_path}`;
          if (byUrl.has(url)) continue;
          byUrl.set(url, {
            url,
            id: Number.isInteger(movie.id) ? movie.id : 0,
            title: movie.title || movie.original_title || '',
            overview: movie.overview || ''
          });
        }
      }
      if (byUrl.size === 0) throw new Error('keine Bilder erhalten');
      c.items = [...byUrl.values()];
      c.timestamp = Date.now();
      c.failedAt = 0;
    } catch (err) {
      c.failedAt = Date.now();
      console.error('Bilder für den Bildschirmschoner konnten nicht geladen werden:', err);
    } finally {
      c.inflight = null;
    }
    return c.items;
  })();
  return c.inflight;
}

// Logo eines Films (Deutsch, sonst Englisch, sonst das erste ohne SVG) als Adresse, oder '' wenn es keins gibt.
// Zwischengespeichert, auch das "kein Logo"; ein Netzfehler wird nicht gemerkt (nächster Versuch ist erlaubt).
const movieLogoCache = new Map(); // id -> Adresse oder ''
async function fetchMovieLogo(id) {
  if (!Number.isInteger(id) || id <= 0) return '';
  if (movieLogoCache.has(id)) return movieLogoCache.get(id);
  const apiKey = readBgSettings().tmdbApiKey;
  if (!apiKey) return '';
  try {
    const images = await tmdbRequest(`/movie/${id}/images?include_image_language=de,en,null`, apiKey);
    const logos = ((images && images.logos) || []).filter((l) => l && l.file_path && !/\.svg$/i.test(l.file_path));
    const logo = logos.find((l) => l.iso_639_1 === 'de') || logos.find((l) => l.iso_639_1 === 'en') || logos[0];
    const url = logo ? `https://image.tmdb.org/t/p/w500${logo.file_path}` : '';
    movieLogoCache.set(id, url);
    return url;
  } catch (err) {
    return '';
  }
}

// Prüft einen TMDb-API-Key (v3) gegen die API.
// 'valid' = akzeptiert, 'invalid' = abgelehnt (401), 'unverified' = nicht prüfbar (z.B. offline)
function validateTmdbKey(key) {
  return new Promise((resolve) => {
    const req = https.get(`${TMDB_BASE}/configuration?api_key=${encodeURIComponent(key)}`, (res) => {
      res.resume(); // Antwort-Body wird nicht benötigt
      if (res.statusCode === 200) resolve('valid');
      else if (res.statusCode === 401) resolve('invalid');
      else resolve('unverified');
    });
    req.on('error', () => resolve('unverified'));
    req.setTimeout(8000, () => req.destroy());
  });
}

// Zwischengespeicherte TMDb-Daten verwerfen (Topshelf-Listen, Logos, Bilder des Bildschirmschoners): beim nächsten Bedarf wird neu geladen
function clearTmdbCaches() {
  topshelfCache.clear();
  movieLogoCache.clear();
  popularImages.items = [];
  popularImages.timestamp = 0;
  popularImages.failedAt = 0;
}

module.exports = {
  TMDB_IMAGE_BASE,
  clearTmdbCaches,
  tmdbRequest,
  fetchTopshelfContent,
  fetchPopularMovieImages,
  fetchMovieLogo,
  validateTmdbKey
};
