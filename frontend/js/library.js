// ═══════════════════════════════════════════════════════════════════════════
// PLAYLIST & LIBRARY SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

function savePlaylists() {
  localStorage.setItem('dyd_playlists', JSON.stringify(playlists));
  // Also update sidebar playlists
  if (typeof renderSidebarPlaylists === 'function') renderSidebarPlaylists();
  // Update home playlists feed
  if (typeof renderHomePlaylists === 'function') renderHomePlaylists();
}

function createPlaylist(name, songToAdd) {
  const pl = { id: 'pl_' + Date.now(), name: name.trim() || 'My Playlist', songs: [], createdAt: Date.now() };
  if (songToAdd) {
    reg(songToAdd);
    pl.songs.push(songToAdd);
  }
  playlists.push(pl);
  savePlaylists();
  if (S.tab === 'library') renderLibrary();
  toast(`Playlist "${pl.name}" created`);
  return pl;
}

function addToPlaylist(playlistId, song) {
  const pl = playlists.find(p => p.id === playlistId);
  if (!pl) { toast('Playlist not found'); return; }
  const sid = getSongId(song);
  if (pl.songs.some(s => getSongId(s) === sid)) {
    toast('Already in playlist');
    return;
  }
  reg(song);
  pl.songs.push(song);
  savePlaylists();
  toast(`Added to "${pl.name}"`);
  // Refresh view if library tab is active
  if (S.tab === 'library') {
    renderLibrary();
  }
  // Refresh search feed details if active and matching
  if (typeof currentSearchFeedId !== 'undefined' && (currentSearchFeedId === playlistId || currentSearchFeedId === pl.ytId || 'pl_yt_' + currentSearchFeedId === playlistId)) {
    if (typeof renderSearchFeedDetails === 'function') {
      renderSearchFeedDetails(pl, typeof currentSearchFeedType !== 'undefined' ? currentSearchFeedType : 'playlist');
    }
  }
}

function removeFromPlaylist(playlistId, idx) {
  const pl = playlists.find(p => p.id === playlistId);
  if (!pl) return;
  const removed = pl.songs.splice(idx, 1)[0];
  savePlaylists();
  toast(`Removed from "${pl.name}"`);
  if (libraryView === 'playlist' && currentPlaylistId === playlistId) renderLibrary();
  // Refresh search feed details if active and matching
  if (typeof currentSearchFeedId !== 'undefined' && (currentSearchFeedId === playlistId || currentSearchFeedId === pl.ytId || 'pl_yt_' + currentSearchFeedId === playlistId)) {
    if (typeof renderSearchFeedDetails === 'function') {
      renderSearchFeedDetails(pl, typeof currentSearchFeedType !== 'undefined' ? currentSearchFeedType : 'playlist');
    }
  }
}

function deletePlaylist(playlistId) {
  const pl = playlists.find(p => p.id === playlistId);
  const name = pl ? pl.name : '';
  playlists = playlists.filter(p => p.id !== playlistId);
  savePlaylists();
  libraryView = 'main';
  renderLibrary();
  toast(`Playlist "${name}" deleted`);
}

function playPlaylist(playlistId, startIdx) {
  const pl = playlists.find(p => p.id === playlistId);
  if (!pl || !pl.songs.length) return;
  startIdx = startIdx || 0;
  const first = pl.songs[startIdx];
  reg(first);
  const remaining = pl.songs.slice(startIdx + 1);
  remaining.forEach(s => reg(s));
  S.history = pl.songs.slice(0, startIdx);
  S.history.forEach(s => reg(s));
  S.queue = remaining;
  S._manualQueue = true;
  playSong(first, false, true); // keepQueue=true, addHistory=false to preserve play history
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
  S._manualQueue = true;
  playSong(first, true, true); // keepQueue=true
  renderQueue();
}

