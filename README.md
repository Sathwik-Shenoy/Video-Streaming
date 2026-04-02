# P2P Watch Party

Production-oriented WebRTC watch party app where a host shares local media to participants. Media is peer-to-peer (mesh), while the Node.js server handles signaling, room state, rate limiting, and ICE config.

## What this project does

- Creates UUID-based rooms for watch sessions
- Supports one host and multiple peers per room (mesh topology)
- Streams host media via WebRTC to connected peers
- Syncs playback using host-authoritative control events
- Supports chat, latency ping, reconnect/renegotiation, and optional recording
- Exposes TURN/STUN ICE configuration from server-side environment variables

## Tech stack

- Backend: Node.js, Express, Socket.io
- Frontend: Vanilla JavaScript, HTML5 video, WebRTC
- Security/runtime: Helmet, CORS, dotenv, custom in-memory rate limiting

## Project structure

```txt
server/
  server.js
  roomManager.js
  rateLimiter.js
public/
  index.html
  room.html
  client.js
  styles.css
package.json
README.md
```

## Quick start

```bash
npm install
npm start
```

App runs on:
- `http://localhost:3000` (default)

Useful scripts:
- `npm run start` - production-style run
- `npm run dev` - nodemon development mode
- `npm run prod` - explicit production env run

## Environment variables

Optional (with defaults):

- `PORT=3000`
- `NODE_ENV=development`
- `USE_HTTPS=false`
- `SSL_CERT_PATH=certs/cert.pem`
- `SSL_KEY_PATH=certs/key.pem`
- `ALLOWED_ORIGIN=*`
- `RATE_LIMIT_MAX=120`

TURN config (recommended for restrictive NATs):

- `TURN_URL` (supports comma-separated URLs)
- `TURN_USERNAME`
- `TURN_PASSWORD`

## HTTP endpoints

- `GET /health` - server health, uptime, room count
- `GET /api/room/new` - mint a new UUID room ID
- `GET /api/ice-config` - STUN/TURN configuration used by clients

## Socket event reference

Room and presence:
- `room:join` - join as `host` or `peer`
- `room:leave` - explicit leave
- `room:user-joined` - notify room members about join
- `room:info` - broadcast current room public state

Signaling:
- `signal:offer`
- `signal:answer`
- `signal:ice`
- `signal:renegotiate`
- `signal:restart-ice`

Sync and interaction:
- `sync:state` - host broadcasts authoritative playback state
- `sync:request` - peer requests host action (`play/pause/seek`)
- `chat:message` - relayed room chat message
- `ping:req` / `ping:res` - RTT measurement

## How it works

1. User creates room via `GET /api/room/new`.
2. Host joins room and starts media stream from local video element.
3. Peers join the same room.
4. Peers establish WebRTC connections using targeted offer/answer + ICE via Socket.io.
5. Once connected, media flows directly peer-to-peer.
6. Host sends authoritative sync state; peers request actions through host to avoid desync conflicts.

## Networking notes

- STUN is enabled by default (Google STUN servers).
- TURN is environment-driven; strongly recommended for production reliability across NAT/firewalls.
- Server does not relay media.

## Security and reliability notes

- Room IDs are validated as UUIDs.
- In-memory rate limiting is applied to HTTP and socket handshakes.
- Helmet and CORS are enabled.
- Room state is in memory (no persistence across restarts).

## Known limitations

- Mesh topology scales poorly for large rooms (peer count growth increases bandwidth/CPU load).
- Room state resets on server restart.
- For production, add durable storage, full auth, and a managed TURN setup.

## Local test flow (single machine)

1. Start server with `npm start`.
2. Open `http://localhost:3000` in Browser A, create room, join as host.
3. Open the join link in Browser B (or incognito) as peer.
4. Start playback on host and verify sync/chat/latency behavior.

## License

MIT
