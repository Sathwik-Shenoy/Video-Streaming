# P2P Watch Party

Production-grade **WebRTC peer-to-peer watch party** where a **host streams a local video file (or optionally a screen share)** directly to **one peer** over the internet. The server performs **signaling only** (no media relay / no media processing).

## Architecture

- **Backend**: Node.js + Express + Socket.io
  - Serves static frontend from `public/`
  - Provides `GET /api/room/new` to mint UUIDv4 room IDs
  - Maintains in-memory **1:1 room state**: exactly **one host** and **one peer**
  - Relays signaling messages (`offer/answer/ICE`) between host and peer
  - **No media traffic** goes through the server

- **Frontend**: Vanilla JS + WebRTC + HTML5 `<video>`
  - Host selects a local file and streams it using `HTMLVideoElement.captureStream()`
  - WebRTC `RTCPeerConnection` sends tracks to the peer
  - A WebRTC **data channel** synchronizes controls, drift correction, chat, and latency measurement

## Folder structure

```
server/
  server.js
public/
  index.html
  room.html
  client.js
  styles.css
package.json
README.md
```

## Running locally

Install dependencies:

```bash
npm install
```

Start the server:

```bash
npm start
```

Open:
- `http://localhost:3001/` → create a room (host link + peer link)

## WebRTC flow (high level)

### 1) Room system (Socket.io rooms)

- Host creates a room ID via `GET /api/room/new` and opens:
  - `room.html?room=<uuid>&role=host`
- Peer joins via:
  - `room.html?room=<uuid>`

Server enforces:
- **One host per room**
- **One peer per room**
- Room IDs must be **UUIDv4**

### 2) SDP offer/answer exchange (signaling)

**Host**
- Creates `RTCPeerConnection`
- Creates a **data channel** (`control`)
- After selecting a file:
  - loads it into a `<video>`
  - calls `video.captureStream()` to get a `MediaStream`
  - adds tracks to the peer connection
- Creates an SDP **offer** and sends it via Socket.io:
  - `signal:offer`

**Peer**
- Receives `signal:offer`
- Applies it as `setRemoteDescription()`
- Creates SDP **answer**
- Sends it back via Socket.io:
  - `signal:answer`

Once both sides have exchanged descriptions, the peer connection can establish.

### 3) ICE candidates exchange (NAT traversal)

WebRTC gathers potential network routes called **ICE candidates**.

- Each side emits candidates in `pc.onicecandidate`
- Candidates are relayed via Socket.io:
  - `signal:ice`
- The other side calls `pc.addIceCandidate()`

This project uses:
- **STUN**: Google public STUN server (`stun:stun.l.google.com:19302`)
- **TURN placeholder**: present in code comments for production TURN deployment

### NAT traversal notes

- **STUN** helps discover the public-facing address of a peer behind NAT.
- Some NAT/firewall configurations require **TURN** (a relay) to succeed.
- The server in this repo is **not a TURN server** and does not relay media.

## Data channel usage

A reliable ordered WebRTC data channel is used for:

- **Playback control requests** (peer → host): `req`
- **Authoritative state broadcasts** (host → peer): `state`
- **Chat** messages: `chat`
- **Latency measurement**: `ping` / `pong` (RTT)

Because media and control are both peer-to-peer, playback remains responsive and low-latency once connected.

## Sync algorithm (authoritative timestamp model)

### Roles

- **Host is authoritative** for playback state.
- **Peer can request controls** (play/pause/seek), but the host applies the request and re-broadcasts the authoritative state.

This prevents control “dueling” and makes drift correction deterministic.

### Messages

- `req` (peer → host): `{ action: 'play'|'pause'|'seek'|'state', time? }`
- `state` (host → peer): `{ seq, paused, time, sentAt, reason }`

### Infinite-loop prevention

Programmatic changes (applying remote state) can trigger local DOM events (`play`, `pause`, `seeked`).

The client prevents loops by:
- Setting a short **suppression window** (≈ 400ms) while applying remote changes
- Ignoring media events during that window

### Debouncing seeks

Seeking can fire rapidly while dragging the scrubber.

The peer:
- Debounces seek requests (~250ms)
to reduce spam and improve stability.

### Drift correction (> 500ms)

The host periodically broadcasts `state` every ~2s.

The peer:
- Predicts the *expected current time* based on:
  - host `time`
  - host `sentAt`
  - local receipt time
