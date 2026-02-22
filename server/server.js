const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { v4: uuidv4, validate: uuidValidate } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// Default to 3000 to match the client links and local testing URLs.
const PORT = process.env.PORT || 3000;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX = 120; // max requests per window per IP
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// In-memory rate limit store: Map<ip, number[] of timestamps>
const ipRequests = new Map();
// Room store: Map<roomId, { hostId: string|null, peerId: string|null, createdAt: number }>
const rooms = new Map();

// For local development of blob: video capture, disable CSP to avoid blocking
// blob: media URLs. In production you should re-enable a stricter CSP that
// explicitly allows blob: for media and the Socket.io WebSocket endpoints.
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(cors());
app.use(express.json());
app.use(rateLimitMiddleware);
app.use(express.static(path.join(__dirname, '../public')));

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = ipRequests.get(ip) || [];
  const filtered = timestamps.filter(ts => ts > windowStart);
  filtered.push(now);
  ipRequests.set(ip, filtered);

  if (filtered.length > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  return next();
}

// Apply a light rate limit to socket connections as well
io.use((socket, next) => {
  const ip = socket.handshake.address || 'unknown';
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = ipRequests.get(ip) || [];
  const filtered = timestamps.filter(ts => ts > windowStart);
  filtered.push(now);
  ipRequests.set(ip, filtered);

  if (filtered.length > RATE_LIMIT_MAX) {
    return next(new Error('Rate limit exceeded'));
  }

  return next();
});

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && uuidValidate(roomId);
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { hostId: null, peerId: null, createdAt: Date.now() });
  }
  return rooms.get(roomId);
}

io.on('connection', socket => {
  let currentRoomId = null;
  let currentRole = null; // 'host' | 'peer'

  socket.on('room:join', ({ roomId, role }, cb = () => {}) => {
    if (!isValidRoomId(roomId)) {
      return cb({ ok: false, error: 'Invalid room id' });
    }
    const room = ensureRoom(roomId);

    if (role === 'host') {
      if (room.hostId && room.hostId !== socket.id) {
        return cb({ ok: false, error: 'Room already has a host' });
      }
      room.hostId = socket.id;
      currentRole = 'host';
    } else {
      if (!room.hostId) {
        return cb({ ok: false, error: 'Waiting for host to join' });
      }
      if (room.peerId && room.peerId !== socket.id) {
        return cb({ ok: false, error: 'Room already has a peer' });
      }
      room.peerId = socket.id;
      currentRole = 'peer';
    }

    currentRoomId = roomId;
    socket.join(roomId);
    cb({ ok: true });
    socket.to(roomId).emit('room:user-joined', { id: socket.id, role: currentRole });
    io.to(roomId).emit('room:info', getPublicRoomState(roomId));
  });

  socket.on('signal:offer', ({ roomId, sdp }) => {
    if (!roomId || !sdp) return;
    const room = getRoom(roomId);
    if (!room || room.hostId !== socket.id) return;
    // Only forward to the single peer (if present)
    if (room.peerId) io.to(room.peerId).emit('signal:offer', { sdp, from: socket.id });
  });

  socket.on('signal:answer', ({ roomId, sdp }) => {
    if (!roomId || !sdp) return;
    const room = getRoom(roomId);
    if (!room || room.hostId === null) return;
    // Only the current peer is allowed to answer
    if (room.peerId !== socket.id) return;
    io.to(room.hostId).emit('signal:answer', { sdp, from: socket.id });
  });

  socket.on('signal:ice', ({ roomId, candidate }) => {
    if (!roomId || !candidate) return;
    const room = getRoom(roomId);
    if (!room) return;
    // Forward only to the other party in a 1:1 room
    if (socket.id === room.hostId && room.peerId) {
      io.to(room.peerId).emit('signal:ice', { candidate, from: socket.id });
    } else if (socket.id === room.peerId && room.hostId) {
      io.to(room.hostId).emit('signal:ice', { candidate, from: socket.id });
    }
  });

  socket.on('signal:renegotiate', ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room) return;
    if (socket.id === room.peerId && room.hostId) {
      // Peer can request host to renegotiate (host stays the offerer)
      io.to(room.hostId).emit('signal:renegotiate', { from: socket.id });
    }
  });

  socket.on('signal:restart-ice', ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room) return;
    if (socket.id === room.peerId && room.hostId) {
      io.to(room.hostId).emit('signal:restart-ice', { from: socket.id });
    }
  });

  socket.on('room:leave', () => {
    leaveRoom(socket, currentRoomId, currentRole);
    currentRoomId = null;
    currentRole = null;
  });

  socket.on('disconnect', () => {
    leaveRoom(socket, currentRoomId, currentRole);
  });
});

function leaveRoom(socket, roomId, role) {
  if (!roomId) return;
  const room = getRoom(roomId);
  if (!room) return;

  socket.leave(roomId);

  if (role === 'host') {
    room.hostId = null;
    // If host leaves, notify peers so they can teardown
    io.to(roomId).emit('room:host-left');
  } else {
    if (room.peerId === socket.id) room.peerId = null;
    socket.to(roomId).emit('room:user-left', { id: socket.id });
  }

  if (!room.hostId && !room.peerId) {
    rooms.delete(roomId);
  } else {
    io.to(roomId).emit('room:info', getPublicRoomState(roomId));
  }
}

function getPublicRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    roomId,
    hostPresent: Boolean(room.hostId),
    peerPresent: Boolean(room.peerId),
    createdAt: room.createdAt
  };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/room/new', (_req, res) => {
  const id = uuidv4();
  res.json({ roomId: id });
});

// Periodic cleanup: avoid unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    const expired = now - room.createdAt > ROOM_TTL_MS;
    const empty = !room.hostId && !room.peerId;
    if (expired || empty) rooms.delete(roomId);
  }
}, 30 * 60 * 1000).unref();

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Signaling server listening on port ${PORT}`);
});