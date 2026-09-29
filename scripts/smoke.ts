/**
 * End-to-end smoke test for the Chat-Me backend.
 *
 * Boots the real HTTP + Socket.IO server on an ephemeral port (in-memory
 * presence/typing mode), then exercises REST and realtime flows against the
 * linked Neon production database. All test data is cleaned up afterwards.
 *
 * Run: npm run smoke
 */
process.env.NODE_ENV = "test";
process.env.PORT = "0";
process.env.PRESENCE_GRACE_SECONDS = "1";
process.env.LOG_LEVEL = "debug";
// The production bcrypt cost factor dominates a run against a remote database
// and has no bearing on anything this suite asserts.
process.env.BCRYPT_ROUNDS = "4";

import { io as connectSocket, type Socket } from "socket.io-client";
import type {
  ConversationDTO,
  MessageDTO,
  NotificationDTO,
  PublicUser,
  ReceiptUpdate,
} from "../src/lib/mappers";

const { prisma } = await import("../src/lib/prisma");
const { createChatServer } = await import("../src/server");

/* ------------------------------------------------------------------ */
/* Test harness                                                        */
/* ------------------------------------------------------------------ */

/**
 * Remote databases (Neon) add hundreds of milliseconds per round trip and the
 * pooled endpoint carries a cold-start penalty, so event waits get a generous
 * budget by default. Override with SMOKE_TIMEOUT_MS against a local database.
 */
const EVENT_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 25_000);

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
  }
}

interface HttpResult {
  status: number;
  json: any;
}

async function http(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

interface SocketAckResponse<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

function sendWithAck<T = unknown>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<SocketAckResponse<T>> {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload, (err: unknown, response: SocketAckResponse<T>) => {
      if (err) {
        resolve({ ok: false, error: { code: "ack_timeout", message: String(err) } });
      } else {
        resolve(response);
      }
    });
  });
}

function nextEvent<T = any>(
  socket: Socket,
  event: string,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const sockets: Socket[] = [];

function connectUser(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
    });
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error("socket connect timeout")), EVENT_TIMEOUT_MS);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      reject(new Error(`connect_error: ${String(error)}`));
    });
  });
}

/* ------------------------------------------------------------------ */
/* Data management                                                     */
/* ------------------------------------------------------------------ */

const RUN = Date.now().toString(36);

interface RegisterResult {
  user: PublicUser;
  token: string;
  expiresAt: string;
}

async function registerUser(name: string, displayName: string): Promise<RegisterResult> {
  const res = await http("POST", "/api/auth/register", {
    body: {
      email: `${name}@example.test`,
      username: name,
      password: "Passw0rd!123",
      displayName,
    },
  });
  if (res.status !== 201) {
    throw new Error(`register ${name} failed (${res.status}): ${JSON.stringify(res.json)}`);
  }
  return res.json as RegisterResult;
}

async function cleanup(): Promise<void> {
  // Conversations cascade to messages, members, reads, typing rows.
  await prisma.conversation.deleteMany({
    where: { members: { some: { user: { username: { startsWith: "sm_" } } } } },
  });
  await prisma.user.deleteMany({ where: { username: { startsWith: "sm_" } } });
}

/* ------------------------------------------------------------------ */
/* Scenario                                                            */
/* ------------------------------------------------------------------ */

let baseUrl = "";
let port = 0;

