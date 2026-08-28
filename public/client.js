(() => {
  const joinScreen = document.getElementById('join-screen');
  const roomScreen = document.getElementById('room-screen');
  const roomInput = document.getElementById('room-input');
  const joinBtn = document.getElementById('join-btn');
  const createBtn = document.getElementById('create-btn');
  const roomCodeEl = document.getElementById('room-code');
  const copyLinkBtn = document.getElementById('copy-link');
  const memberTextEl = document.getElementById('member-text');
  const videoInput = document.getElementById('video-input');
  const loadBtn = document.getElementById('load-btn');
  const noVideoEl = document.getElementById('no-video');
  const statusEl = document.getElementById('status');

  const socket = io();

  let player = null;
  let ytReady = false;
  let pendingState = null;
  let suppressEvents = false;
  let driftTimer = null;
  let expected = 0;
  let lastLoadedId = null;
  const attemptedReplacement = new Set();

  function setStatus(msg) {
    statusEl.textContent = msg || '';
    if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 4000);
  }

  function setMemberText(n) {
    let word = 'osób';
    if (n === 1) word = 'osoba';
    else if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) word = 'osoby';
    memberTextEl.textContent = `${n} ${word} w pokoju`;
  }

  function randomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function extractVideoId(input) {
    if (!input) return null;
    const trimmed = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
    try {
      const url = new URL(trimmed);
      if (url.hostname.includes('youtu.be')) {
        return url.pathname.slice(1, 12) || null;
      }
      if (url.hostname.includes('youtube.com')) {
        if (url.searchParams.get('v')) return url.searchParams.get('v');
        const match = url.pathname.match(/\/(embed|shorts)\/([a-zA-Z0-9_-]{11})/);
        if (match) return match[2];
      }
    } catch (e) {
      // not a valid URL
    }
    return null;
  }

  function goToRoom(code) {
    code = code.trim().toUpperCase();
    if (!code) return;
    const url = new URL(window.location.href);
    url.searchParams.set('room', code);
    window.history.replaceState({}, '', url);

    joinScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');
    roomCodeEl.textContent = code;

    socket.emit('join-room', code);
  }

  joinBtn.addEventListener('click', () => goToRoom(roomInput.value || randomCode()));
  createBtn.addEventListener('click', () => goToRoom(randomCode()));
  roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') goToRoom(roomInput.value || randomCode()); });

  copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setStatus('Link skopiowany!');
    } catch (e) {
      setStatus(window.location.href);
    }
  });

  loadBtn.addEventListener('click', () => loadVideoLocal(videoInput.value));
  videoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadVideoLocal(videoInput.value); });

  function broadcastState(playing) {
    if (!player || typeof player.getVideoData !== 'function') return;
    const data = player.getVideoData();
    socket.emit('update', {
      videoId: data.video_id,
      title: data.title,
      time: player.getCurrentTime(),
      playing,
    });
  }

  function stopDriftCheck() {
    if (driftTimer) clearInterval(driftTimer);
    driftTimer = null;
  }

  function startDriftCheck() {
    stopDriftCheck();
    expected = player.getCurrentTime();
    driftTimer = setInterval(() => {
      if (!player || suppressEvents) { if (player) expected = player.getCurrentTime(); return; }
      expected += 1;
      const actual = player.getCurrentTime();
      if (Math.abs(actual - expected) > 1.5) {
        expected = actual;
        broadcastState(true);
      }
    }, 1000);
  }

  function onPlayerStateChange(e) {
    if (suppressEvents) return;
    if (e.data === YT.PlayerState.PLAYING) {
      broadcastState(true);
      startDriftCheck();
    } else if (e.data === YT.PlayerState.PAUSED) {
      broadcastState(false);
      stopDriftCheck();
    } else if (e.data === YT.PlayerState.ENDED) {
      stopDriftCheck();
    }
  }

  // 100 = removed/private, 101 & 150 = embedding disabled by the owner.
  function onPlayerError(e) {
    const id = lastLoadedId;
    if (!id) return;
    if (e.data === 100 || e.data === 101 || e.data === 150) {
      handleEmbedError(id);
    } else {
      setStatus('Nie udało się odtworzyć tego filmu.');
    }
  }

  async function handleEmbedError(videoId) {
    if (attemptedReplacement.has(videoId)) {
      setStatus('Ten film jest niedostępny do odtworzenia poza YouTube. Wklej inny link.');
      return;
    }
    attemptedReplacement.add(videoId);
    setStatus('Ten film ma wyłączone odtwarzanie poza YouTube — szukam zamiennika…');

    try {
      const res = await fetch(`/api/replacement/${videoId}`);
      const data = await res.json();

      if (!res.ok || data.error === 'no_api_key') {
        setStatus('Ten film jest niedostępny do odtworzenia poza YouTube. Wklej inny link.');
        return;
      }
      if (!data.candidates || !data.candidates.length) {
        setStatus('Nie znaleziono zamiennika dla tego filmu. Wklej inny link.');
        return;
      }

      const pick = data.candidates[0];
      setStatus(`Ten film jest niedostępny — przełączono na: "${pick.title}" (${pick.channel})`);
      playVideoId(pick.videoId);
    } catch (e) {
      setStatus('Nie udało się znaleźć zamiennika. Wklej inny link.');
    }
  }

  function playVideoId(id) {
    lastLoadedId = id;
    noVideoEl.classList.add('hidden');
    suppressEvents = true;

    if (!player) {
      player = new YT.Player('player', {
        videoId: id,
        playerVars: { autoplay: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: () => { suppressEvents = false; broadcastState(true); startDriftCheck(); },
          onStateChange: onPlayerStateChange,
          onError: onPlayerError,
        },
      });
    } else {
      player.loadVideoById(id);
      setTimeout(() => { suppressEvents = false; broadcastState(true); startDriftCheck(); }, 800);
    }
  }

  function loadVideoLocal(rawInput) {
    const id = extractVideoId(rawInput);
    if (!id) { setStatus('Nie rozpoznano linku do YouTube.'); return; }
    videoInput.value = '';
    playVideoId(id);
  }

  function applyRemoteState(state) {
    if (!ytReady) { pendingState = state; return; }
    if (!state.videoId) return;
    noVideoEl.classList.add('hidden');

    suppressEvents = true;
    lastLoadedId = state.videoId;

    if (!player) {
      player = new YT.Player('player', {
        videoId: state.videoId,
        playerVars: { autoplay: state.playing ? 1 : 0, rel: 0, playsinline: 1 },
        events: {
          onReady: () => {
            player.seekTo(state.time, true);
            if (state.playing) { player.playVideo(); startDriftCheck(); } else player.pauseVideo();
            setTimeout(() => { suppressEvents = false; }, 1000);
          },
          onStateChange: onPlayerStateChange,
          onError: onPlayerError,
        },
      });
      return;
    }

    const data = player.getVideoData ? player.getVideoData() : null;
    const loadedId = data ? data.video_id : null;

    if (loadedId !== state.videoId) {
      if (state.playing) player.loadVideoById(state.videoId, state.time);
      else player.cueVideoById(state.videoId, state.time);
    } else {
      const drift = Math.abs(player.getCurrentTime() - state.time);
      if (drift > 1.5) player.seekTo(state.time, true);
      if (state.playing) player.playVideo(); else player.pauseVideo();
    }

    if (state.playing) startDriftCheck(); else stopDriftCheck();
    setTimeout(() => { suppressEvents = false; }, 1000);
  }

  window.onYouTubeIframeAPIReady = function () {
    ytReady = true;
    if (pendingState) { applyRemoteState(pendingState); pendingState = null; }
  };

  socket.on('state', (state) => {
    setMemberText(state.members ?? 1);
    applyRemoteState(state);
  });

  socket.on('members', (n) => { setMemberText(n); });

  // Auto-join if a room code is already in the URL.
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get('room');
  if (roomFromUrl) {
    goToRoom(roomFromUrl);
  }
})();