- If \(|drift| > 0.5s\), it snaps `currentTime` to the target

## Error handling & retry behavior

- If the peer opens the link before the host joins, the peer will **auto-retry** joining for ~60 seconds.
- ICE failures show in the UI (`ICE: failed`).
  - The peer can request an ICE restart (`signal:restart-ice`)
  - The host can generate a fresh offer with `iceRestart: true`

## Recording (optional)

The room UI includes a recording button:
- Host records the **local stream**
- Peer records the **received remote stream**

Recording uses `MediaRecorder` and produces a downloadable `.webm`.

## Security notes

- **Room ID validation**: UUIDv4 only
- **Single host, single peer** enforced server-side
- **Basic rate limiting**: in-memory per-IP window on HTTP requests and socket handshakes

For production hardening you should add:
- A real TURN server (and credentials)
- HTTPS + secure WebSocket
- CORS origin restriction (`ALLOWED_ORIGIN`)
- Persistent state (if you need room persistence across deploys)

# P2P Watch Party

Peer-to-peer watch party using WebRTC for media and Socket.io for signaling. The server never touches media; it only handles signaling.

## Features
- Host captures a local video via `captureStream()` and shares it to a remote peer.
- WebRTC with STUN (Google) and TURN placeholder configuration.
- Data channel for playback sync, chat, latency pings, and drift correction.
- Room system with UUID IDs, single host enforcement, and Socket.io rooms.
- Basic rate limiting and security validation on the signaling server.
- Optional recording of the received stream to WebM.

## Quick start
```bash
npm install
npm run start # or npm run dev
```
Open http://localhost:3000 and create or join a room.

## Architecture
- **Backend**: Node.js + Express + Socket.io (signaling only). Static files served from `public/`. No media processing.
- **Frontend**: Vanilla JS + HTML5 video + WebRTC (`RTCPeerConnection`). Data channel drives sync and chat.
- **Rooms**: UUID-based IDs. One host per room; peers join via link. Server keeps lightweight in-memory room state.

## Signaling flow
1. Host creates a room (UUID) and joins as host via Socket.io.
2. Peer joins the same room ID.
3. Host creates an `RTCPeerConnection`, adds captured video tracks, creates an SDP offer, and sends it through `signal:offer`.
4. Peer sets the remote description, creates an SDP answer, and returns it with `signal:answer`.
5. Both sides exchange ICE candidates through `signal:ice` until connectivity is established.
6. Data channel (`control`) opens; playback and chat messages flow P2P.

## WebRTC details
- **SDP exchange**: Offer/answer exchanged over Socket.io. Host attaches media before creating an offer to avoid renegotiation.
- **ICE candidates**: Trickled via `signal:ice` and added with `addIceCandidate`. Google STUN is configured; TURN placeholder included for production.
- **NAT traversal**: STUN discovers public-facing candidates. For restrictive NATs, configure a TURN server in `public/client.js` `iceServers`.
- **Data channel usage**: Single channel (`control`) carries JSON messages: `PLAY`, `PAUSE`, `SEEK`, `SYNC`, `SYNC_REQUEST`, `CHAT`, `PING/PONG` for latency. Messages are small and ordered (default reliable).

## Sync algorithm
- Authoritative timestamp broadcast on play/pause/seek. Hosts respond to `SYNC_REQUEST` with `SYNC` carrying `currentTime` and `paused` state.
- Drift correction: receivers compare `currentTime` against incoming timestamps; if |delta| > 0.5s, they fast seek to the authoritative time.
- Debounce: `seeked` events are debounced (~120ms) before sending to prevent event storms.
- Loop prevention: Incoming sync actions run under a suppression flag to avoid re-emitting events.

## Error handling
- Invalid room IDs rejected server-side; only one host allowed per room.
- Rate limiting on HTTP and socket handshakes (simple in-memory sliding window).
- ICE failure triggers renegotiation request (`signal:renegotiate`); manual reconnect button is provided.
- UI shows connection state and peer presence.

## Recording
- `MediaRecorder` can record the remote stream (or local if remote not available). Output is a downloadable WebM file.

## Folder structure
- server/server.js
- public/index.html
- public/room.html
- public/client.js
- public/styles.css
- package.json

## Deployment notes
- Set `PORT` via environment variable if needed.
- Add a TURN server entry in `iceServers` for production NAT traversal.
- Behind proxies, ensure `trust proxy` is set on Express if you need accurate IPs for rate limiting.
