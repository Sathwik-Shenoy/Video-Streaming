/**
 * Main entry point — initializes the Watch Party application.
 * Detects page type (index vs room) and bootstraps the appropriate modules.
 */

import { WebRTCManager } from './webrtcManager.js';
import { SyncManager } from './syncManager.js';
import { MediaTransport, TransportMode } from './mediaTransport.js';
import { RoomUI } from './roomUI.js';

/* global io */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Signaling Client ────────────────────────────────────────────────────────
class SignalingClient {
  constructor() {
    this.socket = null;
    this._handlers = new Map();
  }

  connect() {
    this.socket = io({ transports: ['websocket', 'polling'] });

    // Forward all events to registered handlers
    const events = [
      'room:info', 'room:user-joined', 'room:user-left', 'room:host-left',
      'signal:offer', 'signal:answer', 'signal:ice',
      'signal:renegotiate', 'signal:restart-ice',
      'chat:message', 'sync:state', 'sync:request',
      'ping:res',
    ];
    for (const evt of events) {
      this.socket.on(evt, (data) => {
        const h = this._handlers.get(evt);
        if (h) h(data);
      });
    }
  }

  on(event, handler) {
    this._handlers.set(event, handler);
  }

  emit(event, payload) {
    this.socket?.emit(event, payload);
  }

  emitAck(event, payload) {
    return new Promise((resolve) => {
      this.socket.emit(event, payload, (resp) => resolve(resp));
    });
  }

  get connected() {
    return this.socket?.connected ?? false;
  }

