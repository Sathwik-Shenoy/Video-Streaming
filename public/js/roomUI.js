/**
 * Room UI — handles all DOM manipulation, toast notifications,
 * chat, viewer list, drift overlay, and user-facing state.
 */

export class RoomUI {
  constructor({ isHost }) {
    this.isHost = isHost;

    // DOM element references (assigned after DOM ready)
    this.els = {};
    this._toastContainer = null;
    this._debugOverlay = null;
    this._debugVisible = false;
    this._viewers = new Map(); // peerId → display name

    /** Simple logger that writes to the connection log panel */
    this.logger = {
      log: (msg, level = 'info') => {
        this._logLine(msg, level);
      },
    };
  }

  /** Bind all DOM elements after page load */
  init() {
    const $ = (sel) => document.querySelector(sel);
    this.els = {
      // Layout
      videoContainer: $('#videoContainer'),
      video: $('#video'),
      connectionState: $('#connectionState'),
      viewerCount: $('#viewerCount'),
      roomMeta: $('#roomMeta'),
      roleLabel: $('#roleLabel'),
      roomLabel: $('#roomLabel'),
      latencyLabel: $('#latencyLabel'),

      // Controls
      filePicker: $('#filePicker'),
      startStreamBtn: $('#startStreamBtn'),
      shareScreenBtn: $('#shareScreenBtn'),
      syncBtn: $('#syncBtn'),
      reconnectBtn: $('#reconnectBtn'),
      playBtn: $('#playBtn'),
      pauseBtn: $('#pauseBtn'),
      copyLinkBtn: $('#copyLinkBtn'),
      toggleDebugBtn: $('#toggleDebugBtn'),

      // Chat
      chatPanel: $('#chatPanel'),
      chatMessages: $('#chatMessages'),
      chatInput: $('#chatInput'),
      chatSendBtn: $('#chatSendBtn'),

      // Viewers
      viewersList: $('#viewersList'),

      // Log
      logPanel: $('#logPanel'),

      // Overlays
      loadingOverlay: $('#loadingOverlay'),
      waitingOverlay: $('#waitingOverlay'),
    };

    this._createToastContainer();
    this._createDebugOverlay();
    this._setupHostOnlyControls();
  }

  // ── Toast Notifications ────────────────────────────────────────────────────

  _createToastContainer() {
    this._toastContainer = document.createElement('div');
    this._toastContainer.id = 'toastContainer';
    this._toastContainer.className = 'toast-container';
    document.body.appendChild(this._toastContainer);
  }

  toast(message, type = 'info', durationMs = 4000) {
    if (!this._toastContainer) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    this._toastContainer.appendChild(el);

    // Trigger animation
    requestAnimationFrame(() => el.classList.add('toast-visible'));

    setTimeout(() => {
      el.classList.remove('toast-visible');
      el.addEventListener('transitionend', () => el.remove());
      // Fallback removal
      setTimeout(() => el.remove(), 500);
    }, durationMs);
  }

  // ── Drift Debug Overlay ────────────────────────────────────────────────────

  _createDebugOverlay() {
    this._debugOverlay = document.createElement('div');
    this._debugOverlay.id = 'debugOverlay';
    this._debugOverlay.className = 'debug-overlay hidden';
    this._debugOverlay.innerHTML = `
      <div class="debug-row"><span>Drift:</span> <span id="debugDrift">--</span></div>
      <div class="debug-row"><span>Latency:</span> <span id="debugLatency">--</span></div>
      <div class="debug-row"><span>Peers:</span> <span id="debugPeers">0</span></div>
      <div class="debug-row"><span>Transport:</span> <span id="debugTransport">mesh</span></div>
    `;
    document.body.appendChild(this._debugOverlay);
  }

  toggleDebugOverlay() {
    this._debugVisible = !this._debugVisible;
    this._debugOverlay?.classList.toggle('hidden', !this._debugVisible);
  }

  updateDebug({ drift, latency, peers, transport }) {
    const $ = (sel) => document.querySelector(sel);
    if (drift != null) {
      const el = $('#debugDrift');
      if (el) el.textContent = `${(drift * 1000).toFixed(0)}ms`;
    }
    if (latency != null) {
      const el = $('#debugLatency');
      if (el) el.textContent = `${latency}ms`;
    }
    if (peers != null) {
      const el = $('#debugPeers');
      if (el) el.textContent = String(peers);
    }
    if (transport != null) {
      const el = $('#debugTransport');
      if (el) el.textContent = transport;
    }
  }

