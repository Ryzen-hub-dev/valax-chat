import assert from "node:assert/strict";
import { File } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { handleApiRequest } from "../lib/api-router.js";
import { closeDatabase, ensureDatabaseIndexes, getDatabase } from "../lib/database.js";
import { encryptSecret } from "../lib/encryption.js";

// ─────────────────────────────────────────────────────────────────────────────
// 测试环境自给自足
//
// 【为什么】
// 之前这个套件需要**三个**外部配置才能跑：
//   MONGODB_URI / BOT_TOKEN_ENCRYPTION_KEY / DISCORD_CLIENT_ID + SECRET + REDIRECT_URI
// 缺任意一个就抛 `Missing required environment variable: X` ——
// 于是「开发者本地没配」= **整个测试套件 0 覆盖**。
//
// 现在：**测试自己生成**这些值（全部是测试专用的假值）。
//   · 内存 MongoDB（`lib/memory-db.js`）
//   · 随机的 32 字节加密密钥
//   · 假的 Discord client id / secret / redirect uri
//
// ⚠️ **绝不能**在这里用真凭据 —— 测试环境变量会覆盖部署环境的。
// ⚠️ 真实 OAuth 回调**不在**本套件的覆盖范围（见 README 的诚实边界）。
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env.BOT_TOKEN_ENCRYPTION_KEY) {
  process.env.BOT_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
}
if (!process.env.DISCORD_CLIENT_ID) process.env.DISCORD_CLIENT_ID = "1490000000000000001";
if (!process.env.DISCORD_CLIENT_SECRET) process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
if (!process.env.DISCORD_REDIRECT_URI) {
  process.env.DISCORD_REDIRECT_URI = "http://localhost:5173/api/callback";
}
if (!process.env.SITE_URL) process.env.SITE_URL = "http://localhost:5173";
// 强制走内存库（即使机器上有 MONGODB_URI）—— 测试不该碰真库
process.env.VALAX_DB_MODE = "memory";

const ids = {
  bot: "1492451629595627660",
  guild: "1490285060765515946",
  channel: "1490285060765515999",
  announceChannel: "1490285060765515888",
  dmChannel: "1492451629595627111",
  recipient: "1492451629595627001",
  message: "1492451629595627002",
  reply: "1492451629595627003",
  emoji: "1492451629595627004",
  sticker: "1492451629595627005",
};

const sessionToken = randomBytes(24).toString("base64url");
const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
const nowIso = new Date().toISOString();
let capturedChannelMessage = null;
let capturedDirectMessage = null;
let capturedChannelFile = null;
let capturedDirectFile = null;
let capturedCrosspost = false;
const seenRequests = [];

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(data); },
  };
}

function discordMessage(id, content, authorId = ids.bot) {
  return {
    id,
    type: 0,
    content,
    timestamp: nowIso,
    edited_timestamp: null,
    pinned: false,
    mention_everyone: false,
    author: { id: authorId, username: authorId === ids.bot ? "ValaxTest" : "Member", avatar: null, bot: authorId === ids.bot },
    mentions: [],
    attachments: [],
    sticker_items: [],
    embeds: [],
  };
}

async function discordPayload(init) {
  if (typeof init.body === "string") return { payload: JSON.parse(init.body), file: null };
  const payload = JSON.parse(init.body.get("payload_json"));
  return { payload, file: init.body.get("files[0]") };
}

const member = {
  nick: "Test Member",
  joined_at: nowIso,
  roles: [],
  user: { id: ids.recipient, username: "member", global_name: "Test Member", avatar: null, bot: false },
};

// ⚠️ **测试用户的服务器权限位**（由测试改，用来验证权限判据）。
//    "8"  = Administrator（0x08）
//    "32" = Manage Server（0x20）
//    "0"  = 没有任何管理权限
let userGuildPermissions = "32";

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const path = `${url.pathname}${url.search}`;
  const method = (init.method || "GET").toUpperCase();
  seenRequests.push(`${method} ${path}`);

  // ⚠️ **必须区分 bot token 和 user token** ——
  //    `GET /users/@me/guilds` 用谁的 token 发，返回的就是谁的权限位：
  //      · `Authorization: Bot <token>`    → bot 角色的权限位
  //      · `Authorization: Bearer <token>` → **用户本人**的权限位
  //    两者混在一起 → 权限提升（用户没权限但 bot 有，就以为用户能管）。
  const authHeader = String(init.headers?.Authorization || init.headers?.authorization || "");
  const isUserToken = authHeader.startsWith("Bearer ");

  if (path.startsWith("/api/v10/users/@me/guilds")) {
    if (isUserToken) {
      // 用户 token —— 返回**用户**自己的权限位
      return json([
        { id: ids.guild, name: "Valax Test Guild", icon: null, permissions: userGuildPermissions },
      ]);
    }
    // bot token —— 返回 bot 角色的权限位
    return json([{ id: ids.guild, name: "Valax Test Guild", icon: null, permissions: "8" }]);
  }
  if (path === `/api/v10/guilds/${ids.guild}/channels`) {
    return json([
      { id: ids.channel, guild_id: ids.guild, name: "general", type: 0, position: 0, parent_id: null },
      { id: ids.announceChannel, guild_id: ids.guild, name: "announcements", type: 5, position: 1, parent_id: null },
    ]);
  }
  if (path === `/api/v10/guilds/${ids.guild}/emojis`) {
    return json([{ id: ids.emoji, name: "valax_wave", animated: true, available: true }]);
  }
  if (path === `/api/v10/guilds/${ids.guild}/stickers`) {
    return json([{ id: ids.sticker, name: "Valax hello", description: "Hello", format_type: 2, available: true }]);
  }
  if (path === `/api/v10/stickers/${ids.sticker}`) {
    return json({ id: ids.sticker, guild_id: ids.guild, name: "Valax hello", description: "Hello", format_type: 2, available: true });
  }
  if (path.startsWith(`/api/v10/guilds/${ids.guild}/members/search`)) return json([member]);
  if (path.startsWith(`/api/v10/guilds/${ids.guild}/members?`)) return json([member]);
  if (path === `/api/v10/guilds/${ids.guild}/members/${ids.recipient}`) return json(member);
  if (path === `/api/v10/channels/${ids.channel}`) {
    return json({ id: ids.channel, guild_id: ids.guild, name: "general", type: 0 });
  }
  if (path === `/api/v10/channels/${ids.announceChannel}`) {
    return json({ id: ids.announceChannel, guild_id: ids.guild, name: "announcements", type: 5 });
  }
  // crosspost —— 公告频道（type 5）才转发成功
  if (path.startsWith(`/api/v10/channels/${ids.announceChannel}/messages/`) && path.endsWith("/crosspost")) {
    capturedCrosspost = true;
    return json({ id: ids.reply, type: 0, content: "announcement" });
  }
  if (path === `/api/v10/channels/${ids.announceChannel}/messages` && method === "POST") {
    const decoded = await discordPayload(init);
    capturedChannelMessage = decoded.payload;
    capturedChannelFile = decoded.file;
    return json(discordMessage(ids.reply, capturedChannelMessage.content));
  }
  if (path.startsWith(`/api/v10/channels/${ids.channel}/messages?`)) {
    return json([discordMessage(ids.message, "Recent message", ids.recipient)]);
  }
  if (path === `/api/v10/channels/${ids.channel}/messages/${ids.message}`) {
    return json({
      ...discordMessage(ids.message, `<a:valax_wave:${ids.emoji}>`, ids.recipient),
      sticker_items: [{ id: ids.sticker, name: "Valax hello", format_type: 2 }],
    });
  }
  if (path === `/api/v10/channels/${ids.channel}/messages` && method === "POST") {
    const decoded = await discordPayload(init);
    capturedChannelMessage = decoded.payload;
    capturedChannelFile = decoded.file;
    return json({
      ...discordMessage(ids.reply, capturedChannelMessage.content),
      attachments: capturedChannelFile ? [{
        id: String(BigInt(ids.reply) + 10n),
        filename: capturedChannelFile.name,
        url: "https://cdn.discordapp.com/attachments/test/upload.png",
        content_type: capturedChannelFile.type,
        size: capturedChannelFile.size,
      }] : [],
      sticker_items: (capturedChannelMessage.sticker_ids || []).map((id) => ({ id, name: "Valax hello", format_type: 2 })),
      mentions: (capturedChannelMessage.allowed_mentions?.users || []).map((id) => ({
        id,
        username: "member",
        global_name: "Test Member",
        avatar: null,
        bot: false,
      })),
      referenced_message: discordMessage(ids.message, "Original", ids.recipient),
    });
  }
  if (path === "/api/v10/users/@me/channels" && method === "POST") {
    return json({ id: ids.dmChannel, type: 1, recipients: [member.user] });
  }
  if (path.startsWith(`/api/v10/channels/${ids.dmChannel}/messages?`)) return json([]);
  if (path === `/api/v10/channels/${ids.dmChannel}/messages` && method === "POST") {
    const decoded = await discordPayload(init);
    capturedDirectMessage = decoded.payload;
    capturedDirectFile = decoded.file;
    return json({
      ...discordMessage(String(BigInt(ids.reply) + 1n), capturedDirectMessage.content),
      attachments: capturedDirectFile ? [{
        id: String(BigInt(ids.reply) + 11n),
        filename: capturedDirectFile.name,
        url: "https://cdn.discordapp.com/attachments/test/private.png",
        content_type: capturedDirectFile.type,
        size: capturedDirectFile.size,
      }] : [],
    });
  }
  throw new Error(`Unhandled Discord mock: ${method} ${path}`);
};

