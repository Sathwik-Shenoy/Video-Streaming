/**
 * Media Transport Abstraction Layer
 * Decouples media distribution from the WebRTC connection layer.
 * Currently supports Mesh mode; prepared for future SFU integration
 * (Mediasoup, Janus, or custom SFU).
 */

export const TransportMode = Object.freeze({
  MESH: 'mesh',
  SFU: 'sfu',
});

export class MediaTransport {
  /**
   * @param {Object} opts
   * @param {string} opts.mode - TransportMode.MESH or TransportMode.SFU
   * @param {import('./webrtcManager.js').WebRTCManager} opts.webrtcManager
   * @param {Object} opts.logger
   */
  constructor({ mode = TransportMode.MESH, webrtcManager, logger } = {}) {
    this.mode = mode;
    this.webrtcManager = webrtcManager;
    this.logger = logger;

    /** @type {Object|null} Future SFU client (Mediasoup Device, Janus session, etc.) */
    this.sfuClient = null;
  }

  /**
   * Publish a local media stream to all connected peers.
   * In mesh mode, adds tracks and re-offers. In SFU mode, publishes to the SFU.
   */
  async publishStream(stream) {
    if (this.mode === TransportMode.MESH) {
      this.webrtcManager.setLocalStream(stream);
      await this.webrtcManager.offerToAllPeers();
      this.logger?.log(`[transport:mesh] Published stream to ${this.webrtcManager.getConnectionCount()} peers`);
      return;
    }

    if (this.mode === TransportMode.SFU && this.sfuClient) {
      // Future: await this.sfuClient.produce(stream);
      this.logger?.log('[transport:sfu] Stream published via SFU');
      return;
    }

    this.logger?.log('[transport] No valid transport mode configured', 'error');
  }

  /**
   * Connect to a remote peer for receiving media.
   */
  async connectToPeer(peerId) {
    if (this.mode === TransportMode.MESH) {
      return this.webrtcManager.connectToPeer(peerId);
    }

    if (this.mode === TransportMode.SFU && this.sfuClient) {
      // Future: await this.sfuClient.subscribe(peerId);
      return;
    }
  }

  /**
   * Connect to multiple peers (used on room join).
   */
  async connectToExistingPeers(peerIds) {
    if (this.mode === TransportMode.MESH) {
      return this.webrtcManager.connectToExistingPeers(peerIds);
    }

    // SFU: subscription is typically handled via SFU events
  }

  /**
   * Disconnect from a specific peer.
   */
  removePeer(peerId) {
    if (this.mode === TransportMode.MESH) {
      this.webrtcManager.removePeer(peerId);
    }
  }

  /**
   * Tear down all connections.
   */
  teardown() {
    if (this.mode === TransportMode.MESH) {
      this.webrtcManager.teardown();
    }
    if (this.sfuClient?.disconnect) {
      this.sfuClient.disconnect();
    }
  }

  /**
   * Get transport stats.
   */
  getStats() {
    return {
      mode: this.mode,
      peerCount: this.webrtcManager.getConnectionCount(),
    };
  }

  // ── Future SFU Integration ─────────────────────────────────────────────────

  /**
   * Switch to SFU mode and set the SFU client instance.
   * Expected SFU client interface:
   *   - produce(stream: MediaStream): Promise<void>
   *   - subscribe(peerId: string): Promise<MediaStream>
   *   - disconnect(): void
   *
   * @param {Object} client - SFU client implementation
   */
  setSfuClient(client) {
    this.sfuClient = client;
    this.mode = TransportMode.SFU;
    this.logger?.log('[transport] Switched to SFU mode');
  }

  /**
   * Switch back to mesh mode (e.g., if SFU is unavailable).
   */
  revertToMesh() {
    this.sfuClient = null;
    this.mode = TransportMode.MESH;
    this.logger?.log('[transport] Reverted to mesh mode');
  }
}