// ─── LIBRARY RENDERING ────────────────────────────────────────────────────
function getPlaylistArtHtml(songs, fallbackThumb, large = false) {
  const arts = (songs || []).map(s => getArt(s, false)).filter(Boolean);
  const sizeClass = large ? 'feed-detail-art' : 'lib-card-icon';
  
  if (arts.length >= 4) {
    return `<div class="${large ? 'feed-detail-art-grid' : 'pl-grid'}">${arts.slice(0, 4).map(a => `<img src="${esc(a)}">`).join('')}</div>`;
  } else if (arts.length > 0) {
    return `<img class="${sizeClass}" src="${esc(arts[0])}" loading="lazy" onerror="this.style.opacity=.15">`;
  } else if (fallbackThumb) {
    return `<img class="${sizeClass}" src="${esc(fallbackThumb)}" loading="lazy" onerror="this.style.opacity=.15">`;
  } else {
    return `<div class="${sizeClass} feed-detail-art-placeholder" style="display:flex;align-items:center;justify-content:center;font-size:${large?'3.5rem':'1.1rem'};opacity:0.35;background:var(--surface3)">🎵</div>`;
  }
}

function getLikedSongsArtHtml(songs, sizeOption = 'small') {
  const arts = (songs || []).map(s => getArt(s, false)).filter(Boolean);
  
  let size = 'small';
  if (sizeOption === true || sizeOption === 'large') {
    size = 'large';
  } else if (sizeOption === 'medium') {
    size = 'medium';
  }
  
  let sizeClass = 'lib-card-icon';
  let heartSize = '1.1rem';
  let shadowOffset = '4';
  let shadowBlur = '12';
  
  if (size === 'large') {
    sizeClass = 'feed-detail-art';
    heartSize = '3.5rem';
    shadowOffset = '8';
    shadowBlur = '24';
  } else if (size === 'medium') {
    sizeClass = 'feed-card-art-inner';
    heartSize = '2.2rem';
    shadowOffset = '6';
    shadowBlur = '18';
  }
  
  if (arts.length >= 4) {
    let gridClass = 'pl-grid';
    if (size === 'large') gridClass = 'feed-detail-art-grid';
    else if (size === 'medium') gridClass = 'feed-card-art-grid';
    return `<div class="${gridClass}">${arts.slice(0, 4).map(a => `<img src="${esc(a)}">`).join('')}</div>`;
  } else if (arts.length > 0) {
    return `<img class="${sizeClass}" src="${esc(arts[0])}" loading="lazy" onerror="this.style.opacity=.15">`;
  } else {
    let wrapClass = sizeClass;
    if (size === 'medium') wrapClass = 'feed-card-art-inner';
    return `<div class="${wrapClass} liked-placeholder-art ${size}" style="display:flex;align-items:center;justify-content:center;font-size:${heartSize};background:linear-gradient(135deg, #ff4b91, #ff7676);color:white;box-shadow: 0 ${shadowOffset}px ${shadowBlur}px rgba(255, 75, 145, 0.3); position:relative;">♥</div>`;
  }
}

function isYTPlaylistSaved(id) {
  return playlists.some(p => p.id === 'pl_yt_' + id || p.ytId === id);
}

function toggleSaveYTPlaylist(id, title, thumbnail, author, trackCount) {
  const plId = 'pl_yt_' + id;
  const idx = playlists.findIndex(p => p.id === plId || p.ytId === id);
  if (idx !== -1) {
    // Unsave it
    playlists.splice(idx, 1);
    savePlaylists();
    toast('Playlist removed from library');
    _updateSaveButtons(id, false);
    if (S.tab === 'library') renderLibrary();
    return;
  }

  // Create saved playlist placeholder
  const newPl = {
    id: plId,
    name: title,
    thumbnail: thumbnail,
    author: author,
    isYT: true,
    ytId: id,
    songs: [],
    trackCount: trackCount || 0,
    createdAt: Date.now()
  };

  playlists.push(newPl);
  savePlaylists();
  toast('Saving playlist...');
  _updateSaveButtons(id, true);
  if (S.tab === 'library') renderLibrary();

  // Prefetch and cache songs
  API.playlistDetails(id).then(details => {
    const pl = playlists.find(p => p.id === plId);
    if (pl && details && details.tracks) {
      pl.songs = details.tracks;
      pl.description = details.description || '';
      pl.trackCount = details.tracks.length;
      details.tracks.forEach(s => reg(s));
      savePlaylists();
      if (S.tab === 'library') renderLibrary();
      toast('Playlist saved ✓');
    }
  }).catch(err => {
    console.error(err);
    toast('Failed to load playlist songs');
  });
}

