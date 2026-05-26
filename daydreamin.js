// ═══════════════════════════════════════════════════════════════════════════
// DAYDREAMIN — Core JavaScript
// ═══════════════════════════════════════════════════════════════════════════

// ─── STATE ─────────────────────────────────────────────────────────────────
// Restore liked song objects into registry on load
const _savedLikedSongs = JSON.parse(localStorage.getItem('dyd_liked_songs') || '{}');

const S = {
  url:      localStorage.getItem('dyd_url') || 'http://127.0.0.1:499',
  song:     null,
  prevId:   null,
  queue:    [],
  history:  [],
  lyrics:   [],
  liked:    new Set(JSON.parse(localStorage.getItem('dyd_liked') || '[]')),
  shuffle:  false,
  repeat:   false,
  tab:      'home',
  songs:    { ..._savedLikedSongs },
  counter:  0,
};

// ─── PLAYLISTS ─────────────────────────────────────────────────────────────
let playlists = JSON.parse(localStorage.getItem('dyd_playlists') || '[]');
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

const banned = ["slowed","reverb","remix","sped up","8d","nightcore","bass boosted","edit audio","tiktok"];

// ─── HELPERS ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = s => { if(!s||isNaN(s)) return '0:00'; const m=Math.floor(s/60),sec=String(Math.floor(s%60)).padStart(2,'0'); return `${m}:${sec}`; };
const loading = () => '<div class="loader"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';

function filterBanned(songs) {
  return songs.filter(song => {
    const t = (song.trackName||song.title||'').toLowerCase();
    return !banned.some(w => t.includes(w));
  });
}

function diversifyArtists(songs, maxPerArtist = 2) {
  const count = {};
  
  return songs.filter(song => {
    const artist = (
      song.artistName ||
      song.artist ||
      'unknown'
    ).toLowerCase();

    count[artist] = (count[artist] || 0) + 1;

    return count[artist] <= maxPerArtist;
  });
}

// ─── REGISTRY ──────────────────────────────────────────────────────────────
function reg(song) {
  const id = song.trackId || song.collectionId || song.id || song.videoId || ('s'+ ++S.counter);
  song._rid = String(id);
  S.songs[id] = song;
  return id;
}
function getSong(rid) { return S.songs[rid]; }

// ─── API ───────────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const r = await fetch(S.url + path);
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.json();
}

const API = {
  chart:  () => apiFetch('/api/mobile/chart'),
  search: q  => apiFetch('/api/mobile/smart_search?q=' + encodeURIComponent(q)),
  play:   s  => {
    const p = new URLSearchParams({
      id: s.trackId||s.id||s.videoId||'',
      artist: s.artistName||s.artist||'',
      title: s.trackName||s.title||''
    });
    if (s.videoId) p.set('videoId', s.videoId);
    if (S.prevId) p.set('previous_song_id', S.prevId);
    return apiFetch('/api/mobile/play?' + p);
  },
  upNext: (s, n=15) => {
    const p = new URLSearchParams({
      song_id: s.trackId||s.id||s.videoId||'',
      artist: s.artistName||s.artist||'',
      title: s.trackName||s.title||'',
      limit: n
    });
    return apiFetch('/api/mobile/up_next?' + p);
  },
  lyrics: (a, t) => apiFetch(`/api/mobile/lyrics?artist=${encodeURIComponent(a)}&title=${encodeURIComponent(t)}`),
  preload: (s) => {
    const p = new URLSearchParams({
      artist: s.artistName||s.artist||'',
      title: s.trackName||s.title||''
    });
    if (s.videoId) p.set('videoId', s.videoId);
    return apiFetch('/api/mobile/preload?' + p).catch(()=>{});
  }
};

// ─── STREAM URL CACHING ───────────────────────────────────────────────────
function cacheKey(song) {
  return song.videoId || song.trackId || song.id || `${song.artistName||song.artist}|${song.trackName||song.title}`;
}

function getCachedUrl(song) {
  const k = cacheKey(song);
  const c = urlCache.get(k);
  if (c && (Date.now() - c.timestamp) < URL_TTL) return c.url;
  urlCache.delete(k);
  return null;
}

function setCachedUrl(song, url, videoId) {
  urlCache.set(cacheKey(song), { url, videoId, timestamp: Date.now() });
}

// Preload the next song's stream URL + lyrics in background
async function preloadNext() {
  if (!S.queue.length) return;
  const nextSong = S.queue[0];

  // Preload stream URL
  if (!getCachedUrl(nextSong)) {
    try {
      const data = await API.play(nextSong);
      const streamUrl = data.stream_url || data.url || data.audio_url || '';
      if (streamUrl) setCachedUrl(nextSong, streamUrl, data.videoId || '');
    } catch(e) { /* silent */ }
  }

  // Preload lyrics
  const a = nextSong.artistName||nextSong.artist||'';
  const t = nextSong.trackName||nextSong.title||'';
  const lk = `${a}|${t}`.toLowerCase();
  if ((a || t) && !lyricsCache.has(lk)) {
    API.lyrics(a, t).then(d => { if (d) lyricsCache.set(lk, d); }).catch(()=>{});
  }
}

