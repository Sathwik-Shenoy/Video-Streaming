/**
 * Room Manager — manages multi-user rooms for the Watch Party.
 * Each room supports 1 host + up to 5 peers (6 total).
 */

const MAX_PEERS_PER_ROOM = 5;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.hostId = null;
    this.peers = new Set();
    this.createdAt = Date.now();
  }

  get isEmpty() {
    return !this.hostId && this.peers.size === 0;
  }

  get isFull() {
    return this.peers.size >= MAX_PEERS_PER_ROOM;
  }

  get memberCount() {
    return (this.hostId ? 1 : 0) + this.peers.size;
  }

  addHost(socketId) {
    if (this.hostId && this.hostId !== socketId) {
      return { ok: false, error: 'Room already has a host' };
    }
    this.hostId = socketId;
    return { ok: true };
  }

  addPeer(socketId) {
    if (!this.hostId) {
      return { ok: false, error: 'Waiting for host to join' };
    }
    if (this.isFull) {
      return { ok: false, error: 'Room is full (max 6 users)' };
    }
    if (this.peers.has(socketId)) {
      return { ok: true }; // already in room
    }
    this.peers.add(socketId);
    return { ok: true };
  }

  removeHost() {
    this.hostId = null;
  }

  removePeer(socketId) {
    this.peers.delete(socketId);
  }

  hasMember(socketId) {
    return this.hostId === socketId || this.peers.has(socketId);
  }

  getAllPeerIds() {
    return Array.from(this.peers);
  }

  getAllMemberIds() {
    const members = [];
    if (this.hostId) members.push(this.hostId);
    for (const id of this.peers) members.push(id);
    return members;
  }

  getPublicState() {
    return {
      roomId: this.roomId,
      hostPresent: Boolean(this.hostId),
      hostId: this.hostId,
      peerCount: this.peers.size,
      memberCount: this.memberCount,
      peers: this.getAllPeerIds(),
      createdAt: this.createdAt,
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this._startCleanup();
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  ensureRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Room(roomId));
    }
    return this.rooms.get(roomId);
  }

  deleteRoom(roomId) {
    this.rooms.delete(roomId);
  }

  cleanupIfEmpty(roomId) {
    const room = this.rooms.get(roomId);
    if (room && room.isEmpty) {
      this.rooms.delete(roomId);
      return true;
    }
    return false;
  }

  getRoomCount() {
    return this.rooms.size;
  }

  /** Find which room a socket belongs to */
  findRoomBySocket(socketId) {
    for (const [roomId, room] of this.rooms) {
      if (room.hasMember(socketId)) return { roomId, room };
    }
    return null;
  }

  _startCleanup() {
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [roomId, room] of this.rooms.entries()) {
        if (now - room.createdAt > ROOM_TTL_MS || room.isEmpty) {
          this.rooms.delete(roomId);
        }
      }
    }, 30 * 60 * 1000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  destroy() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
  }
}

module.exports = { Room, RoomManager, MAX_PEERS_PER_ROOM };
