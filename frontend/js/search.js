// ─── SEARCH HISTORY ────────────────────────────────────────────────────────
const MAX_HISTORY = 8;
let _searchHistory = JSON.parse(localStorage.getItem('dyd_search_history') || '[]');

function _saveSearchHistory() {
  localStorage.setItem('dyd_search_history', JSON.stringify(_searchHistory));
}

function _addToHistory(q) {
  // Remove duplicate, push to front
  _searchHistory = _searchHistory.filter(h => h !== q);
  _searchHistory.unshift(q);
  if (_searchHistory.length > MAX_HISTORY) _searchHistory = _searchHistory.slice(0, MAX_HISTORY);
  _saveSearchHistory();
}

function _removeFromHistory(q) {
  _searchHistory = _searchHistory.filter(h => h !== q);
  _saveSearchHistory();
  _showSearchHistory();
}

function _showSearchHistory() {
  closeSearchFeed();
  const dots = $('search-loading-dots');
  if (dots) dots.style.display = 'none';
  const resultsEl = $('search-results');
  if (resultsEl) resultsEl.classList.remove('searching');
  if (loadingIndicatorTimer) {
    clearTimeout(loadingIndicatorTimer);
    loadingIndicatorTimer = null;
  }
  if (!_searchHistory.length) {
    $('search-results').innerHTML = `<div class="empty"><div class="ico">🎵</div><p>Search any song, artist, or lyrics</p></div>`;
    return;
  }
  $('search-results').innerHTML = `
    <div class="search-history-header">
      <span class="search-history-label">Recent Searches</span>
      <button class="search-history-clear-all" onclick="_searchHistory=[];_saveSearchHistory();_showSearchHistory()">Clear all</button>
    </div>
    <div class="search-history-chips">
      ${_searchHistory.map(h => `
        <div class="search-chip" onclick="runSearch('${esc(h)}')">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <span>${esc(h)}</span>
          <button class="chip-remove" onclick="event.stopPropagation();_removeFromHistory('${esc(h)}')" aria-label="Remove">✕</button>
        </div>
      `).join('')}
    </div>`;
}

function runSearch(q) {
  $('search-input').value = q;
  $('search-clear').classList.add('visible');
  _addToHistory(q);
  doSearch(q);
}

// ─── SEARCH ────────────────────────────────────────────────────────────────
let searchTimer;
const _searchCache = new Map();
let currentSearchController = null;
let searchRequestSeq = 0;
let loadingIndicatorTimer = null;

function renderSearchSkeleton() {
  return `
    <div class="search-skeleton">
      <div class="skeleton-top-row">
        <div class="skeleton-block skeleton-top-result"></div>
        <div class="skeleton-songs">
          <div class="skeleton-line skeleton-song"></div>
          <div class="skeleton-line skeleton-song"></div>
          <div class="skeleton-line skeleton-song"></div>
          <div class="skeleton-line skeleton-song"></div>
        </div>
      </div>
      <div class="skeleton-row-label"></div>
      <div class="skeleton-carousel">
        <div class="skeleton-block skeleton-card"></div>
        <div class="skeleton-block skeleton-card"></div>
        <div class="skeleton-block skeleton-card"></div>
        <div class="skeleton-block skeleton-card"></div>
      </div>
    </div>
  `;
}