// ─── AUDIO EVENTS ──────────────────────────────────────────────────────────
audio.addEventListener('timeupdate', onTimeUpdate);
audio.addEventListener('loadedmetadata', () => { $('t-tot').textContent = fmt(audio.duration); updatePositionState(); });
audio.addEventListener('ended', () => { S.repeat ? (audio.currentTime=0, audio.play()) : nextSong(); });
audio.addEventListener('play',  () => setPlayUI(true));
audio.addEventListener('pause', () => setPlayUI(false));
audio.addEventListener('error', () => { if (audio.src) toast('⚠ Stream error'); });

function onTimeUpdate() {
  if (!audio.duration || dragging) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  $('prog-fill').style.width = pct + '%';
  $('prog-thumb').style.left = pct + '%';
  $('m-bar').style.width = pct + '%';
  $('t-cur').textContent = fmt(audio.currentTime);
  // Preload when 75% through
  if (pct > 75 && S.queue.length && !getCachedUrl(S.queue[0])) preloadNext();
}

function setPlayUI(playing) {
  const pause = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
  const play  = '<path d="M8 5v14l11-7z"/>';
  const ico = playing ? pause : play;
  $('p-play-ico').innerHTML = ico;
  $('m-play-ico').innerHTML = ico;
  $('p-art').classList.toggle('playing', playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !audio.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration)
    });
  } catch(e) {}
}

// updatePositionState is called inside onTimeUpdate above

// ─── MEDIA SESSION (lock screen + Bluetooth) ──────────────────────────────
function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  const art = getArt(song, true);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.trackName || song.title || '—',
    artist: song.artistName || song.artist || '—',
    album: song.album || song.collectionName || '',
    artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : []
  });
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', nextSong);
  navigator.mediaSession.setActionHandler('previoustrack', prevSong);
  navigator.mediaSession.setActionHandler('seekbackward', d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset||10)); });
  navigator.mediaSession.setActionHandler('seekforward', d => { audio.currentTime = Math.min(audio.duration||0, audio.currentTime + (d.seekOffset||10)); });
  try {
    navigator.mediaSession.setActionHandler('seekto', d => {
      if (d.fastSeek && 'fastSeek' in audio) audio.fastSeek(d.seekTime);
      else audio.currentTime = d.seekTime;
      updatePositionState();
    });
  } catch(e) {}
}

// ─── ARTWORK HELPERS ──────────────────────────────────────────────────────
function getArt(song, large) {
  if (song.cover_xl && large) return song.cover_xl;
  if (song.cover) return large ? song.cover.replace('200x200','600x600') : song.cover;
  const raw = song.artworkUrl100 || song.artworkUrl60 || song.thumbnail || '';
  if (!raw) return '';
  return large ? raw.replace('100x100','600x600').replace('60x60','600x600') : raw;
}

// ─── PLAYBACK ──────────────────────────────────────────────────────────────
async function playSong(song, addHistory=true) {
  if (!song) return;
  if (addHistory && S.song) S.history.push(S.song);
  if (S.history.length > 50) S.history = S.history.slice(-50);
  S.prevId = S.song?.trackId ?? S.song?.id ?? S.song?.videoId ?? null;
  S.song = song;

  setNowPlayingUI(song);
  showMini(song);
  updateMediaSession(song);
  toast('Loading…');

  try {
    // Check URL cache first
    let streamUrl = getCachedUrl(song);
    if (!streamUrl) {
      const data = await API.play(song);
      streamUrl = data.stream_url || data.url || data.audio_url || '';
      if (data.videoId) song.videoId = data.videoId;
      if (streamUrl) setCachedUrl(song, streamUrl, data.videoId||'');
    }
    if (!streamUrl) throw new Error('No stream URL');
    audio.pause();
    audio.src = streamUrl;
    audio.onerror = async () => {
      try {
        const retry = await API.play(song);
        const freshUrl = retry.stream_url || retry.url || '';
        if (freshUrl) {
          audio.src = freshUrl;
          await audio.play();
        }
      } catch(e) {
        toast('Playback failed');
      }
    };
    await audio.play();

    // Background tasks: queue + lyrics + preload
    API.upNext(song, 15).then(d => {
      let songs = (Array.isArray(d) ? d : (d.songs||d.results||[])).map(s => { reg(s); return s; });
      S.queue = diversifyArtists(
        filterBanned(songs)
      );
      renderQueue();
      preloadNext();
    }).catch(()=>{});

    const artist = song.artistName||song.artist||'';
    const title = song.trackName||song.title||'';
    if (artist || title) {
      const lk = `${artist}|${title}`.toLowerCase();
      const cached = lyricsCache.get(lk);
      if (cached) {
        parseLyrics(cached);
      } else {
        API.lyrics(artist, title).then(d => {
          if (d) lyricsCache.set(lk, d);
          parseLyrics(d);
        }).catch(()=>{});
      }
    }

    bgColor(getArt(song, false));
  } catch(e) {
    console.error(e);
    toast('Failed: ' + e.message);
  }
}

