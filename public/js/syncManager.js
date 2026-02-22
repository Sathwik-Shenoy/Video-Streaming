/**
 * Sync Manager — host-authoritative playback synchronization.
 * Host broadcasts time + play/pause state every 2 seconds.
 * Peers correct drift: hard seek if >500ms, gradual rate adjust if <500ms.
 * Includes latency measurement and toggleable drift debug overlay.
 */

export class SyncManager {
  /**
   * @param {Object} opts
   * @param {boolean} opts.isHost
   * @param {HTMLVideoElement} opts.videoEl
   * @param {Object} opts.signaling
   * @param {string} opts.roomId
   * @param {Object} opts.logger
   * @param {Function} opts.onDriftUpdate - (drift, latency) => void
   * @param {Function} opts.onSyncEvent - (reason, seq) => void
   */
  constructor(opts) {
    this.isHost = opts.isHost;
    this.video = opts.videoEl;
    this.signaling = opts.signaling;
    this.roomId = opts.roomId;
    this.logger = opts.logger;
    this.onDriftUpdate = opts.onDriftUpdate;
    this.onSyncEvent = opts.onSyncEvent;

    // Thresholds
    this.DRIFT_HARD_THRESHOLD = 0.5;   // seconds — hard seek
    this.DRIFT_SOFT_THRESHOLD = 0.05;  // seconds — gradual rate adjust
    this.BROADCAST_INTERVAL = 2000;     // ms
    this.PING_INTERVAL = 3000;          // ms
    this.RATE_ADJUST = 0.03;            // playback rate offset for gradual correction
    this.RATE_RESET_MS = 1200;          // how long to keep adjusted rate

    // State
    this.seq = 0;
    this._broadcastTimer = null;
    this._pingTimer = null;
    this._rateResetTimer = null;
    this._suppressUntil = 0;
    this._lastPingId = 0;
    this._latencyMs = 0;
    this._currentDrift = 0;
    this._seekDebounce = null;
  }

  start() {
    this._bindSignaling();
    this._bindVideoEvents();
    if (this.isHost) this._startBroadcast();
    this._startPing();
  }

  stop() {
    this._stopBroadcast();
    this._stopPing();
    if (this._rateResetTimer) clearTimeout(this._rateResetTimer);
    if (this._seekDebounce) clearTimeout(this._seekDebounce);
  }

  get latency() { return this._latencyMs; }
  get drift() { return this._currentDrift; }

  // ── Suppress Window (prevents feedback loops) ──────────────────────────────
  _suppress(ms = 400) {
    this._suppressUntil = Date.now() + ms;
  }

  _isSuppressed() {
    return Date.now() < this._suppressUntil;
  }

  // ── Signaling Bindings ─────────────────────────────────────────────────────
  _bindSignaling() {
    // Peers receive authoritative state from host
    this.signaling.on('sync:state', (state) => {
      if (this.isHost) return;
      this._applyHostState(state);
    });

    // Host receives action requests from peers
    this.signaling.on('sync:request', ({ action, time }) => {
      if (!this.isHost) return;
      this._handlePeerRequest(action, time);
    });

    // Latency pong
    this.signaling.on('ping:res', ({ id, t0 }) => {
      if (id !== this._lastPingId) return;
      this._latencyMs = Math.round((Date.now() - t0) / 2);
    });
  }

  // ── Video Event Bindings ───────────────────────────────────────────────────
  _bindVideoEvents() {
    this.video.addEventListener('play', () => {
      if (this._isSuppressed()) return;
      if (this.isHost) this.broadcastState('play');
      else this._requestAction('play');
    });

    this.video.addEventListener('pause', () => {
      if (this._isSuppressed()) return;
      if (this.isHost) this.broadcastState('pause');
      else this._requestAction('pause');
    });

    this.video.addEventListener('seeked', () => {
      if (this._isSuppressed()) return;
      if (this.isHost) {
        this.broadcastState('seek');
      } else {
        // Debounce seek requests from peer
        if (this._seekDebounce) clearTimeout(this._seekDebounce);
        this._seekDebounce = setTimeout(() => {
          this._requestAction('seek', this.video.currentTime);
        }, 250);
      }
    });
  }

