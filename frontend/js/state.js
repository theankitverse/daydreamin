function getCanonicalKey(song) {
  if (!song) return '';
  const title = (song.trackName || song.title || '').toLowerCase().trim()
                  .replace(/\s*\(.*?\)\s*/g, '')
                  .replace(/\s*\[.*?\]\s*/g, '')
                  .replace(/\s*-\s*.*$/g, '')
                  .replace(/\b(feat|ft|featuring)\b.*$/g, '')
                  .replace(/[^a-z0-9]/g, '');
  const artist = (song.artistName || song.artist || '').toLowerCase().trim()
                  .replace(/[^a-z0-9]/g, '');
  if (title && artist) {
    return `${artist}:${title}`;
  }
  return String(song.trackId || song.videoId || song.id || song.collectionId || song._rid || '');
}

// Migrate old liked songs/playlists to canonical keys
let _rawLiked = JSON.parse(localStorage.getItem('dyd_liked') || '[]');
let _rawLikedSongs = JSON.parse(localStorage.getItem('dyd_liked_songs') || '{}');

let _migratedLiked = [];
let _migratedLikedSongs = {};

for (let key in _rawLikedSongs) {
  const song = _rawLikedSongs[key];
  if (song) {
    const canonical = getCanonicalKey(song);
    _migratedLikedSongs[canonical] = song;
    if (!_migratedLiked.includes(canonical)) {
      _migratedLiked.push(canonical);
    }
  }
}

_rawLiked.forEach(id => {
  const song = _rawLikedSongs[id];
  if (song) {
    const canonical = getCanonicalKey(song);
    if (!_migratedLiked.includes(canonical)) _migratedLiked.push(canonical);
  } else if (typeof id === 'string' && id.includes(':')) {
    // Already migrated key
    if (!_migratedLiked.includes(id)) _migratedLiked.push(id);
  } else {
    const strId = String(id);
    if (!_migratedLiked.includes(strId)) _migratedLiked.push(strId);
  }
});

// Save migrated
localStorage.setItem('dyd_liked', JSON.stringify(_migratedLiked));
localStorage.setItem('dyd_liked_songs', JSON.stringify(_migratedLikedSongs));

const _savedLikedSongs = _migratedLikedSongs;
const _savedHistory = JSON.parse(localStorage.getItem('dyd_history') || '[]');

// Smart backend URL: localhost for dev, Oracle Cloud for production
function getDefaultBackendUrl() {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.')) {
    return 'http://127.0.0.1:499';
  }
  // Production: point to your Oracle Cloud backend
  // Update this URL after deploying your backend
  return 'http://127.0.0.1:499'; // TODO: Replace with Oracle Cloud IP
}

const S = {
  url:      localStorage.getItem('dyd_url') || getDefaultBackendUrl(),
  autoplay: localStorage.getItem('dyd_autoplay') === 'true',
  autoplayPlaylists: localStorage.getItem('dyd_autoplay_playlists') === 'true',
  song:     null,
  prevId:   null,
  queue:    [],
  _manualQueue: false, // true when playing from playlist/liked — prevents auto-queue overwrite
  history:  _savedHistory,
  lyrics:   [],
  _syncedLyrics: [],
  _plainLyrics: [],
  _rawLyricsData: null,
  liked:    new Set(JSON.parse(localStorage.getItem('dyd_liked') || '[]')),
  shuffle:  false,
  repeat:   false,
  tab:      'home',
  rpTab:    'queue',
  songs:    { ..._savedLikedSongs },
  counter:  0,
};

let playlists = JSON.parse(localStorage.getItem('dyd_playlists') || '[]');

// Pre-populate S.songs with songs from history and playlists
const _preloadRegister = (song) => {
  if (!song) return;
  const id = getCanonicalKey(song) || ('s' + ++S.counter);
  song._rid = String(id);
  S.songs[id] = song;
};

// Ensure all initially loaded liked songs have their _rid property set
for (let id in _savedLikedSongs) {
  const song = _savedLikedSongs[id];
  if (song && !song._rid) {
    song._rid = String(id);
  }
}

if (Array.isArray(_savedHistory)) {
  _savedHistory.forEach(_preloadRegister);
}
if (Array.isArray(playlists)) {
  playlists.forEach(pl => {
    if (pl && Array.isArray(pl.songs)) {
      pl.songs.forEach(_preloadRegister);
    }
  });
}
let libraryView = 'main'; // 'main' | 'liked' | 'playlist'
let currentPlaylistId = null;
let actionSong = null;
let _createPlSong = null; // song to add when creating new playlist

const audio = new Audio();
audio.preload = 'auto';
audio.setAttribute('playsinline', true);
audio.crossOrigin = 'anonymous';

// Stream URL cache: Map<cacheKey, {url, videoId, timestamp}>
const urlCache = new Map();
const URL_TTL = 25 * 60 * 1000; // 25 min

// Lyrics cache: Map<"artist|title", lyricsData>
const lyricsCache = new Map();

const banned = ["slowed","reverb","remix","sped up","8d","nightcore","bass boosted","edit audio","tiktok","cover","instrumental","tribute","karaoke","bootleg","refix","parody","slow","3d","10d","16d"];