function togglePlay()   { if(!S.song) return; audio.paused ? audio.play() : audio.pause(); }
function toggleShuffle(){ S.shuffle=!S.shuffle; $('shuffle-btn').classList.toggle('on',S.shuffle); toast(S.shuffle?'Shuffle on':'Shuffle off'); }
function toggleRepeat() { S.repeat=!S.repeat; $('repeat-btn').classList.toggle('on',S.repeat); toast(S.repeat?'Repeat on':'Repeat off'); }

function toggleLike() {
  if (!S.song) return;
  _toggleLikeForSong(S.song);
}

function _toggleLikeForSong(song) {
  const id = String(song.trackId||song.id||song.videoId);
  if (S.liked.has(id)) {
    S.liked.delete(id);
    delete _savedLikedSongs[id];
    const h=$('p-heart'); if(h && S.song && String(S.song.trackId||S.song.id||S.song.videoId)===id) h.classList.remove('liked');
    toast('Removed from liked');
  } else {
    S.liked.add(id);
    _savedLikedSongs[id] = song;
    S.songs[id] = song;
    const h=$('p-heart'); if(h && S.song && String(S.song.trackId||S.song.id||S.song.videoId)===id) h.classList.add('liked');
    toast('Added to liked ♥');
  }
  localStorage.setItem('dyd_liked', JSON.stringify([...S.liked]));
  localStorage.setItem('dyd_liked_songs', JSON.stringify(_savedLikedSongs));
  if (S.tab === 'library') renderLibrary();
}

async function nextSong() {
  if (!S.queue.length) {
    // Try to refill before giving up
    if (S.song) { await refillQueue(); }
    if (!S.queue.length) { toast('Queue is empty'); return; }
  }
  const idx = S.shuffle ? Math.floor(Math.random()*S.queue.length) : 0;
  const next = S.queue.splice(idx,1)[0];

  if (S.song) S.history.push(S.song);
  if (S.history.length > 50) S.history = S.history.slice(-50);
  S.prevId = S.song?.trackId ?? S.song?.id ?? S.song?.videoId ?? null;
  S.song = next;

  setNowPlayingUI(next);
  showMini(next);
  updateMediaSession(next);

  // Try cached URL for instant play
  let streamUrl = getCachedUrl(next);
  if (streamUrl) {
    audio.src = streamUrl;
    audio.onerror = async () => {
      try {
        const retry = await API.play(next);
        const freshUrl = retry.stream_url || retry.url || '';
        if (freshUrl) {
          audio.src = freshUrl;
          await audio.play();
        }
      } catch(e) {
        toast('Playback failed');
      }
    };
    try { await audio.play(); } catch(e) { streamUrl = null; }
  }

  if (!streamUrl) {
    try {
      toast('Loading…');
      const data = await API.play(next);
      streamUrl = data.stream_url || data.url || data.audio_url || '';
      if (!streamUrl) throw new Error('No stream URL');
      if (data.videoId) next.videoId = data.videoId;
      setCachedUrl(next, streamUrl, data.videoId||'');
      audio.src = streamUrl;
      audio.onerror = async () => {
        try {
          const retry = await API.play(next);
          const freshUrl = retry.stream_url || retry.url || '';
          if (freshUrl) {
            audio.src = freshUrl;
            await audio.play();
          }
        } catch(e) {
          toast('Playback failed');
        }
      };
      await audio.play();
    } catch(e) {
      console.error(e);
      toast('Failed — skipping');
      if (S.queue.length) setTimeout(nextSong, 500);
      return;
    }
  }

  // Background: lyrics + preload next
  const artist = next.artistName||next.artist||'';
  const title = next.trackName||next.title||'';
  if (artist || title) {
    const lk = `${artist}|${title}`.toLowerCase();
    const cached = lyricsCache.get(lk);
    if (cached) {
      parseLyrics(cached);
    } else {
      API.lyrics(artist, title).then(d => {
        if (d) lyricsCache.set(lk, d);
        parseLyrics(d);
      }).catch(()=>{});
    }
  }
  bgColor(getArt(next, false));
  renderQueue();
  preloadNext();
  // Auto-refill queue when running low
  if (S.queue.length <= 3) refillQueue();
}

async function prevSong() {
  if (audio.currentTime > 4 || !S.history.length) { audio.currentTime=0; return; }
  await playSong(S.history.pop(), false);
}

// ─── SEEK ──────────────────────────────────────────────────────────────────
let dragging=false, dragPct=0;
const progTrack = $('prog-track');

