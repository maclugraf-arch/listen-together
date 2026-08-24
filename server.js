const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const httpServer = app.listen(PORT, () => {
  console.log(`Listen-together server running at http://localhost:${PORT}`);
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