  get id() {
    return this.socket?.id ?? null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// INDEX PAGE
// ═════════════════════════════════════════════════════════════════════════════
function initIndexPage() {
  const createBtn = document.querySelector('#createRoomBtn');
  const createResult = document.querySelector('#createRoomResult');
  const joinBtn = document.querySelector('#joinRoomBtn');
  const joinInput = document.querySelector('#joinRoomId');
  const joinError = document.querySelector('#joinRoomError');

  createBtn?.addEventListener('click', async () => {
    createBtn.disabled = true;
    try {
      const resp = await fetch('/api/room/new');
      const { roomId } = await resp.json();
      const hostLink = `${location.origin}/room.html?room=${encodeURIComponent(roomId)}&role=host`;
      const peerLink = `${location.origin}/room.html?room=${encodeURIComponent(roomId)}`;
      createResult.innerHTML = `
        <div class="result-item"><strong>Room ID:</strong> ${roomId}</div>
        <div class="result-item"><strong>Host:</strong> <a href="${hostLink}">${hostLink}</a></div>
        <div class="result-item"><strong>Viewers:</strong> <a href="${peerLink}">${peerLink}</a></div>
      `;
    } catch (e) {
      createResult.textContent = `Error: ${e?.message || e}`;
    } finally {
      createBtn.disabled = false;
    }
  });

  joinBtn?.addEventListener('click', () => {
    joinError.textContent = '';
    const roomId = (joinInput.value || '').trim();
    if (!isUuid(roomId)) {
      joinError.textContent = 'Please enter a valid room ID.';
      return;
    }
    location.href = `/room.html?room=${encodeURIComponent(roomId)}`;
  });

  joinInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// ROOM PAGE
// ═════════════════════════════════════════════════════════════════════════════
async function initRoomPage() {
  const url = new URL(location.href);
  const roomId = url.searchParams.get('room');
  const role = url.searchParams.get('role') || 'peer';
  const isHost = role === 'host';

  // ── UI Setup ───────────────────────────────────────────────────────────────
  const ui = new RoomUI({ isHost });
  ui.init();
  const logger = ui.logger;

  if (!isUuid(roomId)) {
    ui.els.roomMeta && (ui.els.roomMeta.textContent = 'Invalid or missing room ID.');
    return;
  }

  ui.setRoomMeta({ roomId });
  ui.showLoading(true);
  if (!isHost) ui.showWaiting(true);

  // ── Signaling ──────────────────────────────────────────────────────────────
  const signaling = new SignalingClient();
  signaling.connect();
  ui.setConnectionState('Connecting…');

  // Wait for socket connection
  while (!signaling.connected) await sleep(50);

  // ── Join Room (with retry for peers waiting on host) ───────────────────────
  let joinResp = await signaling.emitAck('room:join', { roomId, role: isHost ? 'host' : 'peer' });

  if (!joinResp?.ok && !isHost && String(joinResp?.error || '').includes('Waiting for host')) {
    ui.toast('Waiting for host to start the room…', 'info', 5000);
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      joinResp = await signaling.emitAck('room:join', { roomId, role: 'peer' });
      if (joinResp?.ok) break;
    }
  }

  if (!joinResp?.ok) {
    logger.log(`Join failed: ${joinResp?.error || 'unknown'}`, 'error');
    ui.setConnectionState('Failed');
    ui.showLoading(false);
    ui.toast(`Failed to join: ${joinResp?.error || 'Unknown error'}`, 'error', 8000);
    return;
  }

  ui.showLoading(false);
  ui.setConnectionState('Joined');
  logger.log(`Joined room as ${isHost ? 'host' : 'peer'}`);

  const iceConfig = joinResp.iceConfig || { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const existingPeers = joinResp.peers || [];
  const hostId = joinResp.hostId;

  // ── WebRTC Manager ─────────────────────────────────────────────────────────
  const webrtc = new WebRTCManager({
    isHost,
    roomId,
    signaling,
    iceConfig,
    logger,
    onRemoteStream: (peerId, stream) => {
      // Peer receives host's video stream
      if (!isHost) {
        ui.setRemoteStream(stream);
        ui.showWaiting(false);
        ui.toast('Stream connected!', 'success', 3000);
      }
    },
    onPeerConnected: (peerId) => {
      ui.toast('Peer connected', 'success', 2000);
      ui.setConnectionState('Connected');
    },
    onPeerDisconnected: (peerId, reason) => {
      webrtc.removePeer(peerId);
      ui.removeViewer(peerId);
      if (reason === 'ice-failed') {
        ui.toast('Connection failed after retries', 'error', 5000);
      } else {
        ui.toast('Peer disconnected', 'info', 3000);
      }
    },
    onIceStateChange: (peerId, state) => {
      ui.setConnectionState(`ICE: ${state}`);
    },
    onRelayDetected: () => {
      ui.toast('Network relay mode activated (TURN)', 'info', 5000);
    },
  });

  // ── Media Transport ────────────────────────────────────────────────────────
  const transport = new MediaTransport({
    mode: TransportMode.MESH,
    webrtcManager: webrtc,
    logger,
  });

  // ── Sync Manager ───────────────────────────────────────────────────────────
  const sync = new SyncManager({
    isHost,
    videoEl: ui.els.video,
    signaling,
    roomId,
    logger,
    onDriftUpdate: (drift, latency) => {
      ui.setLatency(latency);
      ui.updateDebug({ drift, latency, peers: webrtc.getConnectionCount(), transport: transport.mode });
    },
    onSyncEvent: (reason, seq) => {
      // minimal logging, no spam
    },
  });
  sync.start();

  // Connect to existing peers in the room
  if (existingPeers.length > 0) {
    logger.log(`Connecting to ${existingPeers.length} existing peer(s)…`);
    await transport.connectToExistingPeers(existingPeers);
  }

  // ── Room Events ────────────────────────────────────────────────────────────

  signaling.on('room:info', (info) => {
    if (!info) return;
    ui.setViewerCount(info.peerCount || 0);
    // Update viewer list
    ui.clearViewers();
    if (info.hostId) ui.addViewer(info.hostId, 'host');
    for (const pid of (info.peers || [])) {
      ui.addViewer(pid, 'peer');
    }
  });

  signaling.on('room:user-joined', async ({ id, role: joinedRole }) => {
    logger.log(`User joined: ${id.slice(0, 6)} (${joinedRole})`);
    ui.addViewer(id, joinedRole);
    ui.toast(`${joinedRole === 'host' ? 'Host' : 'A viewer'} joined`, 'info', 2000);

    // Host: establish connection with new peer if we have media ready
    if (isHost && joinedRole === 'peer') {
      await transport.connectToPeer(id);
      if (webrtc.localStream) {
        await webrtc.makeOffer(id);
      }
    }

    // Peer: if host joins after us, connect to them
    if (!isHost && joinedRole === 'host') {
      await transport.connectToPeer(id);
    }
  });

  signaling.on('room:user-left', ({ id }) => {
    logger.log(`User left: ${id.slice(0, 6)}`);
    ui.removeViewer(id);
    transport.removePeer(id);
    ui.toast('A viewer left', 'info', 2000);
  });

  signaling.on('room:host-left', () => {
    logger.log('Host left the room', 'error');
    transport.teardown();
    ui.setConnectionState('Disconnected');
    ui.showWaiting(true);
    ui.toast('Host disconnected. Waiting for reconnection…', 'error', 8000);
  });

  // ── Chat ───────────────────────────────────────────────────────────────────
  signaling.on('chat:message', (msg) => {
    ui.appendChat(msg);
  });

  function sendChat() {
    const text = (ui.els.chatInput?.value || '').trim();
    if (!text) return;
    ui.els.chatInput.value = '';
    const from = isHost ? 'Host' : 'You';
    // Local echo
    ui.appendChat({ from, text, sentAt: Date.now() });
    // Send to others
    signaling.emit('chat:message', { roomId, text, from: isHost ? 'Host' : `Viewer` });
  }

  ui.els.chatSendBtn?.addEventListener('click', sendChat);
  ui.els.chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // ── Host: File Selection + Stream ──────────────────────────────────────────
  let objectUrl = null;

  async function loadHostFile() {
    const file = ui.els.filePicker?.files?.[0];
    if (!file) throw new Error('Please choose a video file first.');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    const v = ui.els.video;
    v.srcObject = null;
    v.src = objectUrl;
    v.muted = true;
    v.load();
    await new Promise((resolve) => {
      if (v.readyState >= 1) return resolve();
      v.addEventListener('loadedmetadata', resolve, { once: true });
    });
    await v.play().catch(() => {});
  }

  async function captureAndPublish() {
    const v = ui.els.video;
    if (v.readyState < 1) {
      await new Promise((resolve) => {
        v.addEventListener('loadedmetadata', resolve, { once: true });
      });
    }
    const stream = v.captureStream?.() || v.mozCaptureStream?.();
    if (!stream) throw new Error('captureStream() not supported in this browser.');
    await transport.publishStream(stream);
    logger.log('Stream published to all peers');
    ui.toast('Streaming started!', 'success', 3000);
  }

  ui.els.startStreamBtn?.addEventListener('click', async () => {
    if (!isHost) return;
    ui.els.startStreamBtn.disabled = true;
    try {
      await loadHostFile();
      await captureAndPublish();
    } catch (e) {
      logger.log(`Start stream failed: ${e.message}`, 'error');
      ui.toast(`Failed: ${e.message}`, 'error', 5000);
    } finally {
      ui.els.startStreamBtn.disabled = false;
    }
  });

  // ── Host: Screen Share ─────────────────────────────────────────────────────
  ui.els.shareScreenBtn?.addEventListener('click', async () => {
    if (!isHost) return;
    ui.els.shareScreenBtn.disabled = true;
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('Screen sharing not supported in this browser.');
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      ui.els.video.muted = true;
      ui.els.video.srcObject = stream;
      await transport.publishStream(stream);
      logger.log('Screen sharing started');
      ui.toast('Screen sharing active!', 'success', 3000);
    } catch (e) {
      logger.log(`Screen share failed: ${e.message}`, 'error');
      ui.toast(`Screen share failed: ${e.message}`, 'error', 5000);
    } finally {
      ui.els.shareScreenBtn.disabled = false;
    }
  });

  // ── Sync Button ────────────────────────────────────────────────────────────
  ui.els.syncBtn?.addEventListener('click', () => {
    if (isHost) {
      sync.broadcastState('manual');
      ui.toast('Sync broadcast sent', 'info', 1500);
    } else {
      sync.requestStateRefresh();
      ui.toast('Sync requested', 'info', 1500);
    }
  });

  // ── Reconnect Button ──────────────────────────────────────────────────────
  ui.els.reconnectBtn?.addEventListener('click', async () => {
    logger.log('Reconnecting…');
    ui.toast('Reconnecting…', 'info', 2000);
    if (isHost) {
      await webrtc.offerToAllPeers({ iceRestart: true });
    } else {
      // Request ICE restart from host
      for (const pid of webrtc.getPeerIds()) {
        signaling.emit('signal:restart-ice', { roomId, targetId: pid });
      }
    }
  });

  // ── Play / Pause ───────────────────────────────────────────────────────────
  ui.els.playBtn?.addEventListener('click', async () => {
    try { await ui.els.video.play(); } catch {}
  });
  ui.els.pauseBtn?.addEventListener('click', () => {
    ui.els.video.pause();
  });

  // ── Copy Room Link ─────────────────────────────────────────────────────────
  ui.els.copyLinkBtn?.addEventListener('click', () => {
    ui.copyRoomLink(roomId);
  });

  // ── Debug Overlay Toggle ───────────────────────────────────────────────────
  ui.els.toggleDebugBtn?.addEventListener('click', () => {
    ui.toggleDebugOverlay();
  });

  // ── Cleanup on unload ──────────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    try { signaling.emit('room:leave'); } catch {}
    try { transport.teardown(); } catch {}
    try { sync.stop(); } catch {}
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═════════════════════════════════════════════════════════════════════════════
const page = document.documentElement?.dataset?.page;
if (page === 'index') initIndexPage();
if (page === 'room') initRoomPage();
