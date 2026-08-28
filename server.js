const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

async function fetchOEmbedTitle(videoId) {
  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`
  );
  if (!res.ok) return null;
  const info = await res.json();
  return info.title || null;
}

// Looks up an embeddable title for a bare link before it's ever been played,
// so the queue can show a real title + thumbnail instead of just an ID.
app.get('/api/meta/:videoId', async (req, res) => {
  const videoId = req.params.videoId;
  if (!VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'bad_video_id' });
  }
  try {
    const title = await fetchOEmbedTitle(videoId);
    if (!title) return res.status(404).json({ error: 'not_found' });
    res.json({ title });
  } catch (e) {
    res.status(500).json({ error: 'lookup_failed' });
  }
});

// Finds other embeddable uploads of the same title via the official YouTube
// Data API (search + status.embeddable check) — used both to recover from a
// video whose owner disabled embedding, and to show "up next" suggestions.
// No scraping, no bypassing restrictions, just discovery of alternate uploads.
app.get('/api/related/:videoId', async (req, res) => {
  if (!YT_API_KEY) {
    return res.status(501).json({ error: 'no_api_key' });
  }

  const videoId = req.params.videoId;
  if (!VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'bad_video_id' });
  }

  try {
    const title = await fetchOEmbedTitle(videoId);
    if (!title) {
      return res.status(404).json({ error: 'not_found' });
    }

    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('key', YT_API_KEY);
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('maxResults', '8');
    searchUrl.searchParams.set('q', title);

    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) {
      return res.status(502).json({ error: 'search_failed' });
    }
    const searchData = await searchRes.json();
    const candidateIds = (searchData.items || [])
      .map((it) => it.id && it.id.videoId)
      .filter((id) => id && id !== videoId);

    if (!candidateIds.length) {
      return res.json({ originalTitle: title, candidates: [] });
    }

    const statusUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    statusUrl.searchParams.set('key', YT_API_KEY);
    statusUrl.searchParams.set('part', 'status,snippet');
    statusUrl.searchParams.set('id', candidateIds.join(','));

    const statusRes = await fetch(statusUrl);
    if (!statusRes.ok) {
      return res.status(502).json({ error: 'status_check_failed' });
    }
    const statusData = await statusRes.json();

    const candidates = (statusData.items || [])
      .filter((it) => it.status && it.status.embeddable)
      .map((it) => ({
        videoId: it.id,
        title: it.snippet.title,
        channel: it.snippet.channelTitle,
      }));

    res.json({ originalTitle: title, candidates });
  } catch (e) {
    res.status(500).json({ error: 'search_failed' });
  }
});

// Free-text YouTube search (as opposed to /api/related, which searches by
// an existing video's title). Filters to embeddable results for the same
// reason: no point surfacing a result that won't actually play.
app.get('/api/search', async (req, res) => {
  if (!YT_API_KEY) {
    return res.status(501).json({ error: 'no_api_key' });
  }

  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  if (!q) {
    return res.json({ results: [] });
  }

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('key', YT_API_KEY);
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('maxResults', '10');
    searchUrl.searchParams.set('q', q);

    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) {
      return res.status(502).json({ error: 'search_failed' });
    }
    const searchData = await searchRes.json();
    const ids = (searchData.items || []).map((it) => it.id && it.id.videoId).filter(Boolean);

    if (!ids.length) {
      return res.json({ results: [] });
    }

    const statusUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    statusUrl.searchParams.set('key', YT_API_KEY);
    statusUrl.searchParams.set('part', 'status,snippet');
    statusUrl.searchParams.set('id', ids.join(','));

    const statusRes = await fetch(statusUrl);
    if (!statusRes.ok) {
      return res.status(502).json({ error: 'status_check_failed' });
    }
    const statusData = await statusRes.json();

    const results = (statusData.items || [])
      .filter((it) => it.status && it.status.embeddable)
      .map((it) => ({
        videoId: it.id,
        title: it.snippet.title,
        channel: it.snippet.channelTitle,
      }));

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: 'search_failed' });
  }
});

// Emotes are hotlinked straight to BetterTTV's and 7TV's own public CDNs
// (cdn.betterttv.net, cdn.7tv.app) rather than copied into this app — both
// services expose unauthenticated, no-key-needed read APIs meant for exactly
// this kind of third-party embedding.
const EMOTE_CACHE_TTL = 6 * 60 * 60 * 1000;
const SHORTCODE_RE = /^[a-z0-9_+-]+$/;
const CHANNEL_TWITCH_ID = '123180725'; // rybsonlol_

async function getBttvGlobalEmotes() {
  try {
    const res = await fetch('https://api.betterttv.net/3/cached/emotes/global');
    if (!res.ok) throw new Error(`bttv global status ${res.status}`);
    const data = await res.json();
    return data
      .filter((e) => SHORTCODE_RE.test(e.code.toLowerCase()))
      .map((e) => ({
        code: e.code.toLowerCase(),
        url: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        animated: !!e.animated,
      }));
  } catch (e) {
    console.error('BetterTTV global fetch failed:', e.message);
    return [];
  }
}

async function getBttvChannelEmotes(twitchId) {
  try {
    const res = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`);
    if (!res.ok) throw new Error(`bttv channel status ${res.status}`);
    const data = await res.json();
    const all = [...(data.channelEmotes || []), ...(data.sharedEmotes || [])];
    return all
      .filter((e) => SHORTCODE_RE.test(e.code.toLowerCase()))
      .map((e) => ({
        code: e.code.toLowerCase(),
        url: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        animated: !!e.animated,
      }));
  } catch (e) {
    console.error('BetterTTV channel fetch failed:', e.message);
    return [];
  }
}

