const $ = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = s => { if(!s||isNaN(s)) return '0:00'; const m=Math.floor(s/60),sec=String(Math.floor(s%60)).padStart(2,'0'); return `${m}:${sec}`; };
function getPlaylistDurationText(songs) {
  if (!songs || !songs.length) return "";
  let totalSeconds = 0;
  songs.forEach(s => {
    const d = s.duration || (s.trackTimeMillis ? s.trackTimeMillis / 1000 : 0);
    totalSeconds += parseFloat(d);
  });
  if (totalSeconds <= 0) return "";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h > 0) {
    return `${h}h ${m}m`;
  } else {
    return `${Math.max(1, m)}m`;
  }
}
function getEstimatedDurationText(trackCount) {
  if (!trackCount) return "";
  const totalSeconds = trackCount * 210;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h > 0) {
    return `${h}h ${m}m`;
  } else {
    return `${Math.max(1, m)}m`;
  }
}
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
    const artist = (song.artistName || song.artist || 'unknown').toLowerCase();
    count[artist] = (count[artist] || 0) + 1;
    return count[artist] <= maxPerArtist;
  });
}

function getSongId(song) {
  return typeof getCanonicalKey === 'function' ? getCanonicalKey(song) : String(song.trackId || song.videoId || song.id || song.collectionId || song._rid || '');
}

function reg(song) {
  if (!song) return '';
  const id = getSongId(song) || ('s'+ ++S.counter);
  song._rid = String(id);
  S.songs[id] = song;
  return id;
}
function getSong(rid) { return S.songs[rid]; }

async function apiFetch(path, options = {}) {
  const r = await fetch(S.url + path, options);
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.json();
}

const API = {
  chart:  () => apiFetch('/api/mobile/chart'),
  search: (q, options)  => apiFetch('/api/mobile/smart_search?q=' + encodeURIComponent(q), options),
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
  playlistDetails: id => apiFetch('/api/mobile/playlist_details?id=' + encodeURIComponent(id)),
  preload: (s) => {
    const p = new URLSearchParams({
      artist: s.artistName||s.artist||'',
      title: s.trackName||s.title||''
    });
    if (s.videoId) p.set('videoId', s.videoId);
    return apiFetch('/api/mobile/preload?' + p).catch(()=>{});
  }
};

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

// ─── GREETING ──────────────────────────────────────────────────────────────
(function greeting(){
  const h = new Date().getHours();
  $('g-title').textContent = h<12?'Good morning.':h<17?'Good afternoon.':'Good evening.';
  $('g-sub').textContent   = h<12?'Ready for your morning playlist?':h<17?'What are we listening to?':'Time to unwind.';
})();


// ─── HOME SCREEN ───────────────────────────────────────────────────────────
function renderHomePlaylists() {
  try {
    const plSec = $('sec-playlists');
    if (!plSec) return;
    
    const likedSongs = [...S.liked].map(id => S.songs[id] || _savedLikedSongs[id]).filter(Boolean);
    const likedCount = likedSongs.length;
    
    if ((playlists && playlists.length > 0) || likedCount > 0) {
      plSec.style.display = 'block';
      const plRow = $('playlists-row');
      if (plRow) {
        let cardsHtml = '';
        
        // Liked Songs card
        if (likedCount > 0) {
          const likedDur = getPlaylistDurationText(likedSongs);
          const likedMeta = likedDur ? `${likedCount} song${likedCount!==1?'s':''} • ${likedDur}` : `${likedCount} song${likedCount!==1?'s':''}`;
          const likedArt = getLikedSongsArtHtml(likedSongs, 'medium');
          cardsHtml += `<div class="feed-card" onclick="switchTab('library');libraryView='liked';renderLibrary()">
            <div class="feed-card-art">${likedArt}</div>
            <div class="feed-card-title">Liked Songs</div>
            <div class="feed-card-sub">${esc(likedMeta)}</div>
          </div>`;
        }
        
        // Other playlist cards
        cardsHtml += playlists.map(pl => {
          const count = pl.songs && pl.songs.length ? pl.songs.length : (pl.trackCount || 0);
          const art = pl.thumbnail || (pl.songs.length ? getArt(pl.songs[0], false) : '');
          const artHtml = art
            ? `<img src="${esc(art)}" loading="lazy" onerror="this.style.opacity=.15">`
            : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.2rem;opacity:0.35;background:var(--surface2)">🎵</div>`;
          const countText = `${count} song${count !== 1 ? 's' : ''}`;
          let durText = pl.songs && pl.songs.length ? getPlaylistDurationText(pl.songs) : '';
          if (!durText && count) {
            durText = getEstimatedDurationText(count);
          }
          const metaText = durText ? `${countText} • ${durText}` : countText;
          return `<div class="feed-card" onclick="switchTab('library');currentPlaylistId='${pl.id}';libraryView='playlist';renderLibrary()">
            <div class="feed-card-art">${artHtml}</div>
            <div class="feed-card-title">${esc(pl.name)}</div>
            <div class="feed-card-sub">${esc(metaText)}</div>
          </div>`;
        }).join('');
        
        plRow.innerHTML = cardsHtml;
      }
    } else {
      plSec.style.display = 'none';
    }
  } catch(e) { console.warn('Playlists failed:', e); }
}