async function doSearch(q) {
  if (!q) { _showSearchHistory(); return; }
  
  const cacheKey = q.toLowerCase().trim();
  if (_searchCache.has(cacheKey)) {
    const cachedData = _searchCache.get(cacheKey);
    renderSearchResults(cachedData, q);
    return;
  }

  const mySeq = ++searchRequestSeq;
  if (currentSearchController) {
    currentSearchController.abort();
  }
  currentSearchController = new AbortController();

  // Keep previous results visible while loading. Show skeleton only if results are empty or showing recent searches
  const resultsEl = $('search-results');
  const hasCurrentResults = resultsEl && (
    resultsEl.querySelector('.search-top-row') || 
    resultsEl.querySelector('.song-item') || 
    resultsEl.querySelector('.feed-card')
  );
  if (resultsEl && !hasCurrentResults) {
    resultsEl.innerHTML = renderSearchSkeleton();
  }

  // Setup delayed loading indicator
  if (loadingIndicatorTimer) {
    clearTimeout(loadingIndicatorTimer);
  }
  loadingIndicatorTimer = setTimeout(() => {
    const dots = $('search-loading-dots');
    if (dots) dots.style.display = 'flex';
    if (resultsEl && hasCurrentResults) {
      resultsEl.classList.add('searching');
    }
  }, 180);

  try {
    const data = await API.search(q, { signal: currentSearchController.signal });
    if (mySeq !== searchRequestSeq) return; // Stale request

    // Store in client cache
    if (_searchCache.size > 100) {
      const firstKey = _searchCache.keys().next().value;
      _searchCache.delete(firstKey);
    }
    _searchCache.set(cacheKey, data);

    renderSearchResults(data, q);
  } catch(e) {
    if (e.name === 'AbortError') return;
    if (mySeq === searchRequestSeq && resultsEl) {
      resultsEl.innerHTML = `<div class="empty"><div class="ico">⚠️</div><p>Search failed.<br>Check server URL in settings.</p></div>`;
    }
  } finally {
    if (mySeq === searchRequestSeq) {
      if (loadingIndicatorTimer) {
        clearTimeout(loadingIndicatorTimer);
        loadingIndicatorTimer = null;
      }
      const dots = $('search-loading-dots');
      if (dots) dots.style.display = 'none';
      if (resultsEl) resultsEl.classList.remove('searching');
    }
  }
}

$('search-input').addEventListener('focus', () => {
  if (!$('search-input').value.trim()) _showSearchHistory();
});

// Save search query on Enter key press
$('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const q = e.target.value.trim();
    if (q) {
      clearTimeout(searchTimer);
      _addToHistory(q);
      doSearch(q);
    }
  }
});

// Save search query when user clicks any search results
$('search-results').addEventListener('click', e => {
  const q = $('search-input').value.trim();
  // Don't add to history if clicking clear history or chip remove buttons
  if (q && !e.target.closest('.search-history-clear-all') && !e.target.closest('.chip-remove')) {
    _addToHistory(q);
  }
});

$('search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  $('search-clear').classList.toggle('visible', !!q);
  if (!q) { _showSearchHistory(); return; }
  
  searchTimer = setTimeout(() => doSearch(q), 350);
});

// ─── CLEAR SEARCH ──────────────────────────────────────────────────────────
function clearSearch() {
  clearTimeout(searchTimer);
  if (loadingIndicatorTimer) {
    clearTimeout(loadingIndicatorTimer);
    loadingIndicatorTimer = null;
  }
  if (currentSearchController) {
    currentSearchController.abort();
    currentSearchController = null;
  }
  const dots = $('search-loading-dots');
  if (dots) dots.style.display = 'none';
  const resultsEl = $('search-results');
  if (resultsEl) resultsEl.classList.remove('searching');
  
  $('search-input').value = '';
  $('search-clear').classList.remove('visible');
  _showSearchHistory();
  $('search-input').focus();
}

// ─── CLICKABLE FEED/FEED RESULT PAGES ──────────────────────────────────────
let currentSearchFeedTracks = [];
let currentSearchFeedId = null;
let currentSearchFeedType = null;