progTrack.addEventListener('pointerdown', e => {
  dragging = true;
  progTrack.setPointerCapture(e.pointerId);
  moveProg(e);
});
progTrack.addEventListener('pointermove', e => { if(dragging) moveProg(e); });
progTrack.addEventListener('pointerup', e => {
  if (!dragging) return;
  dragging = false;
  moveProg(e);
  if (audio.duration) { audio.currentTime = dragPct * audio.duration; updatePositionState(); }
});

function moveProg(e) {
  const r = progTrack.getBoundingClientRect();
  dragPct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  $('prog-fill').style.width = (dragPct*100) + '%';
  $('prog-thumb').style.left = (dragPct*100) + '%';
  $('t-cur').textContent = fmt(dragPct * (audio.duration||0));
}

// ─── UI ────────────────────────────────────────────────────────────────────
function setNowPlayingUI(song) {
  $('p-art').src = getArt(song, true);
  $('p-title').textContent = song.trackName || song.title || '—';
  $('p-artist').textContent = song.artistName || song.artist || '—';
  const liked = S.liked.has(String(song.trackId||song.id||song.videoId));
  const heartEl = $('p-heart');
  if (heartEl) heartEl.classList.toggle('liked', liked);
  $('lyr-title').textContent  = song.trackName || song.title || 'Lyrics';
  $('lyr-artist').textContent = song.artistName || song.artist || '—';
  // Update art glow
  const glow = $('art-glow');
  if (glow) glow.style.background = `url(${getArt(song, true)})`;
}

function showMini(song) {
  $('m-art').src = getArt(song, false);
  $('m-title').textContent  = song.trackName || song.title || '—';
  $('m-artist').textContent = song.artistName || song.artist || '—';
  $('mini').classList.add('on');
}

// ─── RENDER HELPERS ────────────────────────────────────────────────────────
function songItemHTML(song, idx, showNum) {
  const rid = reg(song);
  const art = getArt(song, false);
  const dur = song.trackTimeMillis ? fmt(song.trackTimeMillis/1000) : (song.duration ? fmt(song.duration) : '');
  const now = S.song && (S.song.trackId === song.trackId || S.song.id === song.id || (S.song.videoId && S.song.videoId === song.videoId));
  return `
  <div class="song-item${now?' now-playing':''}" onclick="playSong(getSong('${rid}'))">
    ${showNum ? `<div class="track-num">${idx+1}</div>
    <div class="bars"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>` : ''}
    <img class="song-art" src="${esc(art)}" loading="lazy" onerror="this.style.opacity=.15">
    <div class="song-info">
      <div class="song-title">${esc(song.trackName||song.collectionName||song.title||'—')}</div>
      <div class="song-artist">${esc(song.artistName||song.artist||'—')}</div>
    </div>
    ${dur ? `<div class="song-dur">${dur}</div>` : ''}
    <button class="song-menu" onclick="event.stopPropagation();openSongActions(getSong('${rid}'))">&#8942;</button>
  </div>`;
}

function renderList(el, songs, showNum) {
  if (!songs.length) { el.innerHTML = `<div class="empty"><div class="ico">🔍</div><p>Nothing here</p></div>`; return; }
  el.innerHTML = songs.map((s,i) => songItemHTML(s,i,showNum)).join('');
}

function renderQueue() {
  if (S.song) {
    const art = getArt(S.song, false);
    $('q-now').innerHTML = `
      <div class="q-now">
        <img class="q-now-art" src="${esc(art)}">
        <div>
          <div class="q-now-lbl">Now Playing</div>
          <div class="q-now-title">${esc(S.song.trackName||S.song.title||'—')}</div>
          <div class="q-now-artist">${esc(S.song.artistName||S.song.artist||'—')}</div>
        </div>
      </div>`;
  }
  const el = $('queue-list');
  if (!S.queue.length) { el.innerHTML = `<div class="empty"><div class="ico">📋</div><p>Queue is empty</p></div>`; return; }
  el.innerHTML = S.queue.map((s,i) => {
    reg(s);
    const art = getArt(s, false);
    return `<div class="song-item" onclick="playFromQueue(${i})">
      <img class="song-art" src="${esc(art)}" loading="lazy">
      <div class="song-info">
        <div class="song-title">${esc(s.trackName||s.title||'—')}</div>
        <div class="song-artist">${esc(s.artistName||s.artist||'—')}</div>
      </div>
    </div>`;
  }).join('');
}

async function playFromQueue(i) {
  const song = S.queue.splice(i,1)[0];
  renderQueue();
  await playSong(song);
}

// ─── LYRICS ────────────────────────────────────────────────────────────────
function parseLyrics(data) {
  S.lyrics = [];
  lastLyricIdx = -1;
  const synced = data?.syncedLyrics || '';
  const plain = data?.plainLyrics || data?.lyrics || '';
  const raw = (
  synced ||
  plain ||
  data?.message ||
  ''
);

  if (!raw) {
    $('lyric-body').innerHTML = `<div class="empty"><div class="ico">🎤</div><p>No lyrics found</p></div>`;
    return;
  }

  
  if (synced) {
    const parsed = synced.split('\n').map(l => {
      const m = l.match(/^\[(\d+):(\d+\.?\d*)\](.*)/);
      return m ? { time: parseInt(m[1])*60 + parseFloat(m[2]), text: m[3].trim() } : null;
    }).filter(Boolean);
    if (parsed.length) { S.lyrics = parsed; } 
    else { S.lyrics = raw.split('\n').filter(l=>l.trim()).map(l => ({ time:-1, text:l.replace(/^\[\d+:\d+\.\d+\]/,'').trim() })); }
  } else {
    S.lyrics = plain.split('\n').filter(l=>l.trim()).map(l => ({ time:-1, text:l }));
  }

  $('lyric-body').innerHTML = S.lyrics.map((l,i) =>
    `<div class="lyric-line" id="ll-${i}">${esc(l.text||'♪')}</div>`
  ).join('');
}

let lastLyricIdx = -1;
const LYRIC_OFFSET = -0.3; // seconds — adjust if lyrics feel early (+) or late (-)

// High-frequency lyrics sync via requestAnimationFrame (60fps)
function syncLyricLoop() {
  syncLyric();
  requestAnimationFrame(syncLyricLoop);
}
requestAnimationFrame(syncLyricLoop);

function syncLyric() {
  if (!S.lyrics.length || audio.paused) return;

  // Plain (unsynced) lyrics — no highlighting possible
  if (S.lyrics[0].time < 0) return;

  const t = audio.currentTime + LYRIC_OFFSET;
  let active = 0;
  for (let i = 0; i < S.lyrics.length; i++) {
    if (S.lyrics[i].time <= t) active = i; else break;
  }
  if (active === lastLyricIdx) return;

  // Only update the lines that changed
  const prev = lastLyricIdx;
  lastLyricIdx = active;

  if (prev >= 0) {
    const prevEl = document.getElementById(`ll-${prev}`);
    if (prevEl) { prevEl.classList.remove('active'); prevEl.classList.add('past'); }
  }
  const activeEl = document.getElementById(`ll-${active}`);
  if (activeEl) {
    activeEl.classList.add('active');
    activeEl.classList.remove('past');
    if (S.tab === 'lyrics') {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

// ─── DYNAMIC BACKGROUND ────────────────────────────────────────────────────
function bgColor(imgURL) {
  if (!imgURL) return;
  const img = new Image(); img.crossOrigin='anonymous'; img.src = imgURL;
  img.onload = () => {
    const c = document.createElement('canvas'); c.width=c.height=10;
    const ctx = c.getContext('2d');
    ctx.drawImage(img,0,0,10,10);
    const d = ctx.getImageData(0,0,10,10).data;
    let r=0,g=0,b=0, n=d.length/4;
    for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];}
    r=Math.round(r/n); g=Math.round(g/n); b=Math.round(b/n);
    // Boost saturation slightly
    const max=Math.max(r,g,b), min=Math.min(r,g,b);
    if (max-min < 30) { r=Math.min(255,r+20); g=Math.min(255,g+20); }
    $('glow').style.background = `radial-gradient(ellipse at 35% 35%, rgb(${r},${g},${b}), transparent 50%)`;
    $('glow2').style.background = `radial-gradient(ellipse at 65% 65%, rgb(${b},${r},${g}), transparent 50%)`;
    if ($('glow3')) $('glow3').style.background = `radial-gradient(ellipse at 50% 50%, rgb(${g},${b},${r}), transparent 50%)`;
    // Update art glow color
    const artGlow = $('art-glow');
    if (artGlow) artGlow.style.background = `rgb(${r},${g},${b})`;
  };
}

// ─── NAVIGATION ────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  $('s-'+tab).classList.add('active');
  $('nb-'+tab).classList.add('active');
  S.tab = tab;
  if (tab === 'search') setTimeout(() => $('search-input').focus(), 100);
  if (tab === 'library') renderLibrary();
}

function openPlayer()  { if(S.song){ $('player').classList.add('open'); } }
function closePlayer() { $('player').classList.remove('open'); }

// Swipe down to close player
let ty0=0;
$('player').addEventListener('touchstart', e=>{ ty0=e.touches[0].clientY; },{passive:true});
$('player').addEventListener('touchend', e=>{ if(e.changedTouches[0].clientY-ty0>90) closePlayer(); },{passive:true});

// ─── SEARCH ────────────────────────────────────────────────────────────────
let searchTimer;
$('search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $('search-results').innerHTML = `<div class="empty"><div class="ico">🎵</div><p>Search any song or artist</p></div>`; return; }
  $('search-results').innerHTML = loading();
  searchTimer = setTimeout(async () => {
    try {
      const data = await API.search(q);
      const songs = Array.isArray(data) ? data : (data.songs || data.results || []);
      if (!songs.length) { $('search-results').innerHTML = `<div class="empty"><div class="ico">🔍</div><p>No results for "${esc(q)}"</p></div>`; return; }
      renderList($('search-results'), filterBanned(songs), false);
    } catch(e) {
      $('search-results').innerHTML = `<div class="empty"><div class="ico">⚠️</div><p>Search failed.<br>Check server URL in settings.</p></div>`;
    }
  }, 350);
});

// ─── TRENDING ──────────────────────────────────────────────────────────────
async function loadTrending() {
  $('trending-list').innerHTML = loading();
  try {
    const data = await API.chart();
    const songs = Array.isArray(data) ? data : (data.songs || data.results || []);
    renderList($('trending-list'), filterBanned(songs), true);
  } catch(e) {
    $('trending-list').innerHTML = `<div class="empty"><div class="ico">⚠️</div><p>Couldn't reach server.<br>Open ⚙ Settings and set your server URL.</p></div>`;
  }
}

// ─── SETTINGS ──────────────────────────────────────────────────────────────
function openSettings()  { $('url-input').value = S.url; $('settings').classList.add('open'); }
function closeSettings() { $('settings').classList.remove('open'); }
function saveSettings()  {
  const url = $('url-input').value.trim().replace(/\/$/,'');
  if (!url) return;
  S.url = url;
  localStorage.setItem('dyd_url', url);
  closeSettings();
  toast('URL saved ✓');
  loadTrending();
}

// ─── TOAST ─────────────────────────────────────────────────────────────────
let toastT;
function toast(msg) {
  const el = $('toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(()=>el.classList.remove('show'), 2200);
}

// ─── GREETING ──────────────────────────────────────────────────────────────
(function greeting(){
  const h = new Date().getHours();
  $('g-title').textContent = h<12?'Good morning.':h<17?'Good afternoon.':'Good evening.';
  $('g-sub').textContent   = h<12?'Ready for your morning playlist?':h<17?'What are we listening to?':'Time to unwind.';
})();

// ─── INIT ──────────────────────────────────────────────────────────────────
loadTrending();

// ─── QUEUE AUTO-REFILL ─────────────────────────────────────────────────────
let refilling = false;
async function refillQueue() {
  if (refilling || !S.song) return;
  refilling = true;
  try {
    const data = await API.upNext(S.song, 20);
    let songs = (Array.isArray(data) ? data : (data.songs||data.results||[])).map(s => { reg(s); return s; });
    songs = diversifyArtists(filterBanned(songs));
    // Don't add duplicates
    const existing = new Set(S.queue.map(s => s.videoId || s.id || s.trackId));
    const fresh = songs.filter(s => !existing.has(s.videoId || s.id || s.trackId));
    S.queue.push(...fresh);
    renderQueue();
    if (fresh.length) toast(`+${fresh.length} songs queued`);
  } catch(e) { /* silent */ }
  refilling = false;
}

// ─── LIKED SONGS ───────────────────────────────────────────────────────────
function renderLiked() {
  const el = $('liked-list');
  if (!el) return;
  const likedSongs = [...S.liked].map(id => S.songs[id] || _savedLikedSongs[id]).filter(Boolean);
  if (!likedSongs.length) {
    el.innerHTML = `<div class="empty"><div class="ico">♥</div><p>Songs you like will appear here</p></div>`;
    return;
  }
  renderList(el, likedSongs, false);
}

// ─── CLEAR SEARCH ──────────────────────────────────────────────────────────
function clearSearch() {
  $('search-input').value = '';
  $('search-results').innerHTML = `<div class="empty"><div class="ico">🎵</div><p>Search any song or artist</p></div>`;
  $('search-input').focus();
}

// ─── VOLUME SLIDER ─────────────────────────────────────────────────────────
const volSlider = $('vol-slider');
if (volSlider) {
  volSlider.addEventListener('input', e => { audio.volume = e.target.value / 100; });
}

// ─── KEYBOARD SHORTCUTS ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  switch(e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': if(e.shiftKey) nextSong(); else if(audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime+10); break;
    case 'ArrowLeft': if(e.shiftKey) prevSong(); else if(audio.duration) audio.currentTime = Math.max(0, audio.currentTime-10); break;
    case 'ArrowUp': audio.volume = Math.min(1, audio.volume+0.1); if(volSlider) volSlider.value = audio.volume*100; break;
    case 'ArrowDown': audio.volume = Math.max(0, audio.volume-0.1); if(volSlider) volSlider.value = audio.volume*100; break;
    case 'KeyM': audio.muted = !audio.muted; toast(audio.muted ? 'Muted' : 'Unmuted'); break;
    case 'KeyS': toggleShuffle(); break;
    case 'KeyR': toggleRepeat(); break;
    case 'KeyL': if(S.song) toggleLike(); break;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PLAYLIST & LIBRARY SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

function savePlaylists() { localStorage.setItem('dyd_playlists', JSON.stringify(playlists)); }

function createPlaylist(name, songToAdd) {
  const pl = { id: 'pl_' + Date.now(), name: name.trim() || 'My Playlist', songs: [], createdAt: Date.now() };
  if (songToAdd) pl.songs.push(songToAdd);
  playlists.push(pl);
  savePlaylists();
  renderLibrary();
  toast(`Playlist "${pl.name}" created`);
  return pl;
}

function addToPlaylist(playlistId, song) {
  const pl = playlists.find(p => p.id === playlistId);
  if (!pl) return;
  const sid = String(song.trackId||song.id||song.videoId);
  if (pl.songs.some(s => String(s.trackId||s.id||s.videoId) === sid)) { toast('Already in playlist'); return; }
  pl.songs.push(song);
  savePlaylists();
  toast(`Added to ${pl.name}`);
}

function removeFromPlaylist(playlistId, idx) {
  const pl = playlists.find(p => p.id === playlistId);
  if (!pl) return;
  pl.songs.splice(idx, 1);
  savePlaylists();
  if (libraryView === 'playlist') renderLibrary();
}

function deletePlaylist(playlistId) {
  playlists = playlists.filter(p => p.id !== playlistId);
  savePlaylists();
  libraryView = 'main';
  renderLibrary();
  toast('Playlist deleted');
}

function playPlaylist(playlistId, startIdx) {
  const pl = playlists.find(p => p.id === playlistId);
  if (!pl || !pl.songs.length) return;
  startIdx = startIdx || 0;
  const songs = [...pl.songs];
  const first = songs.splice(startIdx, 1)[0];
  reg(first);
  songs.forEach(s => reg(s));
  S.queue = songs;
  playSong(first);
  renderQueue();
}

function shufflePlaylist(playlistId) {
  const pl = playlists.find(p => p.id === playlistId);
  if (!pl || !pl.songs.length) return;
  const songs = [...pl.songs].sort(() => Math.random() - 0.5);
  const first = songs.shift();
  reg(first);
  songs.forEach(s => reg(s));
  S.queue = songs;
  playSong(first);
  renderQueue();
}

function addToQueue(song) {
  reg(song);
  S.queue.push(song);
  renderQueue();
  toast('Added to queue');
}

// ─── LIBRARY RENDERING ────────────────────────────────────────────────────
function renderLibrary() {
  const view = $('library-view');
  if (!view) return;

  if (libraryView === 'liked') {
    const likedSongs = [...S.liked].map(id => S.songs[id] || _savedLikedSongs[id]).filter(Boolean);
    view.innerHTML = `
      <div class="lib-back" onclick="libraryView='main';renderLibrary()">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
        Back to Library
      </div>
      <div class="lib-sub-title">Liked Songs</div>
      ${likedSongs.length ? `<div class="pl-detail-header">
        <button class="pl-play-btn" onclick="playLikedSongs()">▶ Play All</button>
        <button class="pl-shuffle-btn" onclick="shuffleLikedSongs()">⤮ Shuffle</button>
      </div>` : ''}
      <div class="song-list" id="liked-list"></div>`;
    const el = $('liked-list');
    if (likedSongs.length) renderList(el, likedSongs, false);
    else el.innerHTML = `<div class="empty"><div class="ico">♥</div><p>Songs you like will appear here</p></div>`;
    return;
  }

  if (libraryView === 'playlist' && currentPlaylistId) {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl) { libraryView = 'main'; renderLibrary(); return; }
    view.innerHTML = `
      <div class="lib-back" onclick="libraryView='main';renderLibrary()">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
        Back to Library
      </div>
      <div class="lib-sub-title">${esc(pl.name)}</div>
      <div class="pl-detail-header">
        ${pl.songs.length ? `<button class="pl-play-btn" onclick="playPlaylist('${pl.id}')">▶ Play All</button>
        <button class="pl-shuffle-btn" onclick="shufflePlaylist('${pl.id}')">⤮ Shuffle</button>` : ''}
        <button class="pl-shuffle-btn" onclick="deletePlaylist('${pl.id}')" style="margin-left:auto;color:var(--pink)">🗑 Delete</button>
      </div>
      <div class="song-list" id="pl-songs"></div>`;
    const el = $('pl-songs');
    if (pl.songs.length) {
      el.innerHTML = pl.songs.map((s, i) => {
        reg(s);
        const art = getArt(s, false);
        return `<div class="song-item" onclick="playPlaylist('${pl.id}',${i})">
          <img class="song-art" src="${esc(art)}" loading="lazy" onerror="this.style.opacity=.15">
          <div class="song-info">
            <div class="song-title">${esc(s.trackName||s.title||'—')}</div>
            <div class="song-artist">${esc(s.artistName||s.artist||'—')}</div>
          </div>
          <button class="song-menu" onclick="event.stopPropagation();removeFromPlaylist('${pl.id}',${i})">✕</button>
        </div>`;
      }).join('');
    } else {
      el.innerHTML = `<div class="empty"><div class="ico">🎵</div><p>Add songs from search or trending</p></div>`;
    }
    return;
  }

  // Main library view
  const likedCount = S.liked.size;
  const plCards = playlists.map(pl => {
    const count = pl.songs.length;
    const arts = pl.songs.slice(0, 4).map(s => getArt(s, false)).filter(Boolean);
    const iconHtml = arts.length >= 4
      ? `<div class="pl-grid">${arts.slice(0,4).map(a=>`<img src="${esc(a)}">`).join('')}</div>`
      : `<div class="lib-card-icon">🎵</div>`;
    return `<div class="lib-card pl-card" onclick="currentPlaylistId='${pl.id}';libraryView='playlist';renderLibrary()">
      ${iconHtml}
      <div class="lib-card-info">
        <div class="lib-card-title">${esc(pl.name)}</div>
        <div class="lib-card-count">${count} song${count!==1?'s':''}</div>
      </div>
      <div class="lib-card-arrow">›</div>
    </div>`;
  }).join('');

  view.innerHTML = `
    <div class="lib-header">
      <div class="screen-sub">Your collection</div>
      <div class="screen-title">Library</div>
    </div>
    <div class="lib-card liked-card" onclick="libraryView='liked';renderLibrary()">
      <div class="lib-card-icon">♥</div>
      <div class="lib-card-info">
        <div class="lib-card-title">Liked Songs</div>
        <div class="lib-card-count">${likedCount} song${likedCount!==1?'s':''}</div>
      </div>
      <div class="lib-card-arrow">›</div>
    </div>
    <div class="section-label-row">
      <div class="section-label">Your Playlists</div>
      <button class="add-pl-btn" onclick="openCreatePlaylist()">+ New</button>
    </div>
    ${plCards || `<div class="empty" style="padding:30px 20px"><div class="ico">📋</div><p>Create your first playlist</p></div>`}`;
}