async function main(): Promise<void> {
  console.log("Cleaning up any previous smoke data...");
  await cleanup();

  const server = await createChatServer();
  port = await server.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Smoke server listening on ${baseUrl}\n`);

  let scenarioError: unknown = null;
  try {
    await runScenario();
  } catch (error) {
    scenarioError = error;
  }

  for (const socket of sockets.splice(0)) socket.disconnect();
  // Tear down in this order: `shutdown()` drains the database pool that the
  // final cleanup pass still needs.
  await cleanup().catch((error) =>
    console.warn("Final cleanup failed:", error instanceof Error ? error.message : error),
  );
  await server.shutdown().catch(() => undefined);
  console.log("Smoke data cleaned up.");

  if (scenarioError) throw scenarioError;
}

async function runScenario(): Promise<void> {
  /* --- Health & auth ------------------------------------------------ */
  console.log("1. Health & authentication");
  const health = await http("GET", "/health");
  check("GET /health returns 200", health.status === 200, health);

  const alice = await registerUser(`sm_a_${RUN}`, "Alice Smoke");
  const bob = await registerUser(`sm_b_${RUN}`, "Bob Smoke");
  const carol = await registerUser(`sm_c_${RUN}`, "Carol Smoke");
  const dave = await registerUser(`sm_d_${RUN}`, "Dave Smoke");
  check("register returns user + token", Boolean(alice.token && bob.token && carol.token && dave.token));

  const dup = await http("POST", "/api/auth/register", {
    body: { email: `other_${RUN}@example.test`, username: `sm_a_${RUN}`, password: "Passw0rd!123" },
  });
  check("duplicate username rejected (409)", dup.status === 409, dup);

  const badLogin = await http("POST", "/api/auth/login", {
    body: { identifier: `sm_a_${RUN}`, password: "wrong-password" },
  });
  check("bad password rejected (401)", badLogin.status === 401, badLogin);

  const aliceLogin = await http("POST", "/api/auth/login", {
    body: { identifier: `sm_a_${RUN}@example.test`, password: "Passw0rd!123" },
  });
  check("login by email works (200)", aliceLogin.status === 200, aliceLogin);

  const unauth = await http("GET", "/api/users/me");
  check("unauthenticated request rejected (401)", unauth.status === 401, unauth);

  const me = await http("GET", "/api/users/me", { token: alice.token });
  check("GET /api/users/me returns profile", me.status === 200 && me.json.user.id === alice.user.id, me);

  const search = await http("GET", `/api/users/search?q=${RUN}&limit=10`, { token: alice.token });
  check(
    "user search finds smoke users",
    search.status === 200 &&
      search.json.users.length >= 3 &&
      search.json.users.some((u: PublicUser) => u.username === `sm_b_${RUN}`),
    search,
  );

  /* --- Sockets & direct conversation -------------------------------- */
  console.log("2. Realtime connections & direct conversation");
  const aliceSocket = await connectUser(alice.token);
  const bobSocket = await connectUser(bob.token);
  check("both users connected via websocket", aliceSocket.connected && bobSocket.connected);

  const bobConvNew = nextEvent<{ conversation: ConversationDTO }>(bobSocket, "conversation:new");
  const direct = await http("POST", "/api/conversations/direct", {
    token: alice.token,
    body: { userId: bob.user.id },
  });
  check("direct conversation created (201)", direct.status === 201, direct);
  const directConv: ConversationDTO = direct.json.conversation;
  check("direct conversation has both members", directConv.members.length === 2);
  check("recipient receives conversation:new", (await bobConvNew).conversation.id === directConv.id);

  const directAgain = await http("POST", "/api/conversations/direct", {
    token: bob.token,
    body: { userId: alice.user.id },
  });
  check(
    "direct conversation is idempotent (same id)",
    directAgain.status === 201 && directAgain.json.conversation.id === directConv.id,
    directAgain,
  );

  const aliceTyping = nextEvent<{ userId: string; isTyping: boolean }>(aliceSocket, "typing:update");
  await sendWithAck(bobSocket, "typing:start", { conversationId: directConv.id });
  check("typing:update (start) delivered", (await aliceTyping).isTyping === true);

  const aliceTypingStop = nextEvent<{ isTyping: boolean }>(aliceSocket, "typing:update");
  await sendWithAck(bobSocket, "typing:stop", { conversationId: directConv.id });
  check("typing:update (stop) delivered", (await aliceTypingStop).isTyping === false);

  /* --- Messaging & receipts ------------------------------------------ */
  console.log("3. Messaging, delivery & read receipts");
  const bobMsgNew = nextEvent<{ message: MessageDTO }>(bobSocket, "message:new");
  const sendAck = await sendWithAck<MessageDTO>(aliceSocket, "message:send", {
    conversationId: directConv.id,
    body: "Hello Bob!",
  });
  check("message:send ack returns message", sendAck.ok && sendAck.data?.body === "Hello Bob!", sendAck);
  const msg1 = sendAck.data as MessageDTO;
  check("recipient receives message:new", (await bobMsgNew).message.id === msg1.id);

  const bobList = await http("GET", "/api/conversations", { token: bob.token });
  const bobDirect = bobList.json.conversations.find((c: ConversationDTO) => c.id === directConv.id);
  check("unread count is 1 for recipient", bobDirect?.unreadCount === 1, bobList.json);

  const deliveredReceipt = nextEvent<ReceiptUpdate>(aliceSocket, "receipts:update");
  await sendWithAck(bobSocket, "message:delivered", { conversationId: directConv.id });
  const delivered = await deliveredReceipt;
  check(
    "delivery receipt reaches sender",
    delivered.deliveredAt !== undefined && delivered.messageIds.includes(msg1.id),
    delivered,
  );

  const readReceipt = nextEvent<ReceiptUpdate>(aliceSocket, "receipts:update");
  await sendWithAck(bobSocket, "message:read", { conversationId: directConv.id });
  const read = await readReceipt;
  check("read receipt reaches sender", read.readAt !== undefined && read.messageIds.includes(msg1.id), read);

  const bobListAfterRead = await http("GET", "/api/conversations", { token: bob.token });
  const bobDirectAfterRead = bobListAfterRead.json.conversations.find(
    (c: ConversationDTO) => c.id === directConv.id,
  );
  check("unread count cleared after read", bobDirectAfterRead?.unreadCount === 0);

  const bobMsg2Res = await http("POST", `/api/conversations/${directConv.id}/messages`, {
    token: bob.token,
    body: { body: "Reply over REST" },
  });
  check("REST message send works (201)", bobMsg2Res.status === 201, bobMsg2Res);

  const aliceList = await http("GET", "/api/conversations", { token: alice.token });
  const aliceDirect = aliceList.json.conversations.find(
    (c: ConversationDTO) => c.id === directConv.id,
  );
  check("alice unread count is 1", aliceDirect?.unreadCount === 1, aliceList.json);

  const bobReceiptFromAlice = nextEvent<ReceiptUpdate>(bobSocket, "receipts:update");
  const aliceRead = await http("POST", `/api/conversations/${directConv.id}/read`, {
    token: alice.token,
    body: {},
  });
  check("REST mark-read works (200)", aliceRead.status === 200, aliceRead);
  check("bob receives read receipt from alice", (await bobReceiptFromAlice).readAt !== undefined);

  const aliceListAfterRead = await http("GET", "/api/conversations", { token: alice.token });
  const aliceDirectAfterRead = aliceListAfterRead.json.conversations.find(
    (c: ConversationDTO) => c.id === directConv.id,
  );
  check("alice unread count cleared", aliceDirectAfterRead?.unreadCount === 0);

  /* --- Group conversations & notifications ---------------------------- */
  console.log("4. Group conversations & notifications");
  const bobGroupNew = nextEvent<{ conversation: ConversationDTO }>(bobSocket, "conversation:new");
  const bobNotif = nextEvent<{ notification: NotificationDTO }>(bobSocket, "notification:new");
  const group = await http("POST", "/api/conversations/group", {
    token: alice.token,
    body: { title: "Smoke Squad", memberIds: [bob.user.id, carol.user.id] },
  });
  check("group created (201)", group.status === 201, group);
  const groupConv: ConversationDTO = group.json.conversation;
  check("group has 3 members, alice is OWNER", groupConv.members.length === 3 && groupConv.myRole === "OWNER");

  const bobNotifData = await bobNotif;
  check(
    "bob receives GROUP_INVITE notification",
    bobNotifData.notification.type === "GROUP_INVITE" &&
      (bobNotifData.notification.payload as any)?.conversationId === groupConv.id,
    bobNotifData,
  );
  check("bob receives conversation:new for group", (await bobGroupNew).conversation.id === groupConv.id);

  const bobNotifs = await http("GET", "/api/notifications", { token: bob.token });
  check(
    "REST notifications include MESSAGE + GROUP_INVITE",
    bobNotifs.status === 200 &&
      bobNotifs.json.notifications.some((n: NotificationDTO) => n.type === "MESSAGE") &&
      bobNotifs.json.notifications.some((n: NotificationDTO) => n.type === "GROUP_INVITE"),
    bobNotifs.json,
  );
  const bobUnreadNotifs = await http("GET", "/api/notifications/unread-count", { token: bob.token });
  check("unread notification count >= 2", bobUnreadNotifs.json.count >= 2, bobUnreadNotifs.json);

  const carolSocket = await connectUser(carol.token);

  const carolMsgNew = nextEvent<{ message: MessageDTO }>(carolSocket, "message:new");
  const carolNotif = nextEvent<{ notification: NotificationDTO }>(carolSocket, "notification:new");
  const groupMsg = await sendWithAck<MessageDTO>(bobSocket, "message:send", {
    conversationId: groupConv.id,
    body: "Group hello!",
  });
  check("group message sent via socket", groupMsg.ok && groupMsg.data?.body === "Group hello!", groupMsg);
  const groupMsgDto = groupMsg.data as MessageDTO;
  check("carol receives group message:new", (await carolMsgNew).message.id === groupMsgDto.id);
  check(
    "carol receives MESSAGE notification",
    (await carolNotif).notification.type === "MESSAGE",
  );

  const bobGroupReadReceipt = nextEvent<ReceiptUpdate>(bobSocket, "receipts:update");
  await sendWithAck(carolSocket, "message:read", { conversationId: groupConv.id });
  const groupRead = await bobGroupReadReceipt;
  check("bob sees carol's read receipt", groupRead.readAt !== undefined && groupRead.messageIds.includes(groupMsgDto.id), groupRead);

  /* --- Edit & delete (moderation) ------------------------------------- */
  console.log("5. Edit & delete with moderation rules");
  const carolMsgUpdate = nextEvent<{ message: MessageDTO }>(carolSocket, "message:update");
  const bobEdit = await http("PATCH", `/api/messages/${groupMsgDto.id}`, {
    token: bob.token,
    body: { body: "Group hello (edited)" },
  });
  check("sender edits own message (200)", bobEdit.status === 200 && bobEdit.json.message.editedAt !== null, bobEdit);
  check("carol receives message:update (edit)", (await carolMsgUpdate).message.body === "Group hello (edited)");

  const aliceEditBob = await http("PATCH", `/api/messages/${groupMsgDto.id}`, {
    token: alice.token,
    body: { body: "hijack" },
  });
  check("non-sender edit rejected (403)", aliceEditBob.status === 403, aliceEditBob);

  const carolMsgDelete = nextEvent<{ message: MessageDTO }>(carolSocket, "message:update");
  const aliceDelete = await http("DELETE", `/api/messages/${groupMsgDto.id}`, { token: alice.token });
  check(
    "group owner deletes member's message (200)",
    aliceDelete.status === 200 &&
      aliceDelete.json.message.deletedAt !== null &&
      aliceDelete.json.message.body === null,
    aliceDelete,
  );
  check("carol receives message:update (delete)", (await carolMsgDelete).message.deletedAt !== null);

  const aliceMsgRes = await http("POST", `/api/conversations/${groupConv.id}/messages`, {
    token: alice.token,
    body: { body: "Owner message" },
  });
  const aliceMsg = aliceMsgRes.json.message as MessageDTO;
  const bobDeleteAlice = await http("DELETE", `/api/messages/${aliceMsg.id}`, { token: bob.token });
  check("member cannot delete other's message (403)", bobDeleteAlice.status === 403, bobDeleteAlice);
  const aliceSelfDelete = await http("DELETE", `/api/messages/${aliceMsg.id}`, { token: alice.token });
  check("sender deletes own message (200)", aliceSelfDelete.status === 200);

  const history = await http(
    "GET",
    `/api/conversations/${groupConv.id}/messages?limit=50`,
    { token: bob.token },
  );
  check(
    "history contains tombstone with redacted content",
    history.status === 200 &&
      history.json.messages.some((m: MessageDTO) => m.id === groupMsgDto.id && m.deletedAt !== null && m.body === null),
    history.json,
  );

  /* --- Message history pagination -------------------------------------- */
  console.log("6. Message history pagination");
  for (let i = 1; i <= 5; i += 1) {
    await http("POST", `/api/conversations/${groupConv.id}/messages`, {
      token: bob.token,
      body: { body: `Page test ${i}` },
    });
  }

  const page1 = await http("GET", `/api/conversations/${groupConv.id}/messages?limit=3`, {
    token: bob.token,
  });
  check(
    "page 1 returns limit with cursor",
    page1.status === 200 &&
      page1.json.messages.length === 3 &&
      typeof page1.json.nextCursor === "string",
    page1.json,
  );
  const p1: MessageDTO[] = page1.json.messages;
  check(
    "page 1 ordered newest-first",
    p1[0].createdAt >= p1[1].createdAt && p1[1].createdAt >= p1[2].createdAt,
  );

  const page2 = await http(
    "GET",
    `/api/conversations/${groupConv.id}/messages?limit=3&before=${encodeURIComponent(page1.json.nextCursor)}`,
    { token: bob.token },
  );
  const p2: MessageDTO[] = page2.json.messages;
  check("page 2 returns messages", page2.status === 200 && p2.length === 3);
  check("pages do not overlap", !p1.some((m) => p2.some((x) => x.id === m.id)));

  /* --- Group membership management -------------------------------------- */
  console.log("7. Group membership management");
  const bobAdd = await http("POST", `/api/conversations/${groupConv.id}/members`, {
    token: bob.token,
    body: { userIds: [dave.user.id] },
  });
  check("plain member cannot add users (403)", bobAdd.status === 403, bobAdd);

  const aliceAdd = await http("POST", `/api/conversations/${groupConv.id}/members`, {
    token: alice.token,
    body: { userIds: [dave.user.id] },
  });
  check(
    "owner adds member (200, now 4 members)",
    aliceAdd.status === 200 && aliceAdd.json.conversation.members.length === 4,
    aliceAdd,
  );

  const daveLogin = await http("POST", "/api/auth/login", {
    body: { identifier: `sm_d_${RUN}`, password: "Passw0rd!123" },
  });
  check("dave can login", daveLogin.status === 200);
  const daveLeave = await http("POST", `/api/conversations/${groupConv.id}/leave`, {
    token: daveLogin.json.token,
  });
  check("member leaves group (204)", daveLeave.status === 204, daveLeave);

  const carolRemoved = nextEvent<{ conversationId: string; reason: string }>(
    carolSocket,
    "conversation:removed",
    EVENT_TIMEOUT_MS,
  );
  const aliceRemove = await http(
    "DELETE",
    `/api/conversations/${groupConv.id}/members/${carol.user.id}`,
    { token: alice.token },
  );
  check("owner removes member (200)", aliceRemove.status === 200, aliceRemove);
  const removedEvent = await carolRemoved.catch(() => null);
  check(
    "carol receives conversation:removed",
    removedEvent !== null && removedEvent.reason === "removed",
    removedEvent,
  );

  // Dave left and Carol was removed, so only the owner and Bob remain active.
  const groupAfterRemoval = await http("GET", `/api/conversations/${groupConv.id}`, {
    token: alice.token,
  });
  const activeMemberIds = (groupAfterRemoval.json.conversation.members as Array<{ userId: string }>)
    .map((member) => member.userId)
    .sort();
  check(
    "group membership is exactly owner + bob after the leave and the removal",
    groupAfterRemoval.status === 200 &&
      activeMemberIds.length === 2 &&
      activeMemberIds.includes(alice.user.id) &&
      activeMemberIds.includes(bob.user.id),
    groupAfterRemoval.json,
  );

  const bobTitle = await http("PATCH", `/api/conversations/${groupConv.id}`, {
    token: bob.token,
    body: { title: "Bob was here" },
  });
  check("member cannot rename group (403)", bobTitle.status === 403, bobTitle);

  const aliceTitle = await http("PATCH", `/api/conversations/${groupConv.id}`, {
    token: alice.token,
    body: { title: "Smoke Squad v2" },
  });
  check("owner renames group (200)", aliceTitle.status === 200 && aliceTitle.json.conversation.title === "Smoke Squad v2");

  /* --- Presence --------------------------------------------------------- */
  console.log("8. Online/offline presence");
  // Carol was removed from the group above, so she and Alice no longer share a
  // conversation — and presence is only ever broadcast to conversation
  // partners. Give Alice a fresh direct conversation with Dave and assert on
  // him instead.
  const daveDirect = await http("POST", "/api/conversations/direct", {
    token: alice.token,
    body: { userId: dave.user.id },
  });
  check("alice opens a direct conversation with dave (201)", daveDirect.status === 201, daveDirect);

  const alicePresence = nextEvent<{ userId: string; isOnline: boolean }>(
    aliceSocket,
    "presence:update",
  );
  const daveSocket = await connectUser(daveLogin.json.token);
  const presenceEvent = await alicePresence;
  check(
    "contacts see dave come online",
    presenceEvent.userId === dave.user.id && presenceEvent.isOnline === true,
    presenceEvent,
  );

  const aliceOfflineEvent = nextEvent<{ userId: string; isOnline: boolean; lastSeenAt: string | null }>(
    aliceSocket,
    "presence:update",
    EVENT_TIMEOUT_MS,
  );
  daveSocket.disconnect();
  const offlineEvent = await aliceOfflineEvent;
  check(
    "contacts see dave go offline after grace period",
    offlineEvent.userId === dave.user.id && offlineEvent.isOnline === false,
    offlineEvent,
  );

  const daveProfile = await http("GET", `/api/users/${dave.user.username}`, { token: bob.token });
  check(
    "DB reflects offline state with lastSeenAt",
    daveProfile.status === 200 &&
      daveProfile.json.user.isOnline === false &&
      daveProfile.json.user.lastSeenAt !== null,
    daveProfile.json,
  );

  /* --- Group deletion & access ------------------------------------------ */
  console.log("9. Group deletion & post-delete access");
  const bobGroupDeleted = nextEvent<{ reason: string }>(bobSocket, "conversation:removed");
  const deleteGroup = await http("DELETE", `/api/conversations/${groupConv.id}`, {
    token: alice.token,
  });
  check("owner deletes group (204)", deleteGroup.status === 204, deleteGroup);
  check("member receives conversation:removed (deleted)", (await bobGroupDeleted).reason === "deleted");

  const bobGetDeleted = await http("GET", `/api/conversations/${groupConv.id}`, { token: bob.token });
  check("deleted group is gone (404)", bobGetDeleted.status === 404, bobGetDeleted);

  const sendToDeleted = await sendWithAck(bobSocket, "message:send", {
    conversationId: groupConv.id,
    body: "ghost",
  });
  check(
    "socket send to deleted group rejected",
    !sendToDeleted.ok && sendToDeleted.error?.code === "conversation_not_found",
    sendToDeleted,
  );

  /* --- Logout & session revocation --------------------------------------- */
  console.log("10. Logout & session revocation");
  aliceSocket.disconnect();
  bobSocket.disconnect();

  const logout = await http("POST", "/api/auth/logout", { token: alice.token });
  check("logout succeeds (204)", logout.status === 204, logout);
  const meAfterLogout = await http("GET", "/api/users/me", { token: alice.token });
  check("revoked token rejected (401)", meAfterLogout.status === 401, meAfterLogout);

  await http("POST", "/api/notifications/read-all", { token: bob.token });
  const bobUnreadAfter = await http("GET", "/api/notifications/unread-count", { token: bob.token });
  check("mark-all-read clears notifications", bobUnreadAfter.json.count === 0, bobUnreadAfter.json);
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

main()
  .then(() => {
    console.log(`\n=== Smoke results: ${passed} passed, ${failures.length} failed ===`);
    if (failures.length > 0) {
      console.log("Failed checks:");
      for (const failure of failures) console.log(`  - ${failure}`);
    }
    process.exit(failures.length > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("Smoke test crashed:", error);
    process.exit(1);
  });
