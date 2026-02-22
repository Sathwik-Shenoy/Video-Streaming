/**
 * Watch Party Signaling Server
 * Supports multi-user rooms (mesh topology), HTTPS, TURN, and production deployment.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const https = require('https');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { v4: uuidv4, validate: uuidValidate } = require('uuid');
const { RoomManager } = require('./roomManager');
const { RateLimiter } = require('./rateLimiter');

// ─── Configuration ───────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const USE_HTTPS = process.env.USE_HTTPS === 'true';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.join(__dirname, '../certs/cert.pem');
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(__dirname, '../certs/key.pem');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// TURN configuration (from environment — never hardcoded)
const TURN_URL = process.env.TURN_URL || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_PASSWORD = process.env.TURN_PASSWORD || '';

const isProd = NODE_ENV === 'production';

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();

// ─── Server (HTTP or HTTPS) ──────────────────────────────────────────────────
let server;
if (USE_HTTPS) {
  try {
    const sslOpts = {
      cert: fs.readFileSync(SSL_CERT_PATH),
      key: fs.readFileSync(SSL_KEY_PATH),
    };
    server = https.createServer(sslOpts, app);
    if (!isProd) console.log('[server] HTTPS enabled');
  } catch (err) {
    console.warn('[server] SSL certs not found, falling back to HTTP:', err.message);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

// ─── Socket.io ───────────────────────────────────────────────────────────────
const corsOrigin = ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN.split(',').map(s => s.trim());
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// ─── Instances ───────────────────────────────────────────────────────────────
const roomManager = new RoomManager();
const rateLimiter = new RateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX, 10) || 120,
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use(rateLimiter.expressMiddleware());
app.use(express.static(path.join(__dirname, '../public')));
io.use(rateLimiter.socketMiddleware());

// ─── Utility ─────────────────────────────────────────────────────────────────
function isValidRoomId(roomId) {
  return typeof roomId === 'string' && uuidValidate(roomId);
}

/** Build ICE server list from environment */
function getIceConfig() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (TURN_URL) {
    // Support comma-separated TURN URLs (multiple transports)
    const turnUrls = TURN_URL.split(',').map(u => u.trim()).filter(Boolean);
    for (const url of turnUrls) {
      iceServers.push({
        urls: url,
        username: TURN_USERNAME,
        credential: TURN_PASSWORD,
      });
    }
  }
  return { iceServers };
}

// ─── API Routes ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: roomManager.getRoomCount(),
    env: NODE_ENV,
  });
});

app.get('/api/room/new', (_req, res) => {
  res.json({ roomId: uuidv4() });
});

app.get('/api/ice-config', (_req, res) => {
  res.json(getIceConfig());
});