async function loadHomeFeeds() {
  // ── 1. Recently Played ──
  try {
    if (S.history && S.history.length > 0) {
      $('sec-recent').style.display = 'block';
      const uniqueRecent = [];
      const seen = new Set();
      for (let i = S.history.length - 1; i >= 0; i--) {
        const s = S.history[i];
        const id = getSongId(s);
        if (!seen.has(id)) { seen.add(id); uniqueRecent.push(s); reg(s); }
        if (uniqueRecent.length >= 12) break;
      }
      renderCards($('recent-row'), uniqueRecent);
    }
  } catch(e) { console.warn('Recently played failed:', e); }

  // ── 2. Your Playlists ──
  renderHomePlaylists();

  // ── 3. Quick Picks — based on user's taste ──
  try {
    let seed = null;

    // Try from recent history first
    if (S.history.length > 0) {
      const recent = S.history.slice(-10);
      seed = recent[Math.floor(Math.random() * recent.length)];
    }
    // Fallback: try from liked songs
    if (!seed && S.liked.size > 0) {
      const likedArr = [...S.liked];
      const randId = likedArr[Math.floor(Math.random() * likedArr.length)];
      seed = S.songs[randId] || _savedLikedSongs[randId];
    }

    if (seed) {
      $('sec-quick').style.display = 'block';
      $('quick-row').innerHTML = loading();
      const res = await API.upNext(seed, 15);
      const quick = Array.isArray(res) ? res : (res.songs||res.results||[]);
      const filtered = diversifyArtists(filterBanned(quick));
      if (filtered.length > 0) {
        filtered.forEach(s => reg(s));
        renderCards($('quick-row'), filtered);
      } else {
        $('sec-quick').style.display = 'none';
      }
    }
  } catch(e) { $('sec-quick').style.display = 'none'; }

  // ── 4. Because You Liked — up to 2 personalized rows ──
  try {
    if (S.liked.size > 0) {
      const likedArr = [...S.liked];
      const seeds = [];
      const picked = new Set();
      // Pick up to 2 unique liked songs as seeds
      for (let attempt = 0; attempt < Math.min(8, likedArr.length); attempt++) {
        const randIdx = Math.floor(Math.random() * likedArr.length);
        const rid = likedArr[randIdx];
        if (picked.has(rid)) continue;
        picked.add(rid);
        const s = S.songs[rid] || _savedLikedSongs[rid];
        if (s) seeds.push(s);
        if (seeds.length >= 2) break;
      }

      for (let i = 0; i < seeds.length; i++) {
        const seed = seeds[i];
        const secId = i === 0 ? 'sec-because' : 'sec-because2';
        const rowId = i === 0 ? 'because-row' : 'because-row2';
        const lblId = i === 0 ? 'because-lbl' : 'because-lbl2';

        // Create second section dynamically if needed
        if (i === 1 && !$(secId)) {
          const sec = document.createElement('div');
          sec.className = 'feed-section';
          sec.id = secId;
          sec.style.display = 'none';
          sec.innerHTML = `<div class="section-label-row"><div class="section-label" id="${lblId}"></div></div><div class="scroll-row" id="${rowId}"></div>`;
          const homeContent = document.querySelector('.home-content');
          if (homeContent) homeContent.appendChild(sec);
        }

        const lbl = $(lblId);
        const sec = $(secId);
        const row = $(rowId);
        if (lbl) lbl.textContent = `Because You Liked "${seed.trackName || seed.title}"`;
        if (sec) sec.style.display = 'block';
        if (row) row.innerHTML = loading();

        // Use IIFE to capture row/sec in closure
        (async (row, sec) => {
          try {
            const data = await API.upNext(seed, 12);
            const songs = (Array.isArray(data) ? data : (data.songs || data.results || [])).filter(s => s.videoId !== seed.videoId);
            const filtered = diversifyArtists(filterBanned(songs));
            filtered.forEach(s => reg(s));
            if (row && filtered.length) renderCards(row, filtered);
            else if (sec) sec.style.display = 'none';
          } catch(e) { if (sec) sec.style.display = 'none'; }
        })(row, sec);
      }
    }
  } catch(e) { console.warn('Because you liked failed:', e); }

  // ── 5. More from [Top Artist] ──
  try {
    if (S.history.length >= 3) {
      const artistCount = {};
      S.history.forEach(s => {
        const a = (s.artistName || s.artist || '').toLowerCase().trim();
        if (a) artistCount[a] = (artistCount[a] || 0) + 1;
      });
      const sorted = Object.entries(artistCount).sort((a, b) => b[1] - a[1]);
      const topArtist = sorted[0];
      if (topArtist && topArtist[1] >= 2) {
        const artistSeed = S.history.find(s => (s.artistName || s.artist || '').toLowerCase().trim() === topArtist[0]);
        if (artistSeed) {
          const mixSec = $('sec-mix');
          const mixRow = $('mix-row');
          const mixLbl = $('mix-lbl');
          if (mixSec && mixRow) {
            mixSec.style.display = 'block';
            if (mixLbl) mixLbl.textContent = `More from ${artistSeed.artistName || artistSeed.artist}`;
            mixRow.innerHTML = loading();
            try {
              const data = await API.upNext(artistSeed, 12);
              const songs = Array.isArray(data) ? data : (data.songs || data.results || []);
              const filtered = diversifyArtists(filterBanned(songs));
              filtered.forEach(s => reg(s));
              if (filtered.length) renderCards(mixRow, filtered);
              else mixSec.style.display = 'none';
            } catch(e) { mixSec.style.display = 'none'; }
          }
        }
      }
    }
  } catch(e) { console.warn('Artist mix failed:', e); }

  // ── 6. Discover (fallback for new users with no history/likes) ──
  try {
    const hasPersonalized = S.history.length > 0 || S.liked.size > 0;
    if (!hasPersonalized) {
      const discoverSec = $('sec-discover');
      const discoverList = $('discover-list');
      if (discoverSec && discoverList) {
        discoverSec.style.display = 'block';
        discoverList.innerHTML = loading();
        const data = await API.chart();
        const songs = Array.isArray(data) ? data : (data.songs || data.results || []);
        const valid = filterBanned(songs);
        renderList(discoverList, valid, true);
      }
    }
  } catch(e) {
    const dl = $('discover-list');
    if (dl) dl.innerHTML = `<div class="empty"><div class="ico">⚠️</div><p>Couldn't reach server.<br>Open ⚙ Settings and set your server URL.</p></div>`;
  }
}