async function getSevenTvChannelEmotes(twitchId) {
  try {
    const res = await fetch(`https://7tv.io/v3/users/twitch/${twitchId}`);
    if (!res.ok) throw new Error(`7tv status ${res.status}`);
    const data = await res.json();
    const emotes = (data.emote_set && data.emote_set.emotes) || [];
    return emotes
      .filter((e) => SHORTCODE_RE.test(e.name.toLowerCase()))
      .map((e) => {
        const files = e.data && e.data.host && e.data.host.files ? e.data.host.files : [];
        const pick = files.find((f) => f.name === '2x.webp') || files.find((f) => f.name.endsWith('.webp')) || files[0];
        if (!pick) return null;
        return {
          code: e.name.toLowerCase(),
          url: `https:${e.data.host.url}/${pick.name}`,
          animated: !!e.data.animated,
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.error('7TV channel fetch failed:', e.message);
    return [];
  }
}

let emoteCache = null;
let emoteCachedAt = 0;

async function getAllEmotes() {
  if (emoteCache && Date.now() - emoteCachedAt < EMOTE_CACHE_TTL) {
    return emoteCache;
  }
  const [global, channelBttv, channel7tv] = await Promise.all([
    getBttvGlobalEmotes(),
    getBttvChannelEmotes(CHANNEL_TWITCH_ID),
    getSevenTvChannelEmotes(CHANNEL_TWITCH_ID),
  ]);
  // 7TV listed last so it wins on a code collision with the channel's BTTV set.
  const channelMap = new Map();
  [...channelBttv, ...channel7tv].forEach((e) => channelMap.set(e.code, e));

  emoteCache = { global, channel: Array.from(channelMap.values()) };
  emoteCachedAt = Date.now();
  return emoteCache;
}

app.get('/api/emotes', async (req, res) => {
  res.json(await getAllEmotes());
});

const httpServer = app.listen(PORT, () => {
  console.log(`Listen-together server running at http://localhost:${PORT}`);
  if (!YT_API_KEY) {
    console.log('YOUTUBE_API_KEY not set — automatic replacement and suggestions are disabled.');
  }
  getAllEmotes(); // warm the cache so the first chat user isn't stuck waiting
});

const io = new Server(httpServer);

// In-memory room state. Fine for a small, single-process app.
// rooms: Map<roomCode, { videoId, title, time, playing, updatedAt, queue, history }>
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      videoId: null,
      title: null,
      time: 0,
      playing: false,
      updatedAt: Date.now(),
      queue: [],
      history: [],
      messages: [],
    });
  }
  return rooms.get(code);
}

function currentTime(state) {
  if (!state.videoId) return 0;
  if (!state.playing) return state.time;
  return state.time + (Date.now() - state.updatedAt) / 1000;
}

function roomSize(code) {
  const room = io.sockets.adapter.rooms.get(code);
  return room ? room.size : 0;
}

function roomMembers(code) {
  const room = io.sockets.adapter.rooms.get(code);
  if (!room) return [];
  return Array.from(room)
    .map((id) => io.sockets.sockets.get(id))
    .filter(Boolean)
    .map((s) => ({ name: s.data.name || 'Gość', color: s.data.color || DEFAULT_NAME_COLOR }));
}

function broadcastMembers(code) {
  io.to(code).emit('members', roomSize(code));
  io.to(code).emit('members-list', roomMembers(code));
}

function pushHistory(state, videoId, title) {
  if (!videoId) return;
  state.history = state.history.filter((h) => h.videoId !== videoId);
  state.history.unshift({ videoId, title: title || null });
  state.history = state.history.slice(0, 10);
}

function fullState(code) {
  const state = getRoom(code);
  return {
    videoId: state.videoId,
    title: state.title,
    time: currentTime(state),
    playing: state.playing,
    members: roomSize(code),
    queue: state.queue,
    history: state.history,
  };
}