// ─── Socket.io Connection Handling ───────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentRole = null; // 'host' | 'peer'

  // ── Join Room ──────────────────────────────────────────────────────────────
  socket.on('room:join', ({ roomId, role }, cb = () => {}) => {
    if (!isValidRoomId(roomId)) {
      return cb({ ok: false, error: 'Invalid room ID' });
    }

    const room = roomManager.ensureRoom(roomId);
    let result;

    if (role === 'host') {
      result = room.addHost(socket.id);
      if (result.ok) currentRole = 'host';
    } else {
      result = room.addPeer(socket.id);
      if (result.ok) currentRole = 'peer';
    }

    if (!result.ok) return cb(result);

    currentRoomId = roomId;
    socket.join(roomId);

    // Return the list of existing members so the new joiner can establish connections
    const existingMembers = room.getAllMemberIds().filter(id => id !== socket.id);

    cb({
      ok: true,
      iceConfig: getIceConfig(),
      peers: existingMembers,
      isHost: currentRole === 'host',
      hostId: room.hostId,
    });

    // Notify existing members about the new joiner
    socket.to(roomId).emit('room:user-joined', { id: socket.id, role: currentRole });

    // Broadcast updated room info to everyone
    io.to(roomId).emit('room:info', room.getPublicState());
  });

  // ── Targeted Signaling: Offer ──────────────────────────────────────────────
  socket.on('signal:offer', ({ roomId, targetId, sdp }) => {
    if (!roomId || !targetId || !sdp) return;
    const room = roomManager.getRoom(roomId);
    if (!room || !room.hasMember(socket.id)) return;
    io.to(targetId).emit('signal:offer', { sdp, from: socket.id });
  });

  // ── Targeted Signaling: Answer ─────────────────────────────────────────────
  socket.on('signal:answer', ({ roomId, targetId, sdp }) => {
    if (!roomId || !targetId || !sdp) return;
    const room = roomManager.getRoom(roomId);
    if (!room || !room.hasMember(socket.id)) return;
    io.to(targetId).emit('signal:answer', { sdp, from: socket.id });
  });

  // ── Targeted Signaling: ICE Candidate ──────────────────────────────────────
  socket.on('signal:ice', ({ roomId, targetId, candidate }) => {
    if (!roomId || !targetId || !candidate) return;
    const room = roomManager.getRoom(roomId);
    if (!room || !room.hasMember(socket.id)) return;
    io.to(targetId).emit('signal:ice', { candidate, from: socket.id });
  });

  // ── Renegotiation Request ──────────────────────────────────────────────────
  socket.on('signal:renegotiate', ({ roomId, targetId }) => {
    if (!roomId || !targetId) return;
    const room = roomManager.getRoom(roomId);
    if (!room || !room.hasMember(socket.id)) return;
    io.to(targetId).emit('signal:renegotiate', { from: socket.id });
  });

  // ── ICE Restart Request ────────────────────────────────────────────────────
  socket.on('signal:restart-ice', ({ roomId, targetId }) => {
    if (!roomId || !targetId) return;
    const room = roomManager.getRoom(roomId);
    if (!room || !room.hasMember(socket.id)) return;
    io.to(targetId).emit('signal:restart-ice', { from: socket.id });
  });

  // ── Chat: relayed via signaling for multi-peer simplicity ──────────────────
  socket.on('chat:message', ({ roomId, text, from }) => {
    if (!roomId || !text) return;
    const room = roomManager.getRoom(roomId);
    if (!room || !room.hasMember(socket.id)) return;
    socket.to(roomId).emit('chat:message', {
      from: from || 'anonymous',
      text,
      sentAt: Date.now(),
      senderId: socket.id,
    });
  });

  // ── Sync: Host broadcasts authoritative state ──────────────────────────────
  socket.on('sync:state', ({ roomId, state }) => {
    if (!roomId || !state) return;
    const room = roomManager.getRoom(roomId);
    if (!room || room.hostId !== socket.id) return;
    socket.to(roomId).emit('sync:state', state);
  });

  // ── Sync: Peer requests action from host ───────────────────────────────────
  socket.on('sync:request', ({ roomId, action, time }) => {
    if (!roomId) return;
    const room = roomManager.getRoom(roomId);
    if (!room || !room.hostId) return;
    io.to(room.hostId).emit('sync:request', { from: socket.id, action, time });
  });

  // ── Latency Ping ──────────────────────────────────────────────────────────
  socket.on('ping:req', ({ id, t0 }) => {
    socket.emit('ping:res', { id, t0, t1: Date.now() });
  });

  // ── Leave Room ─────────────────────────────────────────────────────────────
  socket.on('room:leave', () => {
    handleLeave(socket, currentRoomId, currentRole);
    currentRoomId = null;
    currentRole = null;
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    handleLeave(socket, currentRoomId, currentRole);
  });
});

function handleLeave(socket, roomId, role) {
  if (!roomId) return;
  const room = roomManager.getRoom(roomId);
  if (!room) return;

  socket.leave(roomId);

  if (role === 'host') {
    room.removeHost();
    io.to(roomId).emit('room:host-left');
  } else {
    room.removePeer(socket.id);
    socket.to(roomId).emit('room:user-left', { id: socket.id });
  }

  if (room.isEmpty) {
    roomManager.deleteRoom(roomId);
  } else {
    io.to(roomId).emit('room:info', room.getPublicState());
  }
}

// ─── Start Server ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const proto = USE_HTTPS ? 'https' : 'http';
  console.log(`[server] ${proto}://localhost:${PORT} (${NODE_ENV})`);
});