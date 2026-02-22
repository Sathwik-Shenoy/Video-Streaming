/**
 * WebRTC Manager — handles multi-peer connections (mesh topology).
 * Host maintains a connection to each peer; peers connect to the host.
 * Media flows from host to peers; signaling is targeted per-peer.
 */

export class WebRTCManager {
  /**
   * @param {Object} opts
   * @param {boolean} opts.isHost
   * @param {string} opts.roomId
   * @param {Object} opts.signaling - SignalingClient instance
   * @param {Object} opts.iceConfig - { iceServers: [...] }
   * @param {Function} opts.onRemoteStream - (peerId, MediaStream) => void
   * @param {Function} opts.onPeerConnected - (peerId) => void
   * @param {Function} opts.onPeerDisconnected - (peerId, reason) => void
   * @param {Function} opts.onIceStateChange - (peerId, state) => void
   * @param {Function} opts.onRelayDetected - () => void
   * @param {Object} opts.logger
   */
  constructor(opts) {
    this.isHost = opts.isHost;
    this.roomId = opts.roomId;
    this.signaling = opts.signaling;
    this.iceConfig = opts.iceConfig || { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    this.logger = opts.logger;

    // Callbacks
    this.onRemoteStream = opts.onRemoteStream;
    this.onPeerConnected = opts.onPeerConnected;
    this.onPeerDisconnected = opts.onPeerDisconnected;
    this.onIceStateChange = opts.onIceStateChange;
    this.onRelayDetected = opts.onRelayDetected;

    /** @type {Map<string, RTCPeerConnection>} */
    this.peerConnections = new Map();

    /** @type {Map<string, { makingOffer: boolean, pendingCandidates: RTCIceCandidate[], polite: boolean }>} */
    this.peerState = new Map();

    /** @type {MediaStream|null} Shared local stream (host only, created once) */
    this.localStream = null;

    /** @type {Map<string, number>} Retry counters per peer */
    this.retryCount = new Map();
    this.maxRetries = 3;

    this._bindSignaling();
  }

  // ── Signaling Events ───────────────────────────────────────────────────────
  _bindSignaling() {
    this.signaling.on('signal:offer', (data) => this._handleOffer(data.from, data.sdp));
    this.signaling.on('signal:answer', (data) => this._handleAnswer(data.from, data.sdp));
    this.signaling.on('signal:ice', (data) => this._handleIce(data.from, data.candidate));
    this.signaling.on('signal:renegotiate', (data) => this._handleRenegotiate(data.from));
    this.signaling.on('signal:restart-ice', (data) => this._handleRestartIce(data.from));
  }

  // ── Peer Connection Management ─────────────────────────────────────────────
  _ensurePeerConnection(peerId) {
    if (this.peerConnections.has(peerId)) {
      return this.peerConnections.get(peerId);
    }

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(peerId, pc);
    this.peerState.set(peerId, {
      makingOffer: false,
      pendingCandidates: [],
      polite: !this.isHost,
    });

    // Add local stream tracks if host already has media loaded
    if (this.isHost && this.localStream) {
      const existingTracks = new Set(pc.getSenders().map(s => s.track).filter(Boolean));
      for (const track of this.localStream.getTracks()) {
        if (!existingTracks.has(track)) {
          pc.addTrack(track, this.localStream);
        }
      }
    }

    // ICE candidate
    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        this.signaling.emit('signal:ice', {
          roomId: this.roomId,
          targetId: peerId,
          candidate: evt.candidate,
        });
      }
    };

    // ICE connection state logging + failure handling
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.logger?.log(`ICE [${peerId.slice(0, 6)}]: ${state}`);
      this.onIceStateChange?.(peerId, state);

      if (state === 'connected' || state === 'completed') {
        this.retryCount.set(peerId, 0);
        this.onPeerConnected?.(peerId);
        this._checkRelayUsage(pc);
      }
      if (state === 'failed') {
        this._handleIceFailed(peerId);
      }
      if (state === 'disconnected') {
        // Grace period before escalating
        setTimeout(() => {
          if (this.peerConnections.get(peerId)?.iceConnectionState === 'disconnected') {
            this._handleIceFailed(peerId);
          }
        }, 5000);
      }
    };

    // Connection state logging
    pc.onconnectionstatechange = () => {
      this.logger?.log(`Conn [${peerId.slice(0, 6)}]: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        this._handleIceFailed(peerId);
      }
    };

    // Remote tracks (peer receives host media)
    pc.ontrack = (evt) => {
      this.logger?.log(`Track from ${peerId.slice(0, 6)}: ${evt.track.kind}`);
      const stream = evt.streams[0] || new MediaStream([evt.track]);
      this.onRemoteStream?.(peerId, stream);
    };

    return pc;
  }

  /** Check if connection uses TURN relay */
  async _checkRelayUsage(pc) {
    try {
      const stats = await pc.getStats();
      for (const [, report] of stats) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const localCandidate = stats.get(report.localCandidateId);
          if (localCandidate?.candidateType === 'relay') {
            this.logger?.log('Network relay mode activated (TURN)');
            this.onRelayDetected?.();
          }
        }
      }
    } catch {
      // Stats not available in all browsers
    }
  }

  /** Handle ICE failure with retry logic */
  _handleIceFailed(peerId) {
    const count = (this.retryCount.get(peerId) || 0) + 1;
    this.retryCount.set(peerId, count);

    if (count <= this.maxRetries) {
      this.logger?.log(`ICE failed [${peerId.slice(0, 6)}], retry ${count}/${this.maxRetries}`);
      if (this.isHost) {
        this.makeOffer(peerId, { iceRestart: true });
      } else {
        this.signaling.emit('signal:restart-ice', {
          roomId: this.roomId,
          targetId: peerId,
        });
      }
    } else {
      this.logger?.log(`ICE failed permanently [${peerId.slice(0, 6)}]`, 'error');
      this.onPeerDisconnected?.(peerId, 'ice-failed');
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Set the local media stream (host only).
   * Shares tracks to all existing peer connections without recreating the stream.
   */
  setLocalStream(stream) {
    this.localStream = stream;
    for (const [peerId, pc] of this.peerConnections) {
      const existingTracks = new Set(pc.getSenders().map(s => s.track).filter(Boolean));
      for (const track of stream.getTracks()) {
        if (!existingTracks.has(track)) {
          pc.addTrack(track, stream);
        }
      }
    }
  }

  /** Connect to a specific peer (creates connection + sends offer if host) */
  async connectToPeer(peerId) {
    this._ensurePeerConnection(peerId);
    if (this.isHost && this.localStream) {
      await this.makeOffer(peerId);
    }
  }

  /** Connect to multiple existing peers on room join */
  async connectToExistingPeers(peerIds) {
    for (const peerId of peerIds) {
      await this.connectToPeer(peerId);
    }
  }

  /** Create and send an offer to a specific peer */
  async makeOffer(peerId, { iceRestart = false } = {}) {
    const pc = this._ensurePeerConnection(peerId);
    const state = this.peerState.get(peerId);

    state.makingOffer = true;
    try {
      const offer = await pc.createOffer({ iceRestart });
      await pc.setLocalDescription(offer);
      this.signaling.emit('signal:offer', {
        roomId: this.roomId,
        targetId: peerId,
        sdp: pc.localDescription,
      });
      this.logger?.log(`Offer → ${peerId.slice(0, 6)}${iceRestart ? ' (restart)' : ''}`);
    } finally {
      state.makingOffer = false;
    }
  }

  /** Send offers to all connected peers (used after adding media tracks) */
  async offerToAllPeers({ iceRestart = false } = {}) {
    for (const peerId of this.peerConnections.keys()) {
      await this.makeOffer(peerId, { iceRestart });
    }
  }

  // ── Signaling Handlers ─────────────────────────────────────────────────────

  async _handleOffer(fromId, sdp) {
    const pc = this._ensurePeerConnection(fromId);
    const state = this.peerState.get(fromId);

    const offerCollision = state.makingOffer || pc.signalingState !== 'stable';
    const ignore = !state.polite && offerCollision;
    if (ignore) {
      this.logger?.log(`Ignored offer from ${fromId.slice(0, 6)} (collision)`);
      return;
    }

    await pc.setRemoteDescription(sdp);
    this.logger?.log(`Offer ← ${fromId.slice(0, 6)}`);
    await this._flushPendingCandidates(fromId);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.signaling.emit('signal:answer', {
      roomId: this.roomId,
      targetId: fromId,
      sdp: pc.localDescription,
    });
    this.logger?.log(`Answer → ${fromId.slice(0, 6)}`);
  }

  async _handleAnswer(fromId, sdp) {
    const pc = this.peerConnections.get(fromId);
    if (!pc) return;
    await pc.setRemoteDescription(sdp);
    this.logger?.log(`Answer ← ${fromId.slice(0, 6)}`);
    await this._flushPendingCandidates(fromId);
  }

  async _handleIce(fromId, candidate) {
    const pc = this._ensurePeerConnection(fromId);
    if (!pc.remoteDescription) {
      this.peerState.get(fromId).pendingCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      this.logger?.log(`ICE candidate failed: ${e.message}`, 'error');
    }
  }

  async _flushPendingCandidates(peerId) {
    const pc = this.peerConnections.get(peerId);
    const state = this.peerState.get(peerId);
    if (!pc || !state || !pc.remoteDescription) return;

    const pending = state.pendingCandidates.splice(0);
    for (const c of pending) {
      try {
        await pc.addIceCandidate(c);
      } catch (e) {
        this.logger?.log(`ICE candidate (pending) failed: ${e.message}`, 'error');
      }
    }
  }

  _handleRenegotiate(fromId) {
    if (!this.isHost) return;
    this.logger?.log(`Renegotiation requested by ${fromId.slice(0, 6)}`);
    this.makeOffer(fromId);
  }

  _handleRestartIce(fromId) {
    if (!this.isHost) return;
    this.logger?.log(`ICE restart requested by ${fromId.slice(0, 6)}`);
    this.makeOffer(fromId, { iceRestart: true });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  /** Remove a single peer connection */
  removePeer(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      try { pc.close(); } catch {}
      this.peerConnections.delete(peerId);
      this.peerState.delete(peerId);
      this.retryCount.delete(peerId);
    }
  }

  /** Tear down all connections */
  teardown() {
    for (const [peerId] of this.peerConnections) {
      this.removePeer(peerId);
    }
  }

  getPeerIds() {
    return Array.from(this.peerConnections.keys());
  }

  getConnectionCount() {
    return this.peerConnections.size;
  }

  /** Get outbound bitrate stats for adaptive bitrate monitoring */
  async getOutboundStats(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (!pc) return null;
    try {
      const stats = await pc.getStats();
      const result = { video: null, audio: null };
      for (const [, report] of stats) {
        if (report.type === 'outbound-rtp') {
          const kind = report.kind || report.mediaType;
          result[kind] = {
            bytesSent: report.bytesSent,
            packetsSent: report.packetsSent,
            timestamp: report.timestamp,
          };
        }
      }
      return result;
    } catch {
      return null;
    }
  }
}