const DEFAULT_NAME_COLOR = '#ff3b3b';
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function postChatMessage(code, name, text, color) {
  const state = getRoom(code);
  const msg = { name, text, ts: Date.now(), color: color || DEFAULT_NAME_COLOR };
  state.messages.push(msg);
  state.messages = state.messages.slice(-50);
  io.to(code).emit('chat-message', msg);
}

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.data.name = 'Gość';
  socket.data.color = DEFAULT_NAME_COLOR;

  socket.on('join-room', (payload) => {
    const code = payload && typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : null;
    if (!code) return;

    const rawName = payload && typeof payload.name === 'string' ? payload.name.trim() : '';
    socket.data.name = rawName ? rawName.slice(0, 24) : `Gość${Math.floor(1000 + Math.random() * 9000)}`;

    const rawColor = payload && typeof payload.color === 'string' ? payload.color.trim() : '';
    socket.data.color = HEX_COLOR_RE.test(rawColor) ? rawColor : DEFAULT_NAME_COLOR;

    joinedRoom = code;
    socket.join(code);

    const state = getRoom(code);
    socket.emit('state', fullState(code));
    socket.emit('chat-history', state.messages);
    broadcastMembers(code);
  });

  socket.on('set-color', (payload) => {
    const color = payload && typeof payload.color === 'string' ? payload.color.trim() : '';
    if (!HEX_COLOR_RE.test(color)) return;
    socket.data.color = color;
    if (joinedRoom) broadcastMembers(joinedRoom);
  });

  socket.on('chat-message', (payload) => {
    if (!joinedRoom) return;
    const text = payload && typeof payload.text === 'string' ? payload.text.trim().slice(0, 500) : '';
    if (!text) return;

    postChatMessage(joinedRoom, socket.data.name, text, socket.data.color);
  });

  // Ephemeral — not stored, not replayed to new joiners. Just a live burst
  // relayed to everyone currently in the room.
  socket.on('reaction', (payload) => {
    if (!joinedRoom) return;
    const emoji = payload && typeof payload.emoji === 'string' ? payload.emoji.slice(0, 8) : '';
    if (!emoji) return;
    socket.to(joinedRoom).emit('reaction', { emoji });
  });

  socket.on('update', (payload) => {
    if (!joinedRoom) return;
    const { videoId, title, time, playing } = payload || {};
    if (typeof time !== 'number' || typeof playing !== 'boolean') return;

    const state = getRoom(joinedRoom);
    if (typeof videoId === 'string' && videoId !== state.videoId) {
      pushHistory(state, state.videoId, state.title);
      state.videoId = videoId;
      state.title = typeof title === 'string' ? title : null;
    } else if (typeof title === 'string') {
      state.title = title;
    }
    state.time = time;
    state.playing = playing;
    state.updatedAt = Date.now();

    socket.to(joinedRoom).emit('state', fullState(joinedRoom));
  });

  socket.on('queue-add', (payload) => {
    if (!joinedRoom) return;
    const { videoId, title } = payload || {};
    if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) return;

    const state = getRoom(joinedRoom);
    if (!state.videoId) {
      state.videoId = videoId;
      state.title = title || null;
      state.time = 0;
      state.playing = true;
      state.updatedAt = Date.now();
    } else {
      state.queue.push({ videoId, title: title || null });
      state.queue = state.queue.slice(0, 25);
    }

    io.to(joinedRoom).emit('state', fullState(joinedRoom));
  });

  socket.on('queue-remove', (payload) => {
    if (!joinedRoom) return;
    const index = payload && payload.index;
    const state = getRoom(joinedRoom);
    if (typeof index !== 'number' || index < 0 || index >= state.queue.length) return;

    state.queue.splice(index, 1);
    io.to(joinedRoom).emit('state', fullState(joinedRoom));
  });

  // Advances to the next queued video. Guarded by the caller's belief of the
  // current videoId so that if several clients detect "ended" or click skip
  // around the same time, only the first one actually advances the queue.
  socket.on('queue-next', (payload) => {
    if (!joinedRoom) return;
    const state = getRoom(joinedRoom);
    if (!payload || payload.videoId !== state.videoId) return;

    pushHistory(state, state.videoId, state.title);
    const next = state.queue.shift();
    if (next) {
      state.videoId = next.videoId;
      state.title = next.title;
      state.time = 0;
      state.playing = true;
    } else {
      state.videoId = null;
      state.title = null;
      state.time = 0;
      state.playing = false;
    }
    state.updatedAt = Date.now();

    io.to(joinedRoom).emit('state', fullState(joinedRoom));
  });

  socket.on('disconnect', () => {
    if (joinedRoom) {
      setImmediate(() => broadcastMembers(joinedRoom));
    }
  });
});