function openSearchFeed(feedType, feedId, feedTitle, feedThumb, feedAuthor) {
  currentSearchFeedId = feedId;
  currentSearchFeedType = feedType;
  const feedEl = $('search-feed-view');
  const resultsEl = $('search-results');
  const inputContainer = $('search-input-container');
  const hintEl = $('search-hint');

  if (inputContainer) inputContainer.style.display = 'none';
  if (hintEl) hintEl.style.display = 'none';
  if (resultsEl) resultsEl.style.display = 'none';
  if (feedEl) feedEl.style.display = 'block';

  feedEl.innerHTML = `
    <div class="lib-back" onclick="closeSearchFeed()">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
      Back to Search
    </div>
    <div class="feed-detail-header-card">
      <img class="feed-detail-art" src="${esc(feedThumb || '')}" onerror="this.style.opacity=.15">
      <div class="feed-detail-info">
        <div class="feed-detail-badge">${esc(feedType.toUpperCase())}</div>
        <div class="feed-detail-title">${esc(feedTitle)}</div>
        <div class="feed-detail-author">by ${esc(feedAuthor || 'YouTube Music')}</div>
      </div>
    </div>
    <div class="loader-wrap" style="padding: 40px 0; text-align: center;">
      <div class="loader"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    </div>
  `;

  if (feedType === 'playlist' || feedType === 'mix') {
    const savedPl = playlists.find(x => x.ytId === feedId || x.id === 'pl_yt_' + feedId);
    if (savedPl && savedPl.songs && savedPl.songs.length > 0) {
      renderSearchFeedDetails(savedPl, feedType);
      return;
    }
    API.playlistDetails(feedId).then(details => {
      if (details) details.id = feedId;
      renderSearchFeedDetails(details, feedType);
    }).catch(err => {
      feedEl.innerHTML = `
        <div class="lib-back" onclick="closeSearchFeed()">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
          Back to Search
        </div>
        <div class="empty"><div class="ico">⚠️</div><p>Failed to load playlist tracks.</p></div>
      `;
    });
  } else if (feedType === 'artist') {
    API.search(feedTitle).then(data => {
      const details = {
        title: feedTitle,
        thumbnail: feedThumb,
        author: 'Artist',
        description: 'Popular tracks matching artist',
        tracks: (data.songs || []).slice(0, 15)
      };
      renderSearchFeedDetails(details, 'artist');
    }).catch(err => {
      feedEl.innerHTML = `
        <div class="lib-back" onclick="closeSearchFeed()">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
          Back to Search
        </div>
        <div class="empty"><div class="ico">⚠️</div><p>Failed to load artist tracks.</p></div>
      `;
    });
  }
}

function closeSearchFeed() {
  currentSearchFeedId = null;
  currentSearchFeedType = null;
  const feedEl = $('search-feed-view');
  const resultsEl = $('search-results');
  const inputContainer = $('search-input-container');
  const hintEl = $('search-hint');

  if (feedEl) feedEl.style.display = 'none';
  if (inputContainer) inputContainer.style.display = 'block';
  if (hintEl) hintEl.style.display = 'block';
  if (resultsEl) resultsEl.style.display = 'block';
}

function playSearchFeedSong(startIdx) {
  if (!currentSearchFeedTracks.length) return;
  startIdx = startIdx || 0;
  const first = currentSearchFeedTracks[startIdx];
  reg(first);
  const remaining = currentSearchFeedTracks.slice(startIdx + 1);
  remaining.forEach(s => reg(s));
  S.history = currentSearchFeedTracks.slice(0, startIdx);
  S.history.forEach(s => reg(s));
  S.queue = remaining;
  S._manualQueue = true;
  playSong(first, false, true);
  renderQueue();
}

function shuffleSearchFeedTracks() {
  if (!currentSearchFeedTracks.length) return;
  const shuffled = [...currentSearchFeedTracks].sort(() => Math.random() - 0.5);
  const first = shuffled.shift();
  reg(first);
  shuffled.forEach(s => reg(s));
  S.queue = shuffled;
  S._manualQueue = true;
  playSong(first, true, true);
  renderQueue();
}

