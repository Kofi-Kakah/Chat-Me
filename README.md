# 💬 Chat-Me API

### A real-time messaging backend for direct and group conversations

Chat-Me is a REST API and Socket.IO service for a WhatsApp-style chat application. It supports account registration and login, user profiles, direct and group conversations, message history, replies, attachments as structured metadata, delivery and read receipts, typing indicators, online presence, and notifications.

Built with **Node.js**, **TypeScript**, **Express 5**, **Socket.IO 4**, **Prisma ORM 7**, and **PostgreSQL**. Optional **Redis** coordinates Socket.IO broadcasts, presence, and typing state across server instances.

[![Node.js](https://img.shields.io/badge/Node.js-TypeScript-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?logo=socketdotio&logoColor=white)](https://socket.io/)
[![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-Optional-DC382D?logo=redis&logoColor=white)](https://redis.io/)

> This repository contains the backend API. It does not include a web or mobile client, a media upload service, or end-to-end message encryption.

**Quick Start · [Features](#features) · [Architecture](#architecture) · [Getting Started](#getting-started) · [API Reference](#api-reference) · [Realtime API](#realtime-api-socketio) · [Testing](#testing) · [Production Notes](#production-notes)**

---

## 📚 Table of Contents

- [Features](#features)
- [Technology Stack](#technology-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Authentication](#authentication)
- [API Reference](#api-reference)
  - [Authentication](#authentication-endpoints)
  - [Users](#user-endpoints)
  - [Conversations](#conversation-endpoints)
  - [Messages](#message-endpoints)
  - [Notifications](#notification-endpoints)
- [Realtime API (Socket.IO)](#realtime-api-socketio)
- [Data Model](#data-model)
- [Error Responses](#error-responses)
- [Testing](#testing)
- [Production Notes](#production-notes)
- [Known Scope and Next Steps](#known-scope-and-next-steps)

## Features

- **Authentication:** Register and sign in with email or username. Sessions are opaque, stored as SHA-256 hashes, expire, and can be revoked on logout.
- **Private conversations:** One idempotently-created direct conversation per pair of users.
- **Group conversations:** Create groups, update group details, add or remove members, leave, and delete. Roles include owner, admin, and member.
- **Messaging:** Text, structured attachment metadata, replies, edits, soft deletion, history pagination, and retry-safe sends when the client supplies a `clientId`.
- **Receipts:** Per-recipient delivery and read state, plus conversation-level last-read position.
- **Live events:** Socket.IO authentication, conversation rooms, message events, typing state, presence snapshots and updates, notifications, and membership events.
- **Notifications:** Message, mention, and group invite notifications with unread counts and read actions.
- **Deployment options:** PostgreSQL is required. Redis is optional for a single instance and recommended for horizontally scaled realtime deployments.
- **Input and request protections:** Zod validation, Helmet headers, CORS configuration, JSON body limits, and in-memory HTTP rate limiting.

## Technology Stack

| Area | Technology |
|---|---|
| Runtime | Node.js with TypeScript and `tsx` |
| HTTP API | Express 5 |
| Realtime transport | Socket.IO 4 |
| Database | PostgreSQL via Prisma ORM 7 and `pg` adapter |
| Realtime coordination | Redis via ioredis and Socket.IO Redis adapter (optional) |
| Validation | Zod |
| Password hashing | bcryptjs |

## Architecture

```mermaid
flowchart LR
    Client[Web or mobile client] -->|HTTPS REST| API[Express API]
    Client <-->|WebSocket / Socket.IO| RT[Realtime gateway]
    API --> Services[Domain services]
    RT --> Services
    Services --> DB[(PostgreSQL)]
    Services --> Bus[In-process realtime event bus]
    Bus --> RT
    RT -. optional across instances .-> Redis[(Redis adapter and ephemeral state)]
```

REST routes and Socket.IO handlers call the same domain services. Services persist changes and publish domain events to an in-process event bus; the realtime layer translates these into Socket.IO broadcasts. PostgreSQL remains the durable source of truth. Redis coordinates cross-instance Socket.IO rooms and ephemeral presence/typing data when configured.

## Project Structure

```text
src/
├── app.ts                       Express middleware and REST route mounting
├── server.ts                    HTTP and Socket.IO server lifecycle
├── index.ts                     Process startup and graceful shutdown
├── config/env.ts                Environment validation
├── lib/                         Prisma, Redis, sessions, mapping, event bus
├── middleware/                  Authentication, errors, rate limits
├── modules/
│   ├── auth/                    Register, login, logout, current user
│   ├── users/                   Profiles and user search
│   ├── conversations/           Conversation and membership operations
│   ├── messages/                 Message history, sends, edits, receipts
│   └── notifications/           Notification listing and read state
├── realtime/                    Socket.IO events, presence, typing
└── jobs.ts                      Periodic cleanup tasks
prisma/
├── schema.prisma                PostgreSQL data model
└── migrations/                  Ordered SQL migrations
scripts/
└── smoke.ts                     REST + Socket.IO end-to-end smoke scenario
```

## Getting Started

### Requirements

- Node.js compatible with the installed TypeScript/Prisma toolchain
- PostgreSQL database
- npm
- Redis only if you need multi-instance realtime coordination

### Install and configure

```bash
npm install
```

Create a `.env` file in the project root. At minimum, set a PostgreSQL connection string:

```dotenv
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require"
PORT=4000
CLIENT_ORIGIN="http://localhost:3000"
```

For a local PostgreSQL instance, use its local connection string and omit `sslmode=require` if SSL is not configured. See [Environment Variables](#environment-variables) for optional settings.

Generate the Prisma client, apply migrations, and start the development server:

```bash
npx prisma generate --config prisma7.config.ts
npm run db:migrate:deploy
npm run dev
```

The API listens on `http://localhost:4000` by default, and Socket.IO listens on `/socket.io`. Check the process with:

```bash
curl http://localhost:4000/health
```

Expected response:

```json
{
  "status": "ok",
  "uptime": 12.34,
  "mode": "memory"
}
```

`mode` is `redis` when `REDIS_URL` is configured and Redis initialized successfully; otherwise it is `memory`.

## Environment Variables

| Variable | Required | Default | Description |
|---|---:|---:|---|
| `DATABASE_URL` | Yes | — | PostgreSQL URL used by Prisma CLI and as the database fallback. |
| `DATABASE_URL_DIRECT` | No | — | Direct PostgreSQL URL preferred by the long-running application pool. |
| `DATABASE_URL_UNPOOLED` | No | — | Alternative name for a direct PostgreSQL URL, useful with Neon. |
| `PORT` | No | `4000` | HTTP listening port. `0` asks the OS for an available port. |
| `NODE_ENV` | No | `development` | `development`, `test`, or `production`. |
| `CLIENT_ORIGIN` | No | `*` | Comma-separated allowed browser origins, or `*`. Set explicit origins in production. |
| `SOCKET_PATH` | No | `/socket.io` | Socket.IO transport path. |
| `REDIS_URL` | No | — | Redis connection URL for adapter and shared ephemeral state. |
| `BCRYPT_ROUNDS` | No | `12` | bcrypt cost, range 4–15. |
| `SESSION_TTL_DAYS` | No | `30` | Session lifetime, range 1–365 days. |
| `PRESENCE_GRACE_SECONDS` | No | `12` | Offline grace period after the final socket disconnects. |
| `TYPING_TTL_SECONDS` | No | `6` | Typing state expiry, range 2–60 seconds. |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | HTTP rate-limit window in milliseconds. |
| `RATE_LIMIT_MAX` | No | `240` | Requests allowed per IP in the general API window. |
| `AUTH_RATE_LIMIT_MAX` | No | `15` | Register/login requests allowed per IP in the window. |
| `DB_POOL_MAX` | No | `10` | Maximum PostgreSQL pool connections per application instance. |
| `DB_POOL_IDLE_TIMEOUT_MS` | No | `60000` | Idle database connection timeout. |
| `DB_CONNECT_TIMEOUT_MS` | No | `15000` | Database connection timeout. |
| `DB_STATEMENT_TIMEOUT_MS` | No | `30000` | PostgreSQL statement timeout. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`. |

The application prefers `DATABASE_URL_DIRECT`, then `DATABASE_URL_UNPOOLED`, then `DATABASE_URL` for its connection pool. Keep secrets out of source control; `.env` is ignored by Git.

## Authentication

REST routes marked **Auth required** expect:

```http
Authorization: Bearer <session-token>
```

Register and login return a token and expiration timestamp. Send the token as Socket.IO handshake auth as well:

```ts
const socket = io(API_URL, {
  auth: { token },
});
```

The token is an opaque random value. The database stores only its SHA-256 hash. Logging out deletes the session and disconnects sockets authenticated with that session.

### Quick API flow

Register or log in, then create a direct conversation with another user's ID:

```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alex@example.com","username":"alex_01","password":"correct-horse-battery"}'
```

Use the returned token for authenticated routes:

```bash
curl -X POST http://localhost:4000/api/conversations/direct \
  -H 'Authorization: Bearer YOUR_SESSION_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"userId":"OTHER_USER_ID"}'
```

To send in realtime, connect with the token and include a stable `clientId` so reconnect retries cannot create duplicate messages:

```ts
import { io } from "socket.io-client";

const socket = io("http://localhost:4000", { auth: { token } });
socket.on("message:new", ({ message }) => console.log("New message", message));
socket.emit(
  "message:send",
  { conversationId, body: "Hello!", clientId: crypto.randomUUID() },
  (ack) => console.log("Send result", ack),
);
```

## API Reference

Base URL: `http://localhost:4000`. All request and response bodies use JSON unless the response is `204 No Content`. All routes below require bearer auth unless stated otherwise.

### Authentication endpoints

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | No | Create an account and session. Returns `201`. |
| `POST` | `/api/auth/login` | No | Sign in with username or email. |
| `POST` | `/api/auth/logout` | Yes | Revoke the current session and its active sockets. Returns `204`. |
| `GET` | `/api/auth/me` | Yes | Return the current user profile. |

Register body:

```json
{
  "email": "alex@example.com",
  "username": "alex_01",
  "password": "correct-horse-battery",
  "displayName": "Alex"
}
```

Username is 3–24 lowercase letters, digits, underscores, or dots. Password length is 8–72 characters. Login body is `{ "identifier": "alex_01", "password": "..." }`.

### User endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/users/me` | Current profile. |
| `PATCH` | `/api/users/me` | Update `displayName`, `bio`, or `avatarUrl`. |
| `GET` | `/api/users/search?q=alex&limit=10` | Search users; limit 1–20, defaults to 10. |
| `GET` | `/api/users/:username` | Fetch a user profile by username. |

Profile fields: `displayName` up to 64 characters, `bio` up to 500 characters, and `avatarUrl` up to 2048 characters or `null`.

### Conversation endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/conversations` | List the caller's active conversations, sorted by latest activity. Includes unread counts and last message. |
| `POST` | `/api/conversations/direct` | Create or return the existing direct conversation. Body: `{ "userId": "..." }`. |
| `POST` | `/api/conversations/group` | Create a group. Body: `{ "title": "Team", "memberIds": ["..."] }`; optional `imageUrl`. |
| `GET` | `/api/conversations/:id` | Get conversation details. |
| `PATCH` | `/api/conversations/:id` | Update group `title` and/or `imageUrl`; owner/admin only. |
| `DELETE` | `/api/conversations/:id` | Delete a group; owner only. Returns `204`. |
| `POST` | `/api/conversations/:id/members` | Add group members; owner/admin only. Body: `{ "userIds": ["..."] }`. |
| `DELETE` | `/api/conversations/:id/members/:userId` | Remove a group member; owner/admin only. |
| `POST` | `/api/conversations/:id/leave` | Leave a group. Direct conversations cannot be left. Returns `204`. |

Group titles are 1–80 characters. Creation accepts 1–100 member IDs; adding members accepts 1–50 IDs. A group owner who leaves transfers ownership to the longest-standing remaining member. A group with no remaining members is deleted.

### Message endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/conversations/:id/messages?limit=50&order=desc` | Paginated message history. `limit` is 1–100; `order` is `asc` or `desc`. |
| `POST` | `/api/conversations/:id/messages` | Send a message over REST. |
| `POST` | `/api/conversations/:id/delivered` | Mark selected or pending messages delivered. Body may include `messageIds`. |
| `POST` | `/api/conversations/:id/read` | Mark messages read. Body may include `messageIds` or `upToMessageId`. |
| `GET` | `/api/messages/:id` | Get a message. |
| `PATCH` | `/api/messages/:id` | Edit your own message. Body: `{ "body": "Updated text" }`. |
| `DELETE` | `/api/messages/:id` | Soft-delete your message. Group owners/admins can moderate group messages. |

Send body:

```json
{
  "body": "Hello!",
  "replyToId": "optional-message-id",
  "clientId": "stable-client-generated-id",
  "attachments": []
}
```

A message must have non-empty text or at least one attachment object. Text is limited to 4000 characters; up to 10 attachment metadata objects are accepted. The API stores attachment metadata only; clients must provide their own upload/storage flow. `clientId` is optional and makes retries idempotent per sender and conversation. It should remain the same for every retry of the same send.

History uses a keyset cursor. When another page exists, the response contains a `nextCursor`; pass it back as `before`:

```http
GET /api/conversations/:id/messages?limit=50&before=<nextCursor>
```

Response shape:

```json
{
  "messages": [],
  "nextCursor": "..."
}
```

Deleted messages remain in history as tombstones with redacted content.

### Notification endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/notifications?limit=20&unreadOnly=true` | List notifications. `limit` is 1–50; supports `before` cursor. |
| `GET` | `/api/notifications/unread-count` | Return `{ "count": 3 }`. |
| `POST` | `/api/notifications/:id/read` | Mark one notification read. |
| `POST` | `/api/notifications/read-all` | Mark all caller notifications read. |

## Realtime API (Socket.IO)

Connect to the same host as the HTTP API using the configured `SOCKET_PATH` (default `/socket.io`) and provide a valid session token in `auth.token`. The server automatically joins the user's private room and active conversation rooms. Membership checks are also performed before message and receipt operations.

### Client → server events

All events except the heartbeat support an optional Socket.IO acknowledgement callback. Responses have the form `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message" } }`.

| Event | Payload | Description |
|---|---|---|
| `message:send` | `{ conversationId, body?, attachments?, replyToId?, clientId? }` | Persist and broadcast a message. |
| `message:delivered` | `{ conversationId, messageIds? }` | Mark explicit or pending messages delivered. |
| `message:read` | `{ conversationId, messageIds?, upToMessageId? }` | Mark messages read and update conversation read position. |
| `typing:start` | `{ conversationId }` | Set typing state and broadcast to other members. |
| `typing:stop` | `{ conversationId }` | Clear typing state. |
| `presence:heartbeat` | Optional payload | Refresh the user's presence TTL. |

### Server → client events

| Event | Payload | Description |
|---|---|---|
| `message:new` | `{ message }` | New message in a joined conversation. |
| `message:update` | `{ message }` | Message edited or deleted. |
| `receipts:update` | `{ conversationId, userId, messageIds, deliveredAt?, readAt? }` | Delivery/read state changed. |
| `conversation:read` | `{ conversationId, userId, lastReadAt }` | A member's read position changed. |
| `typing:update` | `{ conversationId, userId, isTyping }` | Typing state changed. |
| `presence:snapshot` | `{ users: [{ userId, isOnline, lastSeenAt }] }` | Contact presence at connection time. |
| `presence:update` | `{ userId, isOnline, lastSeenAt }` | Contact came online or went offline. |
| `conversation:new` | `{ conversation }` | Conversation created or caller added to a group. |
| `conversation:updated` | `{ conversation }` | Group details or membership changed. |
| `conversation:removed` | `{ conversationId, reason }` | Caller left, was removed, or group was deleted. |
| `notification:new` | `{ notification }` | New notification for the caller. |

The Socket.IO Redis adapter broadcasts room events across instances. Without Redis, realtime coordination is limited to a single process and presence/typing use in-memory state.

## Data Model

| Model | Purpose |
|---|---|
| `User` | Login identity and public profile; stores hashed password and presence fields. |
| `Session` | Revocable, expiring hashed authentication sessions. |
| `Conversation` | Direct or group chat metadata. Direct chats use a canonical unique user-pair key. |
| `ConversationMember` | Membership, role, mute window, join/leave state, and read position. |
| `Message` | Text, structured attachment JSON, reply reference, edit/delete timestamps, and optional idempotency key. |
| `MessageRead` | Per-recipient delivery and read timestamps. |
| `Notification` | Message, mention, and group-invite notification records. |
| `TypingStatus` | Short-lived persisted typing state, cleaned up periodically. |

## Error Responses

Errors use a stable JSON envelope:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Invalid request payload",
    "details": []
  }
}
```

Common HTTP statuses are `400` for invalid operations, `401` for missing/invalid auth, `403` for insufficient permissions, `404` for unavailable resources, `409` for conflicts, `422` for schema validation, `429` for rate limits, and `500` for unexpected failures. Socket event errors use the acknowledgement envelope described above.

## Testing

```bash
npm run typecheck   # TypeScript compiler check
npm run smoke       # Full REST + Socket.IO integration scenario
npm test            # Runs both commands above
```

**Important:** `scripts/smoke.ts` connects to the database configured in `.env`, creates test users, and performs cleanup for usernames beginning with `sm_`. Run it only against a dedicated disposable test database. It is not safe to run against production or a database containing real users with that prefix.

## Production Notes

- Terminate TLS at a trusted load balancer or reverse proxy. Forward WebSocket upgrades and configure the client origin explicitly.
- Set `REDIS_URL` when running multiple app instances. Keep Redis network access private and configure managed-service authentication/TLS as appropriate.
- Apply Prisma migrations during deployment with `npm run db:migrate:deploy`; do not use schema reset commands against production data.
- Use a managed PostgreSQL service, backups, point-in-time recovery, and connection limits that account for `DB_POOL_MAX` multiplied by the number of app replicas.
- Keep `.env` and credentials in a secret manager. Rotate database credentials and restrict database/network access to application workloads.
- The current HTTP rate limiter uses process memory. Its counters are not shared between instances and reset on restart; use a gateway or shared store for distributed production rate limiting.
- `/health` is a liveness response and does not verify database/Redis readiness. Configure deployment health checks and alerting that also monitor dependencies.
- Use structured logs and an external monitoring system. Avoid logging auth tokens, passwords, or message bodies.
- Attachment JSON is not an upload pipeline. Validate uploaded content and enforce ownership/authorization in a dedicated object-storage service before exposing files.

## Known Scope and Next Steps

This service provides messaging transport and persistence, but a complete consumer application still needs a client, media upload/storage integration, push notifications, and deployment-specific observability. Messages are stored as readable data in PostgreSQL; this implementation does **not** provide end-to-end encryption. Review privacy, retention, abuse reporting, and account recovery requirements before launching to end users.

---

## License

No license is currently specified in `package.json`. Add a license file before distributing this project publicly.