  // ── Host-only Controls ─────────────────────────────────────────────────────

  _setupHostOnlyControls() {
    if (!this.isHost) {
      // Hide host-only controls for peers
      if (this.els.filePicker) this.els.filePicker.style.display = 'none';
      if (this.els.startStreamBtn) this.els.startStreamBtn.style.display = 'none';
      if (this.els.shareScreenBtn) this.els.shareScreenBtn.style.display = 'none';
    }
  }

  // ── Room Meta ──────────────────────────────────────────────────────────────

  setRoomMeta({ roomId }) {
    if (this.els.roleLabel) this.els.roleLabel.textContent = this.isHost ? 'Host' : 'Viewer';
    if (this.els.roomLabel) this.els.roomLabel.textContent = roomId.slice(0, 8) + '…';
    if (this.els.roomLabel) this.els.roomLabel.title = roomId;
  }

  setConnectionState(text) {
    if (this.els.connectionState) {
      this.els.connectionState.textContent = text;
      this.els.connectionState.className = 'pill ' + this._stateClass(text);
    }
  }

  _stateClass(text) {
    const t = text.toLowerCase();
    if (t.includes('connected') || t.includes('ready')) return 'pill-success';
    if (t.includes('connecting') || t.includes('waiting') || t.includes('joined')) return 'pill-warn';
    return 'pill-error';
  }

  // ── Video ──────────────────────────────────────────────────────────────────

  setRemoteStream(stream) {
    const v = this.els.video;
    if (!v) return;
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.play().catch(() => {});
    }
  }

  showLoading(show) {
    if (this.els.loadingOverlay) {
      this.els.loadingOverlay.classList.toggle('hidden', !show);
    }
  }

  showWaiting(show) {
    if (this.els.waitingOverlay) {
      this.els.waitingOverlay.classList.toggle('hidden', !show);
    }
  }

  // ── Viewer Count ───────────────────────────────────────────────────────────

  setViewerCount(count) {
    if (this.els.viewerCount) {
      this.els.viewerCount.textContent = `${count} viewer${count !== 1 ? 's' : ''}`;
    }
  }

  // ── Viewers List ───────────────────────────────────────────────────────────

  addViewer(peerId, role = 'peer') {
    const name = role === 'host' ? 'Host' : `Viewer ${this._viewers.size + 1}`;
    this._viewers.set(peerId, name);
    this._renderViewers();
  }

  removeViewer(peerId) {
    this._viewers.delete(peerId);
    this._renderViewers();
  }

  clearViewers() {
    this._viewers.clear();
    this._renderViewers();
  }

  _renderViewers() {
    if (!this.els.viewersList) return;
    this.els.viewersList.innerHTML = '';
    for (const [id, name] of this._viewers) {
      const li = document.createElement('li');
      li.textContent = name;
      li.dataset.peerId = id;
      this.els.viewersList.appendChild(li);
    }
    this.setViewerCount(this._viewers.size);
  }

  // ── Latency ────────────────────────────────────────────────────────────────

  setLatency(ms) {
    if (this.els.latencyLabel) this.els.latencyLabel.textContent = `${ms}ms`;
  }

  // ── Copy Room Link ─────────────────────────────────────────────────────────

  copyRoomLink(roomId) {
    const link = `${location.origin}/room.html?room=${encodeURIComponent(roomId)}`;
    navigator.clipboard.writeText(link).then(() => {
      this.toast('Room link copied!', 'success', 2000);
    }).catch(() => {
      this.toast('Failed to copy link', 'error');
    });
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  appendChat({ from, text, sentAt }) {
    if (!this.els.chatMessages) return;
    const ts = sentAt ? new Date(sentAt).toLocaleTimeString() : new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<span class="chat-time">${ts}</span> <span class="chat-from">${this._escapeHtml(from)}</span>: ${this._escapeHtml(text)}`;
    this.els.chatMessages.appendChild(div);
    this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Connection Log ─────────────────────────────────────────────────────────

  _logLine(msg, level = 'info') {
    if (!this.els.logPanel) return;
    const ts = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.className = `log-line log-${level}`;
    div.textContent = `[${ts}] ${msg}`;
    this.els.logPanel.appendChild(div);
    this.els.logPanel.scrollTop = this.els.logPanel.scrollHeight;
  }
}
