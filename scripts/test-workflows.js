import assert from "node:assert/strict";
import { File } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { handleApiRequest } from "../lib/api-router.js";
import { closeDatabase, ensureDatabaseIndexes, getDatabase } from "../lib/database.js";
import { encryptSecret } from "../lib/encryption.js";

const ids = {
  bot: "1492451629595627660",
  guild: "1490285060765515946",
  channel: "1490285060765515999",
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

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const path = `${url.pathname}${url.search}`;
  const method = (init.method || "GET").toUpperCase();
  seenRequests.push(`${method} ${path}`);

  if (path === "/api/v10/users/@me/guilds?limit=200") {
    return json([{ id: ids.guild, name: "Valax Test Guild", icon: null, permissions: "8" }]);
  }
  if (path === `/api/v10/guilds/${ids.guild}/channels`) {
    return json([{ id: ids.channel, guild_id: ids.guild, name: "general", type: 0, position: 0, parent_id: null }]);
  }
  if (path === `/api/v10/guilds/${ids.guild}/emojis`) {
    return json([{ id: ids.emoji, name: "valax_wave", animated: true, available: true }]);
  }
  if (path === `/api/v10/guilds/${ids.guild}/stickers`) {
    return json([{ id: ids.sticker, name: "Valax hello", description: "Hello", format_type: 2, available: true }]);
  }
  if (path.startsWith(`/api/v10/guilds/${ids.guild}/members/search`)) return json([member]);
  if (path.startsWith(`/api/v10/guilds/${ids.guild}/members?`)) return json([member]);
  if (path === `/api/v10/guilds/${ids.guild}/members/${ids.recipient}`) return json(member);
  if (path === `/api/v10/channels/${ids.channel}`) {
    return json({ id: ids.channel, guild_id: ids.guild, name: "general", type: 0 });
  }
  if (path.startsWith(`/api/v10/channels/${ids.channel}/messages?`)) {
    return json([discordMessage(ids.message, "Recent message", ids.recipient)]);
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
      $set: { username: "workflow-test", globalName: "Workflow Test", avatarUrl: null, requiredGuildMember: true, updatedAt: new Date() },
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

  console.log("Valax multi-bot, media, expressions, mention, reply, DM, campaign, and notification workflows passed.");
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
      database.collection("dmCampaigns").deleteMany(filter),
      database.collection("dmDeliveryLogs").deleteMany(filter),
    ]);
    await database.collection("users").deleteOne({ _id: user._id });
  }
  await closeDatabase();
}