function _updateSaveButtons(id, isSaved) {
  document.querySelectorAll(`.feed-card-save-btn[data-pl-id="${id}"], .pl-save-btn[data-pl-id="${id}"]`).forEach(btn => {
    btn.classList.toggle('saved', isSaved);
    if (btn.classList.contains('pl-save-btn')) {
      btn.innerHTML = isSaved ? '✓ Saved' : '+ Save';
    } else {
      btn.innerHTML = isSaved
        ? `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`
        : `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;
    }
  });
}

// ─── LIBRARY RENDERING ────────────────────────────────────────────────────
function renderLibrary() {
  const view = $('library-view');
  if (!view) return;

  const likedSongs = [...S.liked].map(id => S.songs[id] || _savedLikedSongs[id]).filter(Boolean);
  const likedCount = likedSongs.length;

  if (libraryView === 'liked') {
    const count = likedSongs.length;
    const durText = getPlaylistDurationText(likedSongs);
    const metaText = `${count} song${count !== 1 ? 's' : ''}${durText ? ' • ' + durText : ''}`;
    const artHtml = getLikedSongsArtHtml(likedSongs, true);

    view.innerHTML = `
      <div class="lib-back" onclick="libraryView='main';renderLibrary()">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
        Back to Library
      </div>
      
      <div class="feed-detail-header-card">
        ${artHtml}
        <div class="feed-detail-info">
          <div class="feed-detail-badge" style="color: var(--pink);">SYSTEM PLAYLIST</div>
          <div class="feed-detail-title">Liked Songs</div>
          <div class="feed-detail-author">by Me • ${metaText}</div>
          <div class="feed-detail-desc" style="opacity: .6; margin-top: 6px; font-size: 0.85rem;">Your collection of favorite tracks.</div>
        </div>
      </div>
      
      <div class="pl-detail-header">
        ${count ? `<button class="pl-play-btn" onclick="playLikedSongs(0)">▶ Play All</button>
        <button class="pl-shuffle-btn" onclick="shuffleLikedSongs()">⤮ Shuffle</button>` : ''}
      </div>
      <div class="song-list" id="liked-list"></div>`;
    const el = $('liked-list');
    if (likedSongs.length) {
      el.innerHTML = likedSongs.map((s, i) => {
        const rid = reg(s);
        const sid = getSongId(s);
        const art = getArt(s, false);
        const dur = s.duration ? fmt(s.duration) : '';
        const now = S.song && getSongId(S.song) === sid;
        const liked = S.liked.has(sid);
        const heartSvg = liked
          ? `<svg class="row-heart liked" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
          : `<svg class="row-heart" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
        return `<div class="song-item${now?' now-playing':''}" onclick="playLikedSongs(${i})">
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
        </div>`;
      }).join('');
    } else {
      el.innerHTML = `<div class="empty"><div class="ico">♥</div><p>Songs you like will appear here</p></div>`;
    }
    return;
  }

  if (libraryView === 'playlist' && currentPlaylistId) {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl) { libraryView = 'main'; renderLibrary(); return; }

    // Fetch YT playlist dynamically if not loaded
    if (pl.isYT && (!pl.songs || pl.songs.length === 0)) {
      view.innerHTML = `
        <div class="lib-back" onclick="libraryView='main';renderLibrary()">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
          Back to Library
        </div>
        <div class="feed-detail-header-card">
          <img class="feed-detail-art" src="${esc(pl.thumbnail || '')}" onerror="this.style.opacity=.15">
          <div class="feed-detail-info">
            <div class="feed-detail-badge">SAVED PLAYLIST</div>
            <div class="feed-detail-title">${esc(pl.name)}</div>
            <div class="feed-detail-author">by ${esc(pl.author || 'YouTube Music')}</div>
          </div>
        </div>
        <div class="loader-wrap" style="padding: 40px 0; text-align: center;">
          <div class="loader"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
        </div>
      `;
      
      API.playlistDetails(pl.ytId).then(details => {
        if (details && details.tracks) {
          pl.songs = details.tracks;
          pl.description = details.description || '';
          pl.trackCount = details.tracks.length;
          details.tracks.forEach(s => reg(s));
          savePlaylists();
          if (libraryView === 'playlist' && currentPlaylistId === pl.id) {
            renderLibrary();
          }
        }
      }).catch(err => {
        console.error(err);
        if (libraryView === 'playlist' && currentPlaylistId === pl.id) {
          view.innerHTML = `
            <div class="lib-back" onclick="libraryView='main';renderLibrary()">
              <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
              Back to Library
            </div>
            <div class="empty"><div class="ico">⚠️</div><p>Failed to load playlist songs.</p></div>
          `;
        }
      });
      return;
    }

    const count = pl.songs.length;
    const durText = getPlaylistDurationText(pl.songs);
    const metaText = `${count} song${count !== 1 ? 's' : ''}${durText ? ' • ' + durText : ''}`;
    const artHtml = getPlaylistArtHtml(pl.songs, pl.thumbnail, true);
    const authorText = pl.author || 'Me';
    const typeLabel = pl.isYT ? 'Saved Playlist' : 'Playlist';
    const descText = pl.description || (pl.isYT ? 'Saved YouTube Music playlist' : 'Local playlist');
    const saveBtnHtml = pl.isYT
      ? `<button class="pl-save-btn saved" data-pl-id="${esc(pl.ytId)}" onclick="event.stopPropagation(); toggleSaveYTPlaylist('${esc(pl.ytId)}', '${esc(pl.name)}', '${esc(pl.thumbnail)}', '${esc(pl.author)}', ${count})">✓ Saved</button>`
      : '';

    view.innerHTML = `
      <div class="lib-back" onclick="libraryView='main';renderLibrary()">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
        Back to Library
      </div>
      
      <div class="feed-detail-header-card">
        ${artHtml}
        <div class="feed-detail-info">
          <div class="feed-detail-badge">${esc(typeLabel.toUpperCase())}</div>
          <div class="feed-detail-title">${esc(pl.name)}</div>
          <div class="feed-detail-author">by ${esc(authorText)} • ${metaText}</div>
          <div class="feed-detail-desc" style="opacity: .6; margin-top: 6px; font-size: 0.85rem;">${esc(descText)}</div>
        </div>
      </div>
      
      <div class="pl-detail-header">
        ${count ? `<button class="pl-play-btn" onclick="playPlaylist('${pl.id}')">▶ Play All</button>
        <button class="pl-shuffle-btn" onclick="shufflePlaylist('${pl.id}')">⤮ Shuffle</button>` : ''}
        ${saveBtnHtml}
        ${!pl.isYT ? `<button class="pl-shuffle-btn" onclick="renamePlaylist('${pl.id}')" style="margin-left:auto;">✏ Rename</button>` : ''}
        <button class="pl-shuffle-btn" onclick="deletePlaylist('${pl.id}')" style="${pl.isYT ? 'margin-left:auto;' : ''}color:var(--pink)">🗑 Delete</button>
      </div>
      <div class="song-list" id="pl-songs"></div>`;

    const el = $('pl-songs');
    if (count) {
      el.innerHTML = pl.songs.map((s, i) => {
        const rid = reg(s);
        const sid = getSongId(s);
        const art = getArt(s, false);
        const dur = s.duration ? fmt(s.duration) : '';
        const now = S.song && getSongId(S.song) === sid;
        const liked = S.liked.has(sid);
        const heartSvg = liked
          ? `<svg class="row-heart liked" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
          : `<svg class="row-heart" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
        return `<div class="song-item${now?' now-playing':''}" onclick="playPlaylist('${pl.id}',${i})">
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
        </div>`;
      }).join('');
    } else {
      el.innerHTML = `<div class="empty"><div class="ico">🎵</div><p>Add songs from search or home</p></div>`;
    }
    return;
  }

  // Main library view
  const plCards = playlists.map(pl => {
    const count = pl.songs && pl.songs.length ? pl.songs.length : (pl.trackCount || 0);
    const iconHtml = getPlaylistArtHtml(pl.songs, pl.thumbnail, false);
    let durText = pl.songs && pl.songs.length ? getPlaylistDurationText(pl.songs) : '';
    if (!durText && count) {
      durText = getEstimatedDurationText(count);
    }
    return `<div class="lib-card pl-card" onclick="currentPlaylistId='${pl.id}';libraryView='playlist';renderLibrary()">
      ${iconHtml}
      <div class="lib-card-info">
        <div class="lib-card-title">${esc(pl.name)}</div>
        <div class="lib-card-count">${count} song${count!==1?'s':''}${durText ? ' • ' + durText : ''}</div>
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
      ${getLikedSongsArtHtml(likedSongs, false)}
      <div class="lib-card-info">
        <div class="lib-card-title">Liked Songs</div>
        <div class="lib-card-count">${likedCount} song${likedCount!==1?'s':''}${getPlaylistDurationText(likedSongs) ? ' • ' + getPlaylistDurationText(likedSongs) : ''}</div>
      </div>
      <div class="lib-card-arrow">›</div>
    </div>
    <div class="section-label-row">
      <div class="section-label">Your Playlists</div>
      <button class="add-pl-btn" onclick="openCreatePlaylist()">+ New</button>
    </div>
    ${plCards || `<div class="empty" style="padding:30px 20px"><div class="ico">📋</div><p>Create your first playlist</p></div>`}`;
    
  renderSidebarPlaylists();
}

function renderSidebarPlaylists() {
  const navPl = $('nav-playlists');
  if (!navPl) return;

  const likedSongs = [...S.liked].map(id => S.songs[id] || _savedLikedSongs[id]).filter(Boolean);
  const likedCount = likedSongs.length;

  let html = `<div class="sidebar-label" style="padding: 16px 20px 8px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 700;">Your Library</div>`;
  
  html += `
  <div class="sidebar-pl-item ${libraryView === 'liked' && S.tab === 'library' ? 'active' : ''}" onclick="switchTab('library'); libraryView='liked'; renderLibrary();">
    ${getLikedSongsArtHtml(likedSongs, false).replace(/lib-card-icon/g, 'sidebar-pl-art').replace(/pl-grid/g, 'pl-grid-sidebar').replace(/50px/g, '44px')}
    <div class="sidebar-pl-info">
      <div class="sidebar-pl-name">Liked Songs</div>
      <div class="sidebar-pl-meta">${likedCount} song${likedCount!==1?'s':''}${getPlaylistDurationText(likedSongs) ? ' • ' + getPlaylistDurationText(likedSongs) : ''}</div>
    </div>
  </div>`;

  html += playlists.map(pl => {
    const count = pl.songs && pl.songs.length ? pl.songs.length : (pl.trackCount || 0);
    const art = pl.thumbnail || (pl.songs.length ? getArt(pl.songs[0], false) : '');
    const imgHtml = art ? `<img class="sidebar-pl-art" src="${esc(art)}">` : `<div class="sidebar-pl-art default-art">🎵</div>`;
    let durText = pl.songs && pl.songs.length ? getPlaylistDurationText(pl.songs) : '';
    if (!durText && count) {
      durText = getEstimatedDurationText(count);
    }
    return `
    <div class="sidebar-pl-item ${libraryView === 'playlist' && currentPlaylistId === pl.id && S.tab === 'library' ? 'active' : ''}" onclick="switchTab('library'); currentPlaylistId='${pl.id}'; libraryView='playlist'; renderLibrary();">
      ${imgHtml}
      <div class="sidebar-pl-info">
        <div class="sidebar-pl-name">${esc(pl.name)}</div>
        <div class="sidebar-pl-meta">${count} song${count!==1?'s':''}${durText ? ' • ' + durText : ''}</div>
      </div>
    </div>`;
  }).join('');

  navPl.innerHTML = html;
}

function renamePlaylist(playlistId) {
  const pl = playlists.find(p => p.id === playlistId);
  if (!pl) return;
  const newName = prompt("Rename Playlist", pl.name);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed) {
    toast("Name cannot be empty");
    return;
  }
  pl.name = trimmed;
  savePlaylists();
  renderLibrary();
  toast("Playlist renamed");
}

function playLikedSongs(startIdx) {
  const songs = [...S.liked].map(id => S.songs[id] || _savedLikedSongs[id]).filter(Boolean);
  if (!songs.length) return;
  startIdx = startIdx || 0;
  const first = songs[startIdx];
  reg(first);
  const remaining = songs.slice(startIdx + 1);
  remaining.forEach(s => reg(s));
  S.history = songs.slice(0, startIdx);
  S.history.forEach(s => reg(s));
  S.queue = remaining;
  S._manualQueue = true;
  playSong(first, false, true); // keepQueue=true, addHistory=false
  renderQueue();
}
function shuffleLikedSongs() {
  const songs = [...S.liked].map(id => S.songs[id] || _savedLikedSongs[id]).filter(Boolean).sort(() => Math.random() - 0.5);
  if (!songs.length) return;
  const first = songs.shift();
  reg(first); songs.forEach(s => reg(s));
  S.queue = songs;
  S._manualQueue = true;
  playSong(first, true, true);
  renderQueue();
}
