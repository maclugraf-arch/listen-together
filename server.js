const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const YT_API_KEY = process.env.YOUTUBE_API_KEY;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Finds an embeddable replacement for a video whose owner disabled embedding,
// using the official YouTube Data API (search + status.embeddable check) —
// no scraping, no bypassing restrictions, just discovery of an alternate upload.
app.get('/api/replacement/:videoId', async (req, res) => {
  if (!YT_API_KEY) {
    return res.status(501).json({ error: 'no_api_key' });
  }

  const videoId = req.params.videoId;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'bad_video_id' });
  }

  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`
    );
    if (!oembedRes.ok) {
      return res.status(404).json({ error: 'not_found' });
    }
    const info = await oembedRes.json();

    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('key', YT_API_KEY);
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('maxResults', '8');
    searchUrl.searchParams.set('q', info.title);

    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) {
      return res.status(502).json({ error: 'search_failed' });
    }
    const searchData = await searchRes.json();
    const candidateIds = (searchData.items || [])
      .map((it) => it.id && it.id.videoId)
      .filter((id) => id && id !== videoId);

    if (!candidateIds.length) {
      return res.json({ originalTitle: info.title, candidates: [] });
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

    res.json({ originalTitle: info.title, candidates });
  } catch (e) {
    res.status(500).json({ error: 'search_failed' });
  }
});

const httpServer = app.listen(PORT, () => {
  console.log(`Listen-together server running at http://localhost:${PORT}`);
  if (!YT_API_KEY) {
    console.log('YOUTUBE_API_KEY not set — automatic replacement for blocked videos is disabled.');
  }
});

const io = new Server(httpServer);

// In-memory room state. Fine for a small, single-process app.
// rooms: Map<roomCode, { videoId, time, playing, updatedAt, title }>
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      videoId: null,
      time: 0,
      playing: false,
      updatedAt: Date.now(),
      title: null,
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

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join-room', (code) => {
    if (typeof code !== 'string' || !code.trim()) return;
    code = code.trim().toUpperCase();
    joinedRoom = code;
    socket.join(code);

    const state = getRoom(code);
    socket.emit('state', {
      videoId: state.videoId,
      title: state.title,
      time: currentTime(state),
      playing: state.playing,
      members: roomSize(code),
    });

    io.to(code).emit('members', roomSize(code));
  });

  socket.on('update', (payload) => {
    if (!joinedRoom) return;
    const { videoId, title, time, playing } = payload || {};
    if (typeof time !== 'number' || typeof playing !== 'boolean') return;

    const state = getRoom(joinedRoom);
    if (typeof videoId === 'string') state.videoId = videoId;
    if (typeof title === 'string') state.title = title;
    state.time = time;
    state.playing = playing;
    state.updatedAt = Date.now();

    socket.to(joinedRoom).emit('state', {
      videoId: state.videoId,
      title: state.title,
      time: currentTime(state),
      playing: state.playing,
      members: roomSize(joinedRoom),
    });
  });

  socket.on('disconnect', () => {
    if (joinedRoom) {
      setImmediate(() => io.to(joinedRoom).emit('members', roomSize(joinedRoom)));
    }
  });
});
