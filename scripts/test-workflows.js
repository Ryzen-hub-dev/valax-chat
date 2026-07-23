import assert from "node:assert/strict";
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
};

const sessionToken = randomBytes(24).toString("base64url");
const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
const nowIso = new Date().toISOString();
let capturedChannelMessage = null;
let capturedDirectMessage = null;
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
    embeds: [],
  };
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
    capturedChannelMessage = JSON.parse(init.body);
    return json({
      ...discordMessage(ids.reply, capturedChannelMessage.content),
      referenced_message: discordMessage(ids.message, "Original", ids.recipient),
    });
  }
  if (path === "/api/v10/users/@me/channels" && method === "POST") {
    return json({ id: ids.dmChannel, type: 1, recipients: [member.user] });
  }
  if (path.startsWith(`/api/v10/channels/${ids.dmChannel}/messages?`)) return json([]);
  if (path === `/api/v10/channels/${ids.dmChannel}/messages` && method === "POST") {
    capturedDirectMessage = JSON.parse(init.body);
    return json(discordMessage(String(BigInt(ids.reply) + 1n), capturedDirectMessage.content));
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
  assert.equal(capturedChannelMessage.message_reference.message_id, ids.message);

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

  console.log("Valax multi-bot, mention, reply, DM, campaign, and notification workflows passed.");
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
      database.collection("dmCampaigns").deleteMany(filter),
      database.collection("dmDeliveryLogs").deleteMany(filter),
    ]);
    await database.collection("users").deleteOne({ _id: user._id });
  }
  await closeDatabase();
}