function playLikedSongs() {
  const songs = [...S.liked].map(id => S.songs[id] || _savedLikedSongs[id]).filter(Boolean);
  if (!songs.length) return;
  const first = songs.shift();
  reg(first); songs.forEach(s => reg(s));
  S.queue = songs; playSong(first); renderQueue();
}
function shuffleLikedSongs() {
  const songs = [...S.liked].map(id => S.songs[id] || _savedLikedSongs[id]).filter(Boolean).sort(() => Math.random() - 0.5);
  if (!songs.length) return;
  const first = songs.shift();
  reg(first); songs.forEach(s => reg(s));
  S.queue = songs; playSong(first); renderQueue();
}

// ─── ACTION SHEET (Song Options) ──────────────────────────────────────────
function openSongActions(song) {
  if (!song) return;
  actionSong = song;
  const isLiked = S.liked.has(String(song.trackId||song.id||song.videoId));
  const art = getArt(song, false);

  $('action-preview').innerHTML = `
    <img src="${esc(art)}" onerror="this.style.opacity=.15">
    <div>
      <div class="a-title">${esc(song.trackName||song.title||'—')}</div>
      <div class="a-artist">${esc(song.artistName||song.artist||'—')}</div>
    </div>`;

  let plItems = playlists.map(pl =>
    `<div class="action-item" onclick="addToPlaylist('${pl.id}',actionSong);closeActions()">
      <span>📋</span>${esc(pl.name)}</div>`
  ).join('');

  $('action-list').innerHTML = `
    <div class="action-item" onclick="_toggleLikeForSong(actionSong);closeActions()">
      <span>${isLiked ? '💔' : '❤️'}</span>${isLiked ? 'Remove from Liked' : 'Add to Liked'}
    </div>
    <div class="action-item" onclick="addToQueue(actionSong);closeActions()">
      <span>➕</span>Add to Queue
    </div>
    ${playlists.length ? '<div class="action-divider"></div><div class="action-sublabel">Add to Playlist</div>' + plItems : ''}
    <div class="action-divider"></div>
    <div class="action-item" onclick="_createPlSong=actionSong;closeActions();openCreatePlaylist()">
      <span>✨</span>New Playlist with this song
    </div>`;

  $('action-sheet').classList.add('open');
}
function closeActions() { $('action-sheet').classList.remove('open'); actionSong = null; }

// ─── CREATE PLAYLIST MODAL ───────────────────────────────────────────────
function openCreatePlaylist() { $('pl-name-input').value = ''; $('create-pl-modal').classList.add('open'); setTimeout(() => $('pl-name-input').focus(), 100); }
function closeCreatePlaylist() { $('create-pl-modal').classList.remove('open'); _createPlSong = null; }
function confirmCreatePlaylist() {
  const name = $('pl-name-input').value.trim();
  if (!name) { toast('Enter a name'); return; }
  createPlaylist(name, _createPlSong);
  _createPlSong = null;
  closeCreatePlaylist();
}
