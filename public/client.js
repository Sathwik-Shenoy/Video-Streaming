/* global io */
(() => {
  'use strict';

  const PAGE = document.documentElement?.dataset?.page;
  const GOOGLE_STUN = { urls: 'stun:stun.l.google.com:19302' };
  // TURN placeholder (configure in production):
  // const TURN = { urls: 'turn:turn.yourdomain.com:3478', username: 'user', credential: 'pass' };
  const RTC_CONFIG = {
    iceServers: [GOOGLE_STUN /*, TURN */]
  };

  const DRIFT_THRESHOLD_S = 0.5; // resync when drift > 500ms
  const HOST_STATE_BROADCAST_MS = 2000;
  const SEEK_DEBOUNCE_MS = 250;
  const APPLY_REMOTE_SUPPRESS_MS = 400;
  const PING_INTERVAL_MS = 3000;

  function $(sel) {
    return document.querySelector(sel);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function safeJsonParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function isProbablyUuidV4(s) {
    return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
  }

  function nowMs() {
    return Date.now();
  }

  class Logger {
    constructor(el) {
      this.el = el;
    }
    line(msg, level = 'info') {
      if (!this.el) return;
      const ts = new Date().toLocaleTimeString();
      const div = document.createElement('div');
      div.textContent = `[${ts}] ${msg}`;
      div.className = level === 'error' ? 'muted' : '';
      this.el.appendChild(div);
      this.el.scrollTop = this.el.scrollHeight;
    }
  }

  class SignalingClient {
    constructor(logger) {
      this.logger = logger;
      this.socket = null;
      this.handlers = new Map();
    }

    connect() {
      this.socket = io({
        transports: ['websocket', 'polling']
      });

      this.socket.on('connect', () => this.logger?.line(`Socket connected (${this.socket.id})`));
      this.socket.on('disconnect', reason => this.logger?.line(`Socket disconnected (${reason})`, 'error'));

      const forward = (eventName) => {
        this.socket.on(eventName, payload => {
          const h = this.handlers.get(eventName);
          if (h) h(payload);
        });
      };

      [
        'room:info',
        'room:user-joined',
        'room:user-left',
        'room:host-left',
        'signal:offer',
        'signal:answer',
        'signal:ice',
        'signal:renegotiate',
        'signal:restart-ice'
      ].forEach(forward);
    }

    on(eventName, handler) {
      this.handlers.set(eventName, handler);
    }

    emitAck(eventName, payload) {
      return new Promise((resolve) => {
        this.socket.emit(eventName, payload, (resp) => resolve(resp));
      });
    }

    emit(eventName, payload) {
      this.socket.emit(eventName, payload);
    }
  }

  class DataChannelBus {
    constructor(logger) {
      this.logger = logger;
      this.dc = null;
      this.handlers = new Map();
      this.onOpen = null;
      this.onClose = null;
    }

    bind(dc) {
      this.dc = dc;
      this.dc.binaryType = 'arraybuffer';

      this.dc.onopen = () => {
        this.logger?.line(`DataChannel open (${this.dc.label})`);
        if (this.onOpen) this.onOpen();
      };
      this.dc.onclose = () => {
        this.logger?.line('DataChannel closed', 'error');
        if (this.onClose) this.onClose();
      };
      this.dc.onerror = (e) => {
        this.logger?.line(`DataChannel error: ${e?.message || e}`, 'error');
      };
      this.dc.onmessage = (evt) => {
        const msg = safeJsonParse(evt.data);
        if (!msg || !msg.type) return;
        const h = this.handlers.get(msg.type);
        if (h) h(msg);
      };
    }

    on(type, handler) {
      this.handlers.set(type, handler);
    }

    send(type, data) {
      if (!this.dc || this.dc.readyState !== 'open') return false;
      this.dc.send(JSON.stringify({ type, ...data }));
      return true;
    }
  }

  class PeerConnectionManager {
    constructor({ isHost, roomId, signaling, logger, ui }) {
      this.isHost = isHost;
      this.roomId = roomId;
      this.signaling = signaling;
      this.logger = logger;
      this.ui = ui;

      this.pc = null;
      this.bus = new DataChannelBus(logger);

      this.localStream = null;
      this.remoteStream = null;
      this.makingOffer = false;
      this.polite = !isHost; // peer is polite; host is the offerer
      this.pendingCandidates = [];
    }

    createPeerConnection() {
      if (this.pc) return this.pc;

      const pc = new RTCPeerConnection(RTC_CONFIG);
      this.pc = pc;

      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          this.signaling.emit('signal:ice', { roomId: this.roomId, candidate: evt.candidate });
        }
      };

      pc.oniceconnectionstatechange = () => {
        this.ui?.setConnectionState(`ICE: ${pc.iceConnectionState}`);
        this.logger?.line(`iceConnectionState=${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
          this.logger?.line('ICE failed; requesting ICE restart', 'error');
          if (!this.isHost) this.signaling.emit('signal:restart-ice', { roomId: this.roomId });
          // host will restart on request or can do it manually
        }
      };

      pc.onconnectionstatechange = () => {
        this.ui?.setConnectionState(`PC: ${pc.connectionState}`);
        this.logger?.line(`connectionState=${pc.connectionState}`);
      };

      pc.onsignalingstatechange = () => {
        this.logger?.line(`signalingState=${pc.signalingState}`);
      };

      pc.ontrack = (evt) => {
        if (!this.remoteStream) this.remoteStream = new MediaStream();
        this.remoteStream.addTrack(evt.track);
        this.ui?.setRemoteStream(this.remoteStream);
      };

      if (this.isHost) {
        const dc = pc.createDataChannel('control', { ordered: true });
        this.bus.bind(dc);
      } else {
        pc.ondatachannel = (evt) => {
          this.bus.bind(evt.channel);
        };
      }

      return pc;
    }

    async setLocalStreamFromVideoCapture(videoEl) {
      // Ensure metadata is loaded before capturing; some browsers require this.
      if (videoEl.readyState < 1) {
        await new Promise(resolve => {
          const onMeta = () => {
            videoEl.removeEventListener('loadedmetadata', onMeta);
            resolve();
          };
          videoEl.addEventListener('loadedmetadata', onMeta);
        });
      }

      const stream = videoEl.captureStream?.() || videoEl.mozCaptureStream?.();
      if (!stream) throw new Error('captureStream() not supported in this browser for the selected video element.');
      this.localStream = stream;

      const pc = this.createPeerConnection();
      // Avoid duplicate senders on restarts
      const existing = new Set(pc.getSenders().map(s => s.track).filter(Boolean));
      for (const track of stream.getTracks()) {
        if (!existing.has(track)) pc.addTrack(track, stream);
      }
    }

    async makeOffer({ iceRestart = false } = {}) {
      if (!this.isHost) return;
      const pc = this.createPeerConnection();

      this.makingOffer = true;
      try {
        const offer = await pc.createOffer({ iceRestart });
        await pc.setLocalDescription(offer);
        this.signaling.emit('signal:offer', { roomId: this.roomId, sdp: pc.localDescription });
        this.logger?.line(`Sent offer${iceRestart ? ' (ICE restart)' : ''}`);
      } finally {
        this.makingOffer = false;
      }
    }

    async handleOffer({ sdp }) {
      const pc = this.createPeerConnection();

      const offerCollision = this.makingOffer || pc.signalingState !== 'stable';
      const ignoreOffer = !this.polite && offerCollision;
      if (ignoreOffer) {
        this.logger?.line('Ignored offer due to collision (impolite side)');
        return;
      }

      await pc.setRemoteDescription(sdp);
      this.logger?.line('Applied remote offer');
      await this._flushPendingCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.emit('signal:answer', { roomId: this.roomId, sdp: pc.localDescription });
      this.logger?.line('Sent answer');
    }

    async handleAnswer({ sdp }) {
      const pc = this.createPeerConnection();
      await pc.setRemoteDescription(sdp);
      this.logger?.line('Applied remote answer');
      await this._flushPendingCandidates();
    }

    async handleIce({ candidate }) {
      const pc = this.createPeerConnection();
      if (!pc.remoteDescription) {
        this.pendingCandidates.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        this.logger?.line(`addIceCandidate failed: ${e?.message || e}`, 'error');
      }
    }

    async _flushPendingCandidates() {
      const pc = this.createPeerConnection();
      if (!pc.remoteDescription) return;
      const toAdd = this.pendingCandidates.splice(0, this.pendingCandidates.length);
      for (const c of toAdd) {
        try {
          await pc.addIceCandidate(c);
        } catch (e) {
          this.logger?.line(`addIceCandidate(pending) failed: ${e?.message || e}`, 'error');
        }
      }
    }

    teardown() {
      try {
        this.bus.dc?.close?.();
      } catch {}
      try {
        this.pc?.close?.();
      } catch {}
      this.pc = null;
      this.remoteStream = null;
      this.pendingCandidates = [];
    }
  }

  class SyncController {
    constructor({ isHost, videoEl, bus, logger, ui }) {
      this.isHost = isHost;
      this.video = videoEl;
      this.bus = bus;
      this.logger = logger;
      this.ui = ui;

      this.applyRemoteUntil = 0;
      this.seq = 0; // host-authoritative sequence
      this.hostTicker = null;
      this.pingTicker = null;
      this.lastPingAt = 0;
      this.lastPingId = 0;

      this._debouncedRequestSeek = debounce((time) => {
        this.requestSeek(time);
      }, SEEK_DEBOUNCE_MS);
    }

    start() {
      this._wireVideoEvents();
      this._wireBus();
    }

    setSuppressWindow() {
      this.applyRemoteUntil = nowMs() + APPLY_REMOTE_SUPPRESS_MS;
    }

    isSuppressed() {
      return nowMs() < this.applyRemoteUntil;
    }

    _wireVideoEvents() {
      // Note: both sides can initiate controls, but HOST is authoritative.
      this.video.addEventListener('play', () => {
        if (this.isSuppressed()) return;
        if (this.isHost) this.broadcastState('play');
        else this.requestPlay();
      });

      this.video.addEventListener('pause', () => {
        if (this.isSuppressed()) return;
        if (this.isHost) this.broadcastState('pause');
        else this.requestPause();
      });

      this.video.addEventListener('seeked', () => {
        if (this.isSuppressed()) return;
        const t = this.video.currentTime;
        if (this.isHost) this.broadcastState('seek', { time: t });
        else this._debouncedRequestSeek(t);
      });
    }

    _wireBus() {
      this.bus.onOpen = () => {
        // Host periodically broadcasts authoritative state for drift correction.
        if (this.isHost) {
          this._startHostBroadcast();
        }
        this._startPing();
      };

      this.bus.onClose = () => {
        this._stopHostBroadcast();
        this._stopPing();
      };

      // Peer -> host control requests
      this.bus.on('req', (msg) => {
        if (!this.isHost) return;
        const { action, time } = msg;
        if (action === 'play') this._applyAndBroadcastFromRequest(() => this.video.play(), 'play');
        if (action === 'pause') this._applyAndBroadcastFromRequest(() => this.video.pause(), 'pause');
        if (action === 'seek') this._applyAndBroadcastFromRequest(() => { this.video.currentTime = time ?? this.video.currentTime; }, 'seek', { time });
        if (action === 'state') this.broadcastState('state');
      });

      // Host -> peer authoritative state
      this.bus.on('state', (msg) => {
        if (this.isHost) return;
        this._applyAuthoritativeState(msg);
      });

      // Chat
      this.bus.on('chat', (msg) => {
        this.ui?.appendChat(msg);
      });

      // Latency ping/pong
      this.bus.on('ping', (msg) => {
        this.bus.send('pong', { id: msg.id, t0: msg.t0, t1: nowMs() });
      });
      this.bus.on('pong', (msg) => {
        if (msg.id !== this.lastPingId) return;
        const tNow = nowMs();
        const rtt = tNow - (msg.t0 || tNow);
        this.ui?.setLatency(Math.round(rtt));
      });
    }

    _startHostBroadcast() {
      this._stopHostBroadcast();
      this.hostTicker = setInterval(() => this.broadcastState('tick'), HOST_STATE_BROADCAST_MS);
    }

    _stopHostBroadcast() {
      if (this.hostTicker) clearInterval(this.hostTicker);
      this.hostTicker = null;
    }

    _startPing() {
      this._stopPing();
      this.pingTicker = setInterval(() => this.ping(), PING_INTERVAL_MS);
      // initial ping
      this.ping();
    }

    _stopPing() {
      if (this.pingTicker) clearInterval(this.pingTicker);
      this.pingTicker = null;
    }

    ping() {
      if (!this.bus.dc || this.bus.dc.readyState !== 'open') return;
      this.lastPingId += 1;
      this.lastPingAt = nowMs();
      this.bus.send('ping', { id: this.lastPingId, t0: this.lastPingAt });
    }

    sendChat(text, from) {
      const msg = { from, text, sentAt: nowMs() };
      // local echo + remote send
      this.ui?.appendChat(msg);
      this.bus.send('chat', msg);
    }

    requestPlay() {
      this.bus.send('req', { action: 'play', sentAt: nowMs() });
    }
    requestPause() {
      this.bus.send('req', { action: 'pause', sentAt: nowMs() });
    }
    requestSeek(time) {
      this.bus.send('req', { action: 'seek', time, sentAt: nowMs() });
    }
    requestState() {
      this.bus.send('req', { action: 'state', sentAt: nowMs() });
    }

    async _applyAndBroadcastFromRequest(applyFn, reason, extra = {}) {
      try {
        this.setSuppressWindow();
        await applyFn();
      } catch {
        // play() can reject due to autoplay policy; state broadcast still helps resync after user gesture.
      } finally {
        this.broadcastState(reason, extra);
      }
    }

    broadcastState(reason, extra = {}) {
      if (!this.isHost) return;
      this.seq += 1;
      const base = {
        seq: this.seq,
        reason,
        paused: this.video.paused,
        time: this.video.currentTime,
        playbackRate: this.video.playbackRate,
        sentAt: nowMs()
      };
      this.bus.send('state', { ...base, ...extra });
      this.ui?.setLastSync(`host:${reason}#${this.seq}`);
    }

    async _applyAuthoritativeState(state) {
      const { time, paused, sentAt } = state;
      const now = nowMs();
      const latencyS = Math.max(0, (now - (sentAt || now)) / 1000);
      const targetTime = paused ? time : (time + latencyS);
      const drift = Math.abs(this.video.currentTime - targetTime);

      if (drift > DRIFT_THRESHOLD_S) {
        this.setSuppressWindow();
        this.video.currentTime = targetTime;
        this.logger?.line(`Drift ${drift.toFixed(2)}s -> resync to ${targetTime.toFixed(2)}s`);
      }

      // Keep play/pause aligned
      if (paused && !this.video.paused) {
        this.setSuppressWindow();
        this.video.pause();
      }
      if (!paused && this.video.paused) {
        this.setSuppressWindow();
        try {
          await this.video.play();
        } catch {
          // user gesture might be required; state will keep updating
        }
      }

      this.ui?.setLastSync(`peer:apply#${state.seq ?? '?'}`);
    }
  }

  class RoomUI {
    constructor({ isHost }) {
      this.isHost = isHost;
      this.connectionState = $('#connectionState');
      this.peerState = $('#peerState');
      this.roomMeta = $('#roomMeta');
      this.roleLabel = $('#roleLabel');
      this.roomLabel = $('#roomLabel');
      this.video = $('#video');
      this.filePicker = $('#filePicker');
      this.startStreamBtn = $('#startStreamBtn');
      this.shareScreenBtn = $('#shareScreenBtn');
      this.syncBtn = $('#syncBtn');
      this.renegotiateBtn = $('#renegotiateBtn');
      this.playBtn = $('#playBtn');
      this.pauseBtn = $('#pauseBtn');
      this.latency = $('#latency');
      this.recordBtn = $('#recordBtn');
      this.logEl = $('#log');
      this.chatEl = $('#chat');
      this.chatInput = $('#chatInput');
      this.chatSendBtn = $('#chatSendBtn');
      this.lastSyncLabel = null;

      this.logger = new Logger(this.logEl);
      this.recorder = null;
      this.recordedBlobs = [];

      // Set conservative defaults to play nicely with autoplay policies.
      if (this.video) {
        this.video.playsInline = true;
        if (this.isHost) {
          // Host preview is muted; audio is conceptually "owned" by the peer.
          this.video.muted = true;
        }
      }
    }

    initMeta({ roomId }) {
      if (this.roleLabel) this.roleLabel.textContent = this.isHost ? 'Host' : 'Peer';
      if (this.roomLabel) this.roomLabel.textContent = roomId;

      if (this.isHost) {
        const hostLink = `${location.origin}/room.html?room=${encodeURIComponent(roomId)}&role=host`;
        const peerLink = `${location.origin}/room.html?room=${encodeURIComponent(roomId)}&role=peer`;
        this.roomMeta.innerHTML = `Room ready. Host link: <a href="${hostLink}">${hostLink}</a><br/>Share with peer: <a href="${peerLink}">${peerLink}</a>`;
      } else {
        this.roomMeta.textContent = `Joined room. Waiting for host stream…`;
      }
    }

    setConnectionState(text) {
      if (!this.connectionState) return;
      this.connectionState.textContent = text;
    }

    setPeerPresent(present) {
      if (!this.peerState) return;
      this.peerState.textContent = present ? 'Peer connected' : 'No peer';
      this.peerState.classList.toggle('muted', !present);
    }

    setRemoteStream(stream) {
      if (!this.video) return;
      if (this.video.srcObject !== stream) {
        this.video.srcObject = stream;
        // Help ensure playback starts even under stricter autoplay rules.
        // Start muted; the user can unmute via native controls.
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.autoplay = true;
        this.video
          .play()
          .catch(() => {
            // If autoplay is still blocked, the explicit Play button will succeed after user gesture.
          });
      }
    }

    setLatency(ms) {
      if (this.latency) this.latency.textContent = String(ms);
    }

    setLastSync(text) {
      // Lightweight: log it (keeps UI minimal)
      this.logger?.line(`sync=${text}`);
    }

    appendChat({ from, text, sentAt }) {
      if (!this.chatEl) return;
      const ts = sentAt ? new Date(sentAt).toLocaleTimeString() : new Date().toLocaleTimeString();
      const div = document.createElement('div');
      div.textContent = `[${ts}] ${from || 'peer'}: ${text}`;
      this.chatEl.appendChild(div);
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
    }

    async toggleRecording(stream) {
      if (!stream) {
        this.logger?.line('No stream available for recording', 'error');
        return;
      }
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
        return;
      }

      this.recordedBlobs = [];
      const options = { mimeType: 'video/webm;codecs=vp8,opus' };
      let recorder;
      try {
        recorder = new MediaRecorder(stream, options);
      } catch {
        recorder = new MediaRecorder(stream);
      }

      this.recorder = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.recordedBlobs.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(this.recordedBlobs, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `p2p-watch-party-${Date.now()}.webm`;
        a.textContent = 'Download recording';
        this.logger?.line('Recording stopped; download link added.');
        const wrap = document.createElement('div');
        wrap.appendChild(a);
        this.logEl?.appendChild(wrap);
      };

      recorder.start(1000);
      this.logger?.line('Recording started');
    }
  }

  async function initIndexPage() {
    const createRoomBtn = $('#createRoomBtn');
    const createRoomResult = $('#createRoomResult');
    const joinRoomBtn = $('#joinRoomBtn');
    const joinRoomId = $('#joinRoomId');
    const joinRoomError = $('#joinRoomError');

    createRoomBtn.addEventListener('click', async () => {
      createRoomBtn.disabled = true;
      try {
        const resp = await fetch('/api/room/new');
        const data = await resp.json();
        const roomId = data.roomId;
        const hostLink = `${location.origin}/room.html?room=${encodeURIComponent(roomId)}&role=host`;
        const peerLink = `${location.origin}/room.html?room=${encodeURIComponent(roomId)}`;

        createRoomResult.innerHTML = `
          <div><strong>Room ID:</strong> ${roomId}</div>
          <div><strong>Host link:</strong> <a href="${hostLink}">${hostLink}</a></div>
          <div><strong>Peer link:</strong> <a href="${peerLink}">${peerLink}</a></div>
        `;
      } catch (e) {
        createRoomResult.textContent = `Error: ${e?.message || e}`;
      } finally {
        createRoomBtn.disabled = false;
      }
    });

    joinRoomBtn.addEventListener('click', () => {
      joinRoomError.textContent = '';
      const roomId = (joinRoomId.value || '').trim();
      if (!isProbablyUuidV4(roomId)) {
        joinRoomError.textContent = 'Please enter a valid UUID v4 room id.';
        return;
      }
      location.href = `/room.html?room=${encodeURIComponent(roomId)}`;
    });
  }

  async function initRoomPage() {
    const url = new URL(location.href);
    const roomId = url.searchParams.get('room');
    const role = url.searchParams.get('role') || 'peer';
    const isHost = role === 'host';

    const ui = new RoomUI({ isHost });
    const logger = ui.logger;

    if (!isProbablyUuidV4(roomId)) {
      ui.roomMeta.textContent = 'Invalid or missing room id.';
      return;
    }
    ui.initMeta({ roomId });

    // Role-based UI: peers shouldn't see host-only controls
    if (!isHost) {
      if (ui.filePicker) ui.filePicker.disabled = true;
      if (ui.startStreamBtn) ui.startStreamBtn.disabled = true;
      if (ui.shareScreenBtn) ui.shareScreenBtn.disabled = true;
    }

    const signaling = new SignalingClient(logger);
    signaling.connect();

    ui.setConnectionState('Connecting…');

    const pcm = new PeerConnectionManager({ isHost, roomId, signaling, logger, ui });
    pcm.createPeerConnection();

    const sync = new SyncController({ isHost, videoEl: ui.video, bus: pcm.bus, logger, ui });
    sync.start();

    signaling.on('room:info', (info) => {
      if (!info) return;
      ui.setPeerPresent(Boolean(info.peerPresent));
    });

    signaling.on('room:host-left', () => {
      logger.line('Host left the room. Connection torn down.', 'error');
      pcm.teardown();
      ui.setPeerPresent(false);
      ui.setConnectionState('Disconnected');
    });

    signaling.on('signal:offer', async ({ sdp }) => {
      try {
        await pcm.handleOffer({ sdp });
      } catch (e) {
        logger.line(`Offer handling failed: ${e?.message || e}`, 'error');
      }
    });

    signaling.on('signal:answer', async ({ sdp }) => {
      try {
        await pcm.handleAnswer({ sdp });
      } catch (e) {
        logger.line(`Answer handling failed: ${e?.message || e}`, 'error');
      }
    });

    signaling.on('signal:ice', async ({ candidate }) => {
      await pcm.handleIce({ candidate });
    });

    signaling.on('signal:renegotiate', async () => {
      if (!isHost) return;
      logger.line('Peer requested renegotiation');
      await pcm.makeOffer({ iceRestart: false });
    });

    signaling.on('signal:restart-ice', async () => {
      if (!isHost) return;
      logger.line('Peer requested ICE restart');
      await pcm.makeOffer({ iceRestart: true });
    });

    // Join room
    // Host becomes authoritative offerer; peer is polite answerer.
    while (!signaling.socket?.connected) await sleep(50);
    let joinResp = await signaling.emitAck('room:join', { roomId, role: isHost ? 'host' : 'peer' });
    if (!joinResp?.ok && !isHost && String(joinResp?.error || '').includes('Waiting for host')) {
      ui.roomMeta.textContent = 'Waiting for host to join… (this will auto-retry)';
      for (let i = 0; i < 60; i += 1) {
        await sleep(1000);
        joinResp = await signaling.emitAck('room:join', { roomId, role: 'peer' });
        if (joinResp?.ok) break;
      }
    }
    if (!joinResp?.ok) {
      logger.line(`Join failed: ${joinResp?.error || 'unknown error'}`, 'error');
      ui.roomMeta.textContent = `Join failed: ${joinResp?.error || 'unknown error'}`;
      return;
    }
    ui.setConnectionState('Joined; waiting for WebRTC…');

    // Host flow: file selection + captureStream + offer
    let objectUrl = null;
    async function ensureHostFileLoaded() {
      const f = ui.filePicker?.files?.[0];
      if (!f) throw new Error('Please choose a local video file first.');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(f);
      ui.video.srcObject = null;
      ui.video.src = objectUrl;
      ui.video.muted = true; // avoid echo locally; media is sent via captureStream anyway
      // Explicitly load and wait for metadata so captureStream has tracks.
      ui.video.load();
      await new Promise(resolve => {
        if (ui.video.readyState >= 1) return resolve();
        const onMeta = () => {
          ui.video.removeEventListener('loadedmetadata', onMeta);
          resolve();
        };
        ui.video.addEventListener('loadedmetadata', onMeta);
      });
      // Start playing (muted) so the host sees the preview and captureStream has frames.
      await ui.video.play().catch(() => {});
    }

    async function ensureOfferIfReady(reason) {
      if (!isHost) return;
      // Make an offer only when we have media (or screen) tracks and a peer is present.
      // Room info updates are handled separately, but this is a safe utility.
      const pc = pcm.pc;
      const hasSenders = Boolean(pc && pc.getSenders().some(s => s.track));
      if (!hasSenders) return;
      logger.line(`Negotiating (${reason})…`);
      await pcm.makeOffer();
    }

    ui.startStreamBtn?.addEventListener('click', async () => {
      if (!isHost) return;
      ui.startStreamBtn.disabled = true;
      try {
        await ensureHostFileLoaded();
        await pcm.setLocalStreamFromVideoCapture(ui.video);
        // Offer may be delayed until peer joins (1:1 room)
        await ensureOfferIfReady('file');
        logger.line('Streaming ready (file captured)');
      } catch (e) {
        logger.line(`Start streaming failed: ${e?.message || e}`, 'error');
      } finally {
        ui.startStreamBtn.disabled = false;
      }
    });

    ui.shareScreenBtn?.addEventListener('click', async () => {
      if (!isHost) return;
      ui.shareScreenBtn.disabled = true;
      try {
        if (!navigator.mediaDevices?.getDisplayMedia) {
          throw new Error('getDisplayMedia() not supported in this browser.');
        }
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        pcm.localStream = stream;
        const pc = pcm.createPeerConnection();
        const existing = new Set(pc.getSenders().map(s => s.track).filter(Boolean));
        for (const track of stream.getTracks()) {
          if (!existing.has(track)) pc.addTrack(track, stream);
        }
        // Optional local preview of screen stream (muted)
        ui.video.muted = true;
        ui.video.srcObject = stream;
        await ensureOfferIfReady('screen');
        logger.line('Screen sharing ready');
      } catch (e) {
        logger.line(`Screen share failed: ${e?.message || e}`, 'error');
      } finally {
        ui.shareScreenBtn.disabled = false;
      }
    });

    ui.syncBtn?.addEventListener('click', () => {
      if (isHost) sync.broadcastState('manual');
      else sync.requestState();
    });

    ui.renegotiateBtn?.addEventListener('click', async () => {
      logger.line('Reconnecting…');
      // Peer requests host to restart ICE; host can also force a restart offer.
      if (isHost) await pcm.makeOffer({ iceRestart: true });
      else signaling.emit('signal:restart-ice', { roomId });
    });

    ui.playBtn?.addEventListener('click', async () => {
      try {
        await ui.video.play();
      } catch {}
    });
    ui.pauseBtn?.addEventListener('click', () => ui.video.pause());

    ui.recordBtn?.addEventListener('click', async () => {
      const stream = isHost ? pcm.localStream : pcm.remoteStream;
      await ui.toggleRecording(stream);
    });

    ui.chatSendBtn?.addEventListener('click', () => {
      const text = (ui.chatInput.value || '').trim();
      if (!text) return;
      ui.chatInput.value = '';
      sync.sendChat(text, isHost ? 'host' : 'peer');
    });
    ui.chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ui.chatSendBtn.click();
    });

    // When a peer connects/reconnects, host should renegotiate if it already has media.
    signaling.on('room:user-joined', async ({ role: joinedRole }) => {
      if (!isHost) return;
      if (joinedRole !== 'peer') return;
      await ensureOfferIfReady('peer-joined');
    });

    signaling.on('room:user-left', async () => {
      // Keep host running; peer may rejoin later
      if (!isHost) {
        logger.line('Peer disconnected. Waiting…', 'error');
      } else {
        logger.line('Peer left. Waiting for reconnection…');
      }
    });

    window.addEventListener('beforeunload', () => {
      try {
        signaling.emit('room:leave');
      } catch {}
      try {
        pcm.teardown();
      } catch {}
      try {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      } catch {}
    });
  }

  if (PAGE === 'index') initIndexPage();
  if (PAGE === 'room') initRoomPage();
})();