function renderSearchFeedDetails(details, type) {
  const feedEl = $('search-feed-view');
  if (!feedEl || !details) return;

  const tracks = details.tracks || details.songs || [];
  currentSearchFeedTracks = tracks;
  tracks.forEach(t => reg(t));

  const trackCount = tracks.length;

  const detailsId = details.ytId || details.id;
  const isSaved = detailsId ? isYTPlaylistSaved(detailsId) : false;
  const saveBtnHtml = (type === 'playlist' || type === 'mix') && detailsId
    ? `<button class="pl-save-btn${isSaved ? ' saved' : ''}" data-pl-id="${esc(detailsId)}" onclick="event.stopPropagation(); toggleSaveYTPlaylist('${esc(detailsId)}', '${esc(details.title || details.name)}', '${esc(details.thumbnail)}', '${esc(details.author)}')">${isSaved ? '✓ Saved' : '+ Save'}</button>`
    : '';

  const durText = getPlaylistDurationText(tracks);
  const metaText = `by ${esc(details.author || 'YouTube Music')} • ${trackCount} song${trackCount !== 1 ? 's' : ''}${durText ? ' • ' + durText : ''}`;

  const playButtonHtml = trackCount > 0
    ? `<div class="pl-detail-header" style="margin-bottom: 20px; display: flex; gap: 10px; align-items: center;">
         <button class="pl-play-btn" onclick="playSearchFeedSong(0)">▶ Play All</button>
         <button class="pl-shuffle-btn" onclick="shuffleSearchFeedTracks()">⤮ Shuffle</button>
         ${saveBtnHtml}
       </div>`
    : (saveBtnHtml ? `<div class="pl-detail-header" style="margin-bottom: 20px; display: flex; gap: 10px; align-items: center;">${saveBtnHtml}</div>` : '');

  let recommendationsHtml = '';
  if (tracks.length > 0) {
    const seedSong = tracks[0];
    recommendationsHtml = `
      <div class="feed-section-title" style="margin-top: 32px; margin-bottom: 12px; font-size: 1.15rem; font-weight: 700; color: var(--text);">Recommended Tracks</div>
      <div class="song-list" id="feed-recommendations-list">
        <div class="loader" style="padding: 20px 0;"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
      </div>
    `;
    
    API.upNext(seedSong, 8).then(recData => {
      const recListEl = $('feed-recommendations-list');
      if (recListEl) {
        let recSongs = Array.isArray(recData) ? recData : (recData.songs || recData.results || []);
        recSongs = filterBanned(recSongs).slice(0, 8);
        if (recSongs.length) {
          recSongs.forEach(s => reg(s));
          recListEl.innerHTML = recSongs.map((s, i) => {
            const rid = reg(s);
            const sid = getSongId(s);
            const art = getArt(s, false);
            const now = S.song && getSongId(S.song) === sid;
            const liked = S.liked.has(sid);
            const heartSvg = liked
              ? `<svg class="row-heart liked" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
              : `<svg class="row-heart" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
            
            return `
              <div class="song-item${now?' now-playing':''}" onclick="playSong(getSong('${rid}'))">
                <img class="song-art" src="${esc(art)}" loading="lazy" onerror="this.style.opacity=.15">
                <div class="song-info">
                  <div class="song-title">${esc(s.trackName||s.title||'—')}</div>
                  <div class="song-artist">${esc(s.artistName||s.artist||'—')}</div>
                </div>
                <button class="song-heart-btn${liked?' liked':''}" data-song-id="${sid}" onclick="event.stopPropagation();_toggleLikeForSong(getSong('${rid}'))" title="${liked?'Remove from Liked':'Add to Liked'}">${heartSvg}</button>
                <button class="song-menu" onclick="event.stopPropagation();openSongActions(getSong('${rid}'))" title="More options">&#8942;</button>
              </div>
            `;
          }).join('');
        } else {
          recListEl.innerHTML = `<div class="empty"><div class="ico">🎵</div><p>No extra recommendations</p></div>`;
        }
      }
    }).catch(() => {
      const recListEl = $('feed-recommendations-list');
      if (recListEl) recListEl.innerHTML = '';
    });
  }

  feedEl.innerHTML = `
    <div class="lib-back" onclick="closeSearchFeed()">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
      Back to Search
    </div>
    <div class="feed-detail-header-card">
      <img class="feed-detail-art" src="${esc(details.thumbnail || '')}" onerror="this.style.opacity=.15">
      <div class="feed-detail-info">
        <div class="feed-detail-badge">${esc(type.toUpperCase())}</div>
        <div class="feed-detail-title">${esc(details.title || details.name)}</div>
        <div class="feed-detail-author">${metaText}</div>
        ${details.description ? `<div class="feed-detail-desc" style="opacity: .6; margin-top: 6px; font-size: 0.85rem;">${esc(details.description)}</div>` : ''}
      </div>
    </div>
    ${playButtonHtml}
    <div class="song-list" id="feed-songs-list"></div>
    ${recommendationsHtml}
  `;

  const songsListEl = $('feed-songs-list');
  if (trackCount > 0) {
    songsListEl.innerHTML = tracks.map((s, i) => {
      const rid = reg(s);
      const sid = getSongId(s);
      const art = getArt(s, false);
      const dur = s.duration ? fmt(s.duration) : '';
      const now = S.song && getSongId(S.song) === sid;
      const liked = S.liked.has(sid);
      const heartSvg = liked
        ? `<svg class="row-heart liked" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
        : `<svg class="row-heart" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

      return `
        <div class="song-item${now?' now-playing':''}" onclick="playSearchFeedSong(${i})">
          <div class="track-num">${i + 1}</div>
          <div class="bars"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>
          <img class="song-art" src="${esc(art)}" loading="lazy" onerror="this.style.opacity=.15">
          <div class="song-info">
            <div class="song-title">${esc(s.trackName||s.title||'—')}</div>
            <div class="song-artist">${esc(s.artistName||s.artist||'—')}</div>
          </div>
          ${dur ? `<div class="song-dur">${dur}</div>` : ''}
          <button class="song-heart-btn${liked?' liked':''}" data-song-id="${sid}" onclick="event.stopPropagation();_toggleLikeForSong(getSong('${rid}'))" title="${liked?'Remove from Liked':'Add to Liked'}">${heartSvg}</button>
          <button class="song-menu" onclick="event.stopPropagation();openSongActions(getSong('${rid}'))" title="More options">&#8942;</button>
        </div>
      `;
    }).join('');
  } else {
    songsListEl.innerHTML = `<div class="empty"><div class="ico">🎵</div><p>No tracks in this playlist</p></div>`;
  }
}

// ─── RENDER SEARCH RESULTS (Unified Discovery & Direct Search View) ────────
function renderSearchResults(data, q) {
  const resultsEl = $('search-results');
  if (!resultsEl) return;

  closeSearchFeed();

  // Handle simple legacy array output
  if (Array.isArray(data)) {
    renderList(resultsEl, filterBanned(data), false);
    return;
  }

  const songs = filterBanned(data.songs || []);
  const playlists = data.playlists || [];
  const artists = data.artists || [];
  const mixes = data.mixes || [];
  const topResult = data.top_result;

  if (!songs.length && !playlists.length && !artists.length) {
    resultsEl.innerHTML = `<div class="empty"><div class="ico">🔍</div><p>No results for "${esc(q)}"</p></div>`;
    return;
  }

  let html = '';

  // 1. TOP RESULT & TOP SONGS
  if (topResult || songs.length) {
    html += `<div class="search-top-row">`;
    
    // Top Result
    if (topResult) {
      const art = topResult.cover || topResult.thumbnail || '';
      const badge = topResult.badge || 'Top Result';
      
      let title = '';
      let sub = '';
      let playAction = '';
      let clickAction = '';
      let isRound = false;

      if (topResult.type === 'song') {
        const rid = reg(topResult);
        title = topResult.trackName || topResult.title || '—';
        sub = `Song • ${topResult.artistName || topResult.artist || '—'}`;
        playAction = `event.stopPropagation(); playSong(getSong('${rid}'))`;
        clickAction = `playSong(getSong('${rid}'))`;
      } else if (topResult.type === 'playlist') {
        title = topResult.title || '—';
        const savedPl = playlists.find(x => x.ytId === topResult.id || x.id === 'pl_yt_' + topResult.id);
        const songCount = savedPl ? savedPl.songs.length : (topResult.trackCount || 0);
        const durText = savedPl ? getPlaylistDurationText(savedPl.songs) : '';
        sub = `Playlist • by ${topResult.author || 'YouTube Music'}` + (songCount ? ` • ${songCount} song${songCount !== 1 ? 's' : ''}` : '') + (durText ? ` • ${durText}` : '');
        clickAction = `openSearchFeed('playlist', '${topResult.id}', '${esc(title)}', '${esc(art)}', '${esc(topResult.author)}')`;
        playAction = `event.stopPropagation(); ${clickAction}`;
      } else if (topResult.type === 'artist') {
        title = topResult.name || '—';
        sub = `Artist`;
        isRound = true;
        clickAction = `openSearchFeed('artist', '${topResult.id}', '${esc(title)}', '${esc(art)}', 'Artist')`;
        playAction = `event.stopPropagation(); ${clickAction}`;
      }

      const isSaved = topResult.type === 'playlist' ? isYTPlaylistSaved(topResult.id) : false;
      const saveBtnHtml = topResult.type === 'playlist'
        ? `<button class="feed-card-save-btn${isSaved ? ' saved' : ''}" data-pl-id="${topResult.id}" onclick="event.stopPropagation(); toggleSaveYTPlaylist('${topResult.id}', '${esc(title)}', '${esc(art)}', '${esc(topResult.author || 'YouTube Music')}')" title="${isSaved ? 'Unsave from Library' : 'Save to Library'}" style="position: absolute; top: 8px; right: 8px; z-index: 10;">
            ${isSaved
              ? `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`
              : `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`
            }
           </button>`
        : '';

      html += `
        <div class="top-result-sec">
          <div class="section-label">Top Result</div>
          <div class="top-result-card${isRound ? ' round-card' : ''}" onclick="${clickAction}">
            <div class="top-result-art-wrap">
              <img class="top-result-art" src="${esc(art)}" onerror="this.style.opacity=.15">
              <button class="top-result-play-btn" onclick="${playAction}" title="Play">
                <svg width="22" height="22" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </button>
              ${saveBtnHtml}
            </div>
            <div class="top-result-title">${esc(title)}</div>
            <div class="top-result-badge-row">
              <span class="top-result-sub">${esc(sub)}</span>
              <span class="top-result-type-badge">${esc(badge)}</span>
            </div>
          </div>
        </div>
      `;
    }

    // Songs
    if (songs.length) {
      const displaySongs = songs.slice(0, 4);
      html += `
        <div class="top-songs-sec">
          <div class="section-label">Songs</div>
          <div class="song-list">
            ${displaySongs.map((s, i) => songItemHTML(s, i, false)).join('')}
          </div>
        </div>
      `;
    }

    html += `</div>`;
  }

  // 2. FEATURED PLAYLISTS
  if (playlists.length) {
    html += `
      <div class="feed-section" style="margin-top: 24px;">
        <div class="section-label-row">
          <div class="section-label">Featured Playlists</div>
        </div>
        <div class="scroll-row">
          ${playlists.map(p => {
            const isSaved = isYTPlaylistSaved(p.id);
            const savedPl = window.playlists ? window.playlists.find(x => x.ytId === p.id || x.id === 'pl_yt_' + p.id) : null;
            const songCount = savedPl ? savedPl.songs.length : (p.trackCount || 0);
            const durText = savedPl ? getPlaylistDurationText(savedPl.songs) : '';
            const subText = `by ${p.author}` + (songCount ? ` • ${songCount} song${songCount !== 1 ? 's' : ''}` : '') + (durText ? ` • ${durText}` : '');
            return `
            <div class="feed-card" onclick="openSearchFeed('playlist', '${p.id}', '${esc(p.title)}', '${esc(p.thumbnail)}', '${esc(p.author)}')">
              <div class="feed-card-art">
                <img src="${esc(p.thumbnail)}" loading="lazy" onerror="this.style.opacity=.15">
                <div class="feed-card-play">
                  <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>
                <button class="feed-card-save-btn${isSaved ? ' saved' : ''}" data-pl-id="${p.id}" onclick="event.stopPropagation(); toggleSaveYTPlaylist('${p.id}', '${esc(p.title)}', '${esc(p.thumbnail)}', '${esc(p.author)}')" title="${isSaved ? 'Unsave from Library' : 'Save to Library'}">
                  ${isSaved
                    ? `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`
                    : `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`
                  }
                </button>
              </div>
              <div class="feed-card-title">${esc(p.title)}</div>
              <div class="feed-card-sub">${esc(subText)}</div>
            </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // 3. ARTISTS (round cards)
  if (artists.length) {
    html += `
      <div class="feed-section" style="margin-top: 24px;">
        <div class="section-label-row">
          <div class="section-label">Artists</div>
        </div>
        <div class="scroll-row">
          ${artists.map(a => `
            <div class="feed-card artist-card-round" onclick="openSearchFeed('artist', '${a.id}', '${esc(a.name)}', '${esc(a.thumbnail)}', 'Artist')">
              <div class="feed-card-art artist-art-round">
                <img src="${esc(a.thumbnail)}" loading="lazy" onerror="this.style.opacity=.15">
              </div>
              <div class="feed-card-title" style="text-align: center; margin-top: 8px;">${esc(a.name)}</div>
              <div class="feed-card-sub" style="text-align: center;">Artist</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // 4. MIXES / SIMILAR
  if (mixes.length) {
    html += `
      <div class="feed-section" style="margin-top: 24px;">
        <div class="section-label-row">
          <div class="section-label">Similar Mixes</div>
        </div>
        <div class="scroll-row">
          ${mixes.map(m => {
            const isSaved = isYTPlaylistSaved(m.id);
            const savedPl = window.playlists ? window.playlists.find(x => x.ytId === m.id || x.id === 'pl_yt_' + m.id) : null;
            const songCount = savedPl ? savedPl.songs.length : (m.trackCount || 0);
            const durText = savedPl ? getPlaylistDurationText(savedPl.songs) : '';
            const subText = `by ${m.author}` + (songCount ? ` • ${songCount} song${songCount !== 1 ? 's' : ''}` : '') + (durText ? ` • ${durText}` : '');
            return `
            <div class="feed-card" onclick="openSearchFeed('playlist', '${m.id}', '${esc(m.title)}', '${esc(m.thumbnail)}', '${esc(m.author)}')">
              <div class="feed-card-art">
                <img src="${esc(m.thumbnail)}" loading="lazy" onerror="this.style.opacity=.15">
                <div class="feed-card-play">
                  <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>
                <button class="feed-card-save-btn${isSaved ? ' saved' : ''}" data-pl-id="${m.id}" onclick="event.stopPropagation(); toggleSaveYTPlaylist('${m.id}', '${esc(m.title)}', '${esc(m.thumbnail)}', '${esc(m.author)}')" title="${isSaved ? 'Unsave from Library' : 'Save to Library'}">
                  ${isSaved
                    ? `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`
                    : `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`
                  }
                </button>
              </div>
              <div class="feed-card-title">${esc(m.title)}</div>
              <div class="feed-card-sub">${esc(subText)}</div>
            </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  resultsEl.innerHTML = html;
}