class TestResponse {
  statusCode = 200;
  headers = {};
  body = "";

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  getHeader(name) {
    return this.headers[name];
  }

  end(body = "") {
    this.body = String(body);
  }
}

async function call(method, url, body) {
  const request = Readable.from([]);
  request.method = method;
  request.url = url;
  request.headers = { host: "localhost", cookie: `valax_session=${sessionToken}` };
  if (body !== undefined) request.body = body;
  const response = new TestResponse();
  await handleApiRequest(request, response);
  return { status: response.statusCode, payload: response.body ? JSON.parse(response.body) : null };
}

async function callMultipart(url, payload, file) {
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  form.append("file", file, file.name);
  const encoded = new Request("http://localhost/upload", { method: "POST", body: form });
  const request = Readable.from([Buffer.from(await encoded.arrayBuffer())]);
  request.method = "POST";
  request.url = url;
  request.headers = {
    host: "localhost",
    cookie: `valax_session=${sessionToken}`,
    "content-type": encoded.headers.get("content-type"),
  };
  const response = new TestResponse();
  await handleApiRequest(request, response);
  return { status: response.statusCode, payload: response.body ? JSON.parse(response.body) : null };
}

let database;
let user;
try {
  await ensureDatabaseIndexes();
  database = await getDatabase();
  user = await database.collection("users").findOneAndUpdate(
    { discordId: `workflow-${Date.now()}` },
    {
      $set: {
        username: "workflow-test",
        globalName: "Workflow Test",
        avatarUrl: null,
        requiredGuildMember: true,
        // ⚠️ 必须有**用户的** OAuth token —— 权限检查靠它扫「用户自己的权限位」。
        //    没有它 → 权限检查降级 → 一律 403（fail-closed）。
        encryptedUserToken: encryptSecret("mock-user-token"),
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );
  await database.collection("sessions").insertOne({ tokenHash, userId: user._id, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
  await database.collection("botConnections").insertOne({
    userId: user._id,
    botId: ids.bot,
    applicationId: ids.bot,
    username: "ValaxTest",
    avatarUrl: null,
    encryptedToken: encryptSecret("mock-token"),
    intents: { presence: true, members: true, messageContent: true },
    guilds: [{ id: ids.guild, name: "Valax Test Guild", icon: null, administrator: true }],
    inviteUrl: "https://discord.com/oauth2/authorize?client_id=1492451629595627660",
    ready: true,
    verifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await database.collection("guildChecks").insertOne({
    userId: user._id,
    botId: ids.bot,
    guildId: ids.guild,
    available: true,
    testedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const dashboard = await call("GET", `/api/dashboard?botId=${ids.bot}`);
  assert.equal(dashboard.status, 200, `${JSON.stringify(dashboard.payload)} ${seenRequests.join(", ")}`);
  assert.equal(dashboard.payload.activeBotId, ids.bot);
  assert.equal(dashboard.payload.bots.length, 1);
  const consolidatedDashboard = await call(
    "GET",
    `/api/index?__valaxPath=dashboard&botId=${ids.bot}`
  );
  assert.equal(consolidatedDashboard.status, 200);
  assert.equal(consolidatedDashboard.payload.activeBotId, ids.bot);

  const members = await call("GET", `/api/server/members?guildId=${ids.guild}&botId=${ids.bot}`);
  assert.equal(members.status, 200);
  assert.equal(members.payload.members[0].id, ids.recipient);
  const rewrittenMembers = await call(
    "GET",
    `/api/server?__valaxRoute=members&guildId=${ids.guild}&botId=${ids.bot}`
  );
  assert.equal(rewrittenMembers.status, 200);
  assert.equal(rewrittenMembers.payload.members[0].id, ids.recipient);

  const expressionResponse = await call("GET", `/api/server/expressions?guildId=${ids.guild}&botId=${ids.bot}`);
  assert.equal(expressionResponse.status, 200);
  assert.equal(expressionResponse.payload.emojis[0].animated, true);
  assert.equal(expressionResponse.payload.stickers[0].id, ids.sticker);

  const savedEmoji = await call("POST", "/api/server/expression-library", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.channel,
    messageId: ids.message,
    expressionId: ids.emoji,
    type: "emoji",
  });
  assert.equal(savedEmoji.status, 201);
  assert.equal(savedEmoji.payload.expression.access, "available");
  const savedSticker = await call("POST", "/api/server/expression-library", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.channel,
    messageId: ids.message,
    expressionId: ids.sticker,
    type: "sticker",
  });
  assert.equal(savedSticker.status, 201);
  const expressionLibrary = await call("GET", `/api/server/expression-library?guildId=${ids.guild}&botId=${ids.bot}`);
  assert.equal(expressionLibrary.status, 200);
  assert.equal(expressionLibrary.payload.expressions.length, 2);
  const removedExpression = await call("DELETE", `/api/server/expression-library?guildId=${ids.guild}&botId=${ids.bot}`, {
    type: "emoji",
    expressionId: ids.emoji,
  });
  assert.equal(removedExpression.status, 200);

  const channelSend = await call("POST", "/api/server/messages", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.channel,
    content: `<@${ids.recipient}> status update`,
    mentionPolicy: "users",
    mentionIds: [ids.recipient],
    replyToId: ids.message,
    notifyReplyAuthor: true,
  });
  assert.equal(channelSend.status, 200);
  assert.deepEqual(capturedChannelMessage.allowed_mentions.users, [ids.recipient]);
  assert.equal(capturedChannelMessage.allowed_mentions.replied_user, true);
  assert.equal(capturedChannelMessage.message_reference.message_id, ids.message);
  assert.equal(channelSend.payload.mentionDelivery.resolved, 1);

  await database.collection("messageLogs").updateMany(
    { userId: user._id, botId: ids.bot, channelId: ids.channel },
    { $set: { createdAt: new Date(0) } }
  );
  const replyWithoutMentionPolicy = await call("POST", "/api/server/messages", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.channel,
    content: "Reply without a separate user mention",
    mentionPolicy: "none",
    replyToId: ids.message,
    notifyReplyAuthor: true,
  });
  assert.equal(replyWithoutMentionPolicy.status, 200);
  assert.deepEqual(capturedChannelMessage.allowed_mentions.parse, []);
  assert.equal(capturedChannelMessage.allowed_mentions.replied_user, true);
  assert.equal(replyWithoutMentionPolicy.payload.mentionDelivery.replyNotificationEnabled, true);

  await database.collection("messageLogs").updateMany(
    { userId: user._id, botId: ids.bot, channelId: ids.channel },
    { $set: { createdAt: new Date(0) } }
  );
  const stickerSend = await call("POST", "/api/server/messages", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.channel,
    content: "",
    stickerIds: [ids.sticker],
  });
  assert.equal(stickerSend.status, 200);
  assert.deepEqual(capturedChannelMessage.sticker_ids, [ids.sticker]);
  assert.equal(stickerSend.payload.message.stickers[0].id, ids.sticker);

  await database.collection("messageLogs").updateMany(
    { userId: user._id, botId: ids.bot, channelId: ids.channel },
    { $set: { createdAt: new Date(0) } }
  );
  const channelUpload = await callMultipart("/api/server/messages", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.channel,
    content: "Image update",
    mentionPolicy: "none",
  }, new File([Buffer.from("test-image")], "update.png", { type: "image/png" }));
  assert.equal(channelUpload.status, 200);
  assert.equal(capturedChannelFile.name, "update.png");
  assert.equal(channelUpload.payload.message.attachments[0].contentType, "image/png");

  const conversation = await call("GET", `/api/server/dm?guildId=${ids.guild}&botId=${ids.bot}&recipientId=${ids.recipient}`);
  assert.equal(conversation.status, 200);
  const directSend = await call("POST", "/api/server/dm", {
    guildId: ids.guild,
    botId: ids.bot,
    recipientId: ids.recipient,
    content: "Hello /@ from /server",
    timeZone: "Asia/Singapore",
  });
  assert.equal(directSend.status, 200);
  assert.match(capturedDirectMessage.content, new RegExp(`<@${ids.recipient}>`));
  assert.match(capturedDirectMessage.content, /Valax Test Guild/);

  await database.collection("messageLogs").updateMany(
    { userId: user._id, botId: ids.bot, recipientId: ids.recipient },
    { $set: { createdAt: new Date(0) } }
  );
  const directUpload = await callMultipart("/api/server/dm", {
    guildId: ids.guild,
    botId: ids.bot,
    recipientId: ids.recipient,
    content: "",
    timeZone: "UTC",
  }, new File([Buffer.from("private-image")], "private.png", { type: "image/png" }));
  assert.equal(directUpload.status, 200);
  assert.equal(capturedDirectFile.name, "private.png");
  const recentDirect = await call("GET", `/api/server/dm-recent?guildId=${ids.guild}&botId=${ids.bot}`);
  assert.equal(recentDirect.status, 200);
  assert.equal(recentDirect.payload.conversations[0].recipientId, ids.recipient);

  const settingsPut = await call("PUT", `/api/server/notifications?guildId=${ids.guild}&botId=${ids.bot}`, {
    settings: { enabled: true, browser: true, sounds: true, mentions: true, replies: true, directMessages: true, normalMessages: false, quietHours: { enabled: true, start: "23:00", end: "07:00" } },
  });
  assert.equal(settingsPut.status, 200);
  assert.equal(settingsPut.payload.settings.quietHours.start, "23:00");

  const preview = await call("POST", "/api/server/dm-campaigns", { action: "preview", guildId: ids.guild, botId: ids.bot });
  assert.equal(preview.status, 200);
  assert.equal(preview.payload.eligibleRecipients, 1);
  const created = await call("POST", "/api/server/dm-campaigns", {
    guildId: ids.guild,
    botId: ids.bot,
    content: "Campaign for /@",
    confirmation: "Valax Test Guild",
    timeZone: "UTC",
  });
  assert.equal(created.status, 201);
  const processed = await call("POST", "/api/server/dm-campaigns", { action: "process", campaignId: created.payload.campaign.id });
  assert.equal(processed.status, 200);
  assert.equal(processed.payload.campaign.status, "completed");
  assert.equal(processed.payload.campaign.sent, 1);

  // ─────────────────────────────────────────────────────────────────────────────
  // 权限回归（**这几个断言是本轮修复的核心**）
  //
  // 【钉死的是什么】
  // 「用户能不能管理这台服务器」必须由**用户自己的** token 查出来的权限位决定，
  // **不是** bot 角色的权限位。
  //
  // 【原来的 bug】
  // `GET /users/@me/guilds` 用 **bot token** 发 → 返回的 `permissions` 是
  // **bot 角色**的权限位。于是：
  //   用户对自己的服务器**没有** Manage Server，但 bot 在那台服务器有 Administrator
  //   → 用户照样能发消息、跑全员私信。**权限提升。**
  //
  // 【怎么证明测试是有效的】
  // 下面每一项都**必须能红**：把 `userCanManageGuild` 改回用 bot 的权限位，
  // 「用户无权限 → 403」这一项立刻会红。
  // ─────────────────────────────────────────────────────────────────────────────

  // ① 用户**有** Manage Server（0x20）→ 放行
  userGuildPermissions = "32";
  const manageAllowed = await call("GET", `/api/server/members?guildId=${ids.guild}&botId=${ids.bot}`);
  assert.equal(manageAllowed.status, 200, "Manage Server (0x20) 应该放行");

  // ② 用户**只有** Administrator（0x08）→ 也放行（Admin 蕴含一切）
  userGuildPermissions = "8";
  const adminAllowed = await call("GET", `/api/server/members?guildId=${ids.guild}&botId=${ids.bot}`);
  assert.equal(adminAllowed.status, 200, "Administrator (0x08) 应该放行");

  // ③ 用户**没有任何**管理权限（0x0）→ **必须 403**
  //    （bot 在这台服务器是 Administrator —— 这正是原来的漏洞场景）
  userGuildPermissions = "0";
  const noPermission = await call("GET", `/api/server/members?guildId=${ids.guild}&botId=${ids.bot}`);
  assert.equal(noPermission.status, 403, "用户没有 Manage Server 时必须 403");
  assert.equal(noPermission.payload.code, "GUILD_PERMISSION_DENIED");

  // ④ 写操作也必须被挡住（不只是读）
  const deniedSend = await call("POST", "/api/server/messages", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.channel,
    content: "should never be sent",
    timeZone: "UTC",
  });
  assert.equal(deniedSend.status, 403, "用户没有 Manage Server 时发消息必须 403");
  assert.equal(deniedSend.payload.code, "GUILD_PERMISSION_DENIED");

  // ⑤ 全员私信 campaign 也必须被挡住（最危险的操作）
  const deniedCampaign = await call("POST", "/api/server/dm-campaigns", {
    guildId: ids.guild,
    botId: ids.bot,
    content: "should never be sent",
    confirmation: "Valax Test Guild",
    timeZone: "UTC",
  });
  assert.equal(deniedCampaign.status, 403, "用户没有 Manage Server 时全员私信必须 403");

  // ⑥ Dashboard 如实报出「可管理台数」，且区分 bot 权限与用户权限
  userGuildPermissions = "32";
  const dashboardWithPermissions = await call("GET", "/api/dashboard?botId=" + ids.bot);
  assert.equal(dashboardWithPermissions.status, 200);
  assert.equal(dashboardWithPermissions.payload.guilds[0].userCanManage, true);
  assert.equal(dashboardWithPermissions.payload.guilds[0].administrator, true);
  assert.equal(dashboardWithPermissions.payload.summary.manageableCount, 1);
  assert.equal(dashboardWithPermissions.payload.permissionScan.ok, true);

  userGuildPermissions = "0";
  const dashboardWithoutPermissions = await call("GET", "/api/dashboard?botId=" + ids.bot);
  assert.equal(dashboardWithoutPermissions.status, 200);
  assert.equal(dashboardWithoutPermissions.payload.guilds[0].userCanManage, false);
  assert.equal(dashboardWithoutPermissions.payload.summary.manageableCount, 0);
  // ⚠️ bot 仍有 Administrator，但**用户**没有 → 必须「不可用」
  assert.equal(dashboardWithoutPermissions.payload.guilds[0].available, false);

  // ⑦ 用户 token 拿不到 → fail-closed（403），**不能**静默当成「有权限」
  userGuildPermissions = "32";
  await database.collection("users").updateOne(
    { _id: user._id },
    { $unset: { encryptedUserToken: "" } }
  );
  const noToken = await call("GET", `/api/server/members?guildId=${ids.guild}&botId=${ids.bot}`);
  assert.equal(noToken.status, 403, "拿不到用户 token 时必须 fail-closed");
  assert.equal(noToken.payload.code, "PERMISSION_CHECK_UNAVAILABLE");
  await database.collection("users").updateOne(
    { _id: user._id },
    { $set: { encryptedUserToken: encryptSecret("mock-user-token") } }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 公告端点回归
  // ─────────────────────────────────────────────────────────────────────────────
  // ① 频道公告 + crosspost（公告频道 type 5）
  capturedCrosspost = false;
  const announcement = await call("POST", "/api/server/announce", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.announceChannel,
    content: "Server announcement for /@guild",
    mentionPolicy: "all",
    crosspost: true,
  });
  assert.equal(announcement.status, 200, JSON.stringify(announcement.payload));
  assert.equal(announcement.payload.published, true, "公告频道应该 crosspost 成功");
  assert.equal(capturedCrosspost, true, "应该真的调用了 crosspost");
  assert.equal(announcement.payload.dm.queued, false, "没要求 DM 广播时不该排队");

  // ② 非公告频道 → 消息发了，但**如实说** crosspost 没成功
  capturedCrosspost = false;
  const plainAnnouncement = await call("POST", "/api/server/announce", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.channel,
    content: "Plain channel announcement",
    crosspost: true,
  });
  assert.equal(plainAnnouncement.status, 200);
  assert.equal(plainAnnouncement.payload.published, false, "普通频道不能 crosspost");
  assert.ok(plainAnnouncement.payload.crosspostError, "必须如实报出 crosspost 失败原因");

  // ③ DM 广播但**没确认服务器名** → 频道发成功，DM 如实报错（不假装全成功）
  const unconfirmed = await call("POST", "/api/server/announce", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.announceChannel,
    content: "Broadcast without confirmation",
    dmBroadcast: true,
  });
  assert.equal(unconfirmed.status, 200);
  assert.equal(unconfirmed.payload.dm.queued, false);
  assert.equal(unconfirmed.payload.dm.code, "CONFIRMATION_REQUIRED");

  // ④ DM 广播 + 确认服务器名
  //    ⚠️ 前面的 campaign 测试已经消耗掉了这台服务器的 **6 小时 DM 冷却**
  //    （`DM_CAMPAIGN_COOLDOWN_MS`）—— 这是**正确行为**，不是 bug。
  //    所以这里先断言「冷却确实拦住了」，再把历史 campaign 清掉验证「冷却后能排队」。
  const cooledDown = await call("POST", "/api/server/announce", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.announceChannel,
    content: "Full broadcast to everyone",
    dmBroadcast: true,
    confirmation: "Valax Test Guild",
  });
  assert.equal(cooledDown.status, 200, JSON.stringify(cooledDown.payload));
  assert.equal(cooledDown.payload.dm.queued, false);
  assert.equal(cooledDown.payload.dm.code, "CAMPAIGN_COOLDOWN");
  assert.ok(cooledDown.payload.dm.retryAfter > 0, "冷却要报出还要等多久");

  // 清掉历史 campaign，模拟「冷却已过」
  await database.collection("dmCampaigns").deleteMany({
    userId: user._id,
    botId: ids.bot,
    guildId: ids.guild,
  });
  const broadcast = await call("POST", "/api/server/announce", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.announceChannel,
    content: "Full broadcast to everyone",
    dmBroadcast: true,
    confirmation: "Valax Test Guild",
  });
  assert.equal(broadcast.status, 200, JSON.stringify(broadcast.payload));
  assert.equal(broadcast.payload.dm.queued, true, "确认后应该排上 DM 队列");
  assert.equal(broadcast.payload.dm.campaign.recipientCount, 1);

  // ⑤ 权限不足 → 公告也发不出去（公告是**最敏感**的操作，必须同样拦住）
  userGuildPermissions = "0";
  const deniedAnnouncement = await call("POST", "/api/server/announce", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.announceChannel,
    content: "should never be sent",
    dmBroadcast: true,
    confirmation: "Valax Test Guild",
  });
  assert.equal(deniedAnnouncement.status, 403, "用户没权限时公告必须 403");
  assert.equal(deniedAnnouncement.payload.code, "GUILD_PERMISSION_DENIED");
  userGuildPermissions = "32";

  // ⑥ 空内容 → 400
  const emptyAnnouncement = await call("POST", "/api/server/announce", {
    guildId: ids.guild,
    botId: ids.bot,
    channelId: ids.announceChannel,
    content: "   ",
  });
  assert.equal(emptyAnnouncement.status, 400);
  assert.equal(emptyAnnouncement.payload.code, "MESSAGE_LENGTH_INVALID");

  console.log("Valax saved-expression, media, mention, reply, DM, campaign, and notification workflows passed.");
  console.log("Valax per-user server permission enforcement (Manage Server / Administrator / fail-closed) passed.");
  console.log("Valax announcement endpoint (crosspost / DM broadcast / permission gate) passed.");
} finally {
  globalThis.fetch = originalFetch;
  if (database && user) {
    const filter = { userId: user._id };
    await Promise.all([
      database.collection("sessions").deleteMany(filter),
      database.collection("botConnections").deleteMany(filter),
      database.collection("guildChecks").deleteMany(filter),
      database.collection("messageLogs").deleteMany(filter),
      database.collection("notificationSettings").deleteMany(filter),
      database.collection("dmConversations").deleteMany(filter),
      database.collection("savedExpressions").deleteMany(filter),
      database.collection("dmCampaigns").deleteMany(filter),
      database.collection("dmDeliveryLogs").deleteMany(filter),
    ]);
    await database.collection("users").deleteOne({ _id: user._id });
  }
  await closeDatabase();
}