  // ── Host: Broadcast State ──────────────────────────────────────────────────
  broadcastState(reason = 'tick') {
    if (!this.isHost) return;
    this.seq++;
    const state = {
      seq: this.seq,
      reason,
      paused: this.video.paused,
      time: this.video.currentTime,
      playbackRate: this.video.playbackRate,
      duration: this.video.duration || 0,
      sentAt: Date.now(),
    };
    this.signaling.emit('sync:state', { roomId: this.roomId, state });
    this.onSyncEvent?.(reason, this.seq);
  }

  // ── Peer: Request Action from Host ─────────────────────────────────────────
  _requestAction(action, time) {
    this.signaling.emit('sync:request', {
      roomId: this.roomId,
      action,
      time: time ?? this.video.currentTime,
    });
  }

  /** Peer can call this to request a full state refresh */
  requestStateRefresh() {
    this._requestAction('state');
  }

  // ── Host: Handle Peer Request ──────────────────────────────────────────────
  _handlePeerRequest(action, time) {
    this._suppress();
    try {
      if (action === 'play') this.video.play().catch(() => {});
      else if (action === 'pause') this.video.pause();
      else if (action === 'seek' && time != null) this.video.currentTime = time;
    } catch {}
    this.broadcastState(action);
  }

  // ── Peer: Apply Authoritative Host State ───────────────────────────────────
  async _applyHostState(state) {
    const { time, paused, sentAt } = state;
    const now = Date.now();
    const latencyS = Math.max(0, (now - (sentAt || now)) / 1000);
    const targetTime = paused ? time : time + latencyS;
    const drift = Math.abs(this.video.currentTime - targetTime);

    this._currentDrift = drift;
    this.onDriftUpdate?.(drift, this._latencyMs);

    // Hard seek for large drift
    if (drift > this.DRIFT_HARD_THRESHOLD) {
      this._suppress();
      this.video.currentTime = targetTime;
      this.video.playbackRate = 1.0;
      this.logger?.log(`Drift ${drift.toFixed(2)}s → hard seek to ${targetTime.toFixed(2)}s`);
    }
    // Gradual rate adjustment for small drift
    else if (drift > this.DRIFT_SOFT_THRESHOLD) {
      const behind = this.video.currentTime < targetTime;
      this.video.playbackRate = behind ? 1.0 + this.RATE_ADJUST : 1.0 - this.RATE_ADJUST;
      if (this._rateResetTimer) clearTimeout(this._rateResetTimer);
      this._rateResetTimer = setTimeout(() => {
        this.video.playbackRate = 1.0;
      }, this.RATE_RESET_MS);
    }

    // Align play/pause state
    if (paused && !this.video.paused) {
      this._suppress();
      this.video.pause();
    }
    if (!paused && this.video.paused) {
      this._suppress();
      try { await this.video.play(); } catch {}
    }

    this.onSyncEvent?.(`peer:apply#${state.seq ?? '?'}`, state.seq);
  }

  // ── Periodic Broadcast (Host) ──────────────────────────────────────────────
  _startBroadcast() {
    this._stopBroadcast();
    this._broadcastTimer = setInterval(() => this.broadcastState('tick'), this.BROADCAST_INTERVAL);
  }

  _stopBroadcast() {
    if (this._broadcastTimer) clearInterval(this._broadcastTimer);
    this._broadcastTimer = null;
  }

  // ── Ping/Pong Latency Measurement ─────────────────────────────────────────
  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => this._ping(), this.PING_INTERVAL);
    this._ping();
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  _ping() {
    this._lastPingId++;
    this.signaling.emit('ping:req', {
      roomId: this.roomId,
      id: this._lastPingId,
      t0: Date.now(),
    });
  }
}