// ─── KEYBOARD SHORTCUTS ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  switch(e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': if(e.shiftKey) nextSong(); else if(audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime+10); break;
    case 'ArrowLeft': if(e.shiftKey) prevSong(); else if(audio.duration) audio.currentTime = Math.max(0, audio.currentTime-10); break;
    case 'ArrowUp': audio.volume = Math.min(1, audio.volume+0.1); if(typeof volSlider !== 'undefined' && volSlider) volSlider.value = audio.volume*100; break;
    case 'ArrowDown': audio.volume = Math.max(0, audio.volume-0.1); if(typeof volSlider !== 'undefined' && volSlider) volSlider.value = audio.volume*100; break;
    case 'KeyM': audio.muted = !audio.muted; toast(audio.muted ? 'Muted' : 'Unmuted'); break;
    case 'KeyS': toggleShuffle(); break;
    case 'KeyR': toggleRepeat(); break;
    case 'KeyL': if(S.song) toggleLike(); break;
    case 'Slash': if(e.shiftKey) { e.preventDefault(); toggleShortcuts(); } break;
  }
});

function openShortcuts()  { $('shortcuts-modal').classList.add('open'); document.body.classList.add('modal-open'); }
function closeShortcuts() { $('shortcuts-modal').classList.remove('open'); document.body.classList.remove('modal-open'); }
function toggleShortcuts() {
  const isOpen = $('shortcuts-modal').classList.toggle('open');
  document.body.classList.toggle('modal-open', isOpen);
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT — runs AFTER all scripts have loaded (DOMContentLoaded)
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  switchTab('home');
  loadHomeFeeds();
});
