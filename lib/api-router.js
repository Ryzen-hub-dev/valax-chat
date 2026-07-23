import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendCookie, parseCookies, serializeCookie } from "./cookies.js";
import { ensureDatabaseIndexes, getDatabase } from "./database.js";
import { getAuthConfig, getEncryptionKey } from "./env.js";
import { decryptSecret, encryptSecret } from "./encryption.js";

const SESSION_COOKIE = "valax_session";
const STATE_COOKIE = "valax_oauth_state";
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;
const DISCORD_API = "https://discord.com/api/v10";
const ADMINISTRATOR_PERMISSION = 8n;
const TEST_MESSAGE_FLAGS = 1 << 12;
const TEST_COOLDOWN_MS = 15_000;
const MESSAGE_COOLDOWN_MS = 1_500;
const DIRECT_MESSAGE_COOLDOWN_MS = 3_000;
const DM_CAMPAIGN_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const DM_RECIPIENT_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const MAX_CAMPAIGN_RECIPIENTS = 1_000;
const CAMPAIGN_BATCH_SIZE = 1;
const CHANNEL_CACHE_MS = 5 * 60 * 1_000;
const MESSAGE_CHANNEL_TYPES = new Set([0, 5]);
const INTENT_FLAGS = {
  presence: 1 << 12 | 1 << 13,
  members: 1 << 14 | 1 << 15,
  messageContent: 1 << 18 | 1 << 19,
};
const channelValidationCache = globalThis.__valaxChannelValidationCache || new Map();
globalThis.__valaxChannelValidationCache = channelValidationCache;

function requestUrl(request) {
  const host = request.headers.host || "localhost";
  const protocol = request.headers["x-forwarded-proto"] || "http";
  return new URL(request.url || "/", `${protocol}://${host}`);
}

function isSecureRequest(request) {
  const hostname = (request.headers.host || "").split(":")[0].toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return false;

  const forwardedProtocol = request.headers["x-forwarded-proto"];
  if (forwardedProtocol) return forwardedProtocol.split(",")[0].trim() === "https";

  try {
    return getAuthConfig().siteUrl.startsWith("https://");
  } catch {
    return false;
  }
}

function normalizeReturnTo(value) {
  if (!value || typeof value !== "string") return "/login?status=success";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/api")) {
    return "/login?status=success";
  }
  return value;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    return request.body;
  }

  let source = typeof request.body === "string"
    ? request.body
    : Buffer.isBuffer(request.body)
      ? request.body.toString("utf8")
      : "";

  if (!source) {
    for await (const chunk of request) {
      source += chunk;
      if (source.length > 8_192) throw new Error("Request body is too large.");
    }
  }

  if (!source) return {};
  return JSON.parse(source);
}

function redirect(response, location, statusCode = 302) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    Location: location,
  });
  response.end();
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function databaseErrorCode(error) {
  if (!(error instanceof Error)) return null;
  const details = `${error.name} ${error.message}`;

  if (/unresolved placeholder|MONGODB_URI|Invalid connection string/i.test(details)) {
    return "DATABASE_CONFIG_INVALID";
  }
  if (/authentication failed|bad auth|auth error/i.test(details)) {
    return "DATABASE_AUTH_FAILED";
  }
  if (/querysrv|enotfound|dns/i.test(details)) {
    return "DATABASE_DNS_FAILED";
  }
  if (/server selection|econnrefused|etimeout|timed out|MongoNetwork/i.test(details)) {
    return "DATABASE_NETWORK_BLOCKED";
  }
  if (error.name.startsWith("Mongo")) return "DATABASE_UNAVAILABLE";
  return null;
}

function configurationErrorCode(error) {
  if (!(error instanceof Error)) return null;
  if (/BOT_TOKEN_ENCRYPTION_KEY/i.test(error.message)) return "BOT_ENCRYPTION_CONFIG_INVALID";
  return null;
}

function databaseErrorMessage(code) {
  const messages = {
    DATABASE_CONFIG_INVALID: "The MongoDB connection string is not configured correctly.",
    DATABASE_AUTH_FAILED: "MongoDB rejected the configured database credentials.",
    DATABASE_DNS_FAILED: "The MongoDB cluster address could not be resolved.",
    DATABASE_NETWORK_BLOCKED: "MongoDB Atlas could not be reached from the server region.",
    DATABASE_UNAVAILABLE: "The database connection is temporarily unavailable.",
    BOT_ENCRYPTION_CONFIG_INVALID:
      "Bot credential encryption is not configured on this deployment. Add a valid BOT_TOKEN_ENCRYPTION_KEY and redeploy.",
  };
  return messages[code] || "The authentication service is temporarily unavailable.";
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function stateCookie(value, request, maxAge) {
  return serializeCookie(STATE_COOKIE, value, {
    httpOnly: true,
    maxAge,
    sameSite: "Lax",
    secure: isSecureRequest(request),
  });
}

function sessionCookie(value, request, maxAge) {
  return serializeCookie(SESSION_COOKIE, value, {
    httpOnly: true,
    maxAge,
    sameSite: "Lax",
    secure: isSecureRequest(request),
  });
}

function avatarUrl(user) {
  if (!user.avatar) return null;
  const extension = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128`;
}

function publicUser(user) {
  return {
    id: user.discordId,
    username: user.username,
    displayName: user.globalName || user.username,
    avatarUrl: user.avatarUrl,
    guildCount: user.guildCount || 0,
    requiredGuildMember: user.requiredGuildMember === true,
  };
}

async function beginDiscordLogin(request, response, url) {
  const config = getAuthConfig();
  const state = randomBytes(24).toString("base64url");
  const returnTo = normalizeReturnTo(url.searchParams.get("returnTo"));
  const statePayload = Buffer.from(JSON.stringify({ state, returnTo }), "utf8").toString("base64url");

  appendCookie(response, stateCookie(statePayload, request, 10 * 60));

  const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
  const authorizeParams = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "identify email guilds",
    state,
  });
  if (url.searchParams.get("prompt") === "none") authorizeParams.set("prompt", "none");
  authorizeUrl.search = authorizeParams.toString();

  redirect(response, authorizeUrl.toString());
}

async function completeDiscordLogin(request, response, url) {
  const errorCode = url.searchParams.get("error");
  if (errorCode) {
    redirect(response, `/login?error=${encodeURIComponent(errorCode)}`);
    return;
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const encodedState = parseCookies(request)[STATE_COOKIE];

  let savedState;
  try {
    savedState = JSON.parse(Buffer.from(encodedState || "", "base64url").toString("utf8"));
  } catch {
    savedState = null;
  }

  appendCookie(response, stateCookie("", request, 0));

  if (!code || !returnedState || !savedState || !safeEqual(returnedState, savedState.state)) {
    redirect(response, "/login?error=invalid_state");
    return;
  }

  const config = getAuthConfig();
  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
  });

  if (!tokenResponse.ok) throw new Error("Discord token exchange failed");
  const token = await tokenResponse.json();

  const discordHeaders = { Authorization: `Bearer ${token.access_token}` };
  const [userResponse, guildResponse] = await Promise.all([
    fetch("https://discord.com/api/users/@me", { headers: discordHeaders }),
    fetch("https://discord.com/api/users/@me/guilds", { headers: discordHeaders }),
  ]);

  if (!userResponse.ok) throw new Error("Discord user lookup failed");

  const discordUser = await userResponse.json();
  const guilds = guildResponse.ok ? await guildResponse.json() : [];
  const now = new Date();

  await ensureDatabaseIndexes();
  const database = await getDatabase();
  const user = await database.collection("users").findOneAndUpdate(
    { discordId: discordUser.id },
    {
      $set: {
        username: discordUser.username,
        globalName: discordUser.global_name || null,
        avatar: discordUser.avatar || null,
        avatarUrl: avatarUrl(discordUser),
        email: discordUser.email || null,
        locale: discordUser.locale || null,
        guildCount: Array.isArray(guilds) ? guilds.length : 0,
        requiredGuildMember: config.requiredGuildId
          ? guilds.some((guild) => guild.id === config.requiredGuildId)
          : null,
        lastLoginAt: now,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true, returnDocument: "after" }
  );

  const sessionToken = randomBytes(32).toString("base64url");
  await database.collection("sessions").insertOne({
    tokenHash: hashToken(sessionToken),
    userId: user._id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_LIFETIME_SECONDS * 1000),
  });

  appendCookie(response, sessionCookie(sessionToken, request, SESSION_LIFETIME_SECONDS));
  redirect(response, normalizeReturnTo(savedState.returnTo));
}

async function authenticatedContext(request, response) {
  const sessionToken = parseCookies(request)[SESSION_COOKIE];
  if (!sessionToken) return null;

  const database = await getDatabase();
  const session = await database.collection("sessions").findOne({
    tokenHash: hashToken(sessionToken),
    expiresAt: { $gt: new Date() },
  });

  if (!session) {
    appendCookie(response, sessionCookie("", request, 0));
    return null;
  }

  const user = await database.collection("users").findOne({ _id: session.userId });
  if (!user) {
    await database.collection("sessions").deleteOne({ _id: session._id });
    appendCookie(response, sessionCookie("", request, 0));
    return null;
  }

  return { database, session, user };
}

async function getSession(request, response) {
  const context = await authenticatedContext(request, response);
  if (!context) {
    sendJson(response, 200, { authenticated: false });
    return;
  }

  sendJson(response, 200, {
    authenticated: true,
    user: publicUser(context.user),
  });
}

function publicBotConnection(connection) {
  if (!connection) return null;
  return {
    botId: connection.botId,
    configured: true,
    bot: {
      id: connection.botId,
      applicationId: connection.applicationId,
      username: connection.username,
      avatarUrl: connection.avatarUrl || null,
    },
    intents: connection.intents,
    guilds: connection.guilds || [],
    inviteUrl: connection.inviteUrl,
    ready: connection.ready === true,
    verifiedAt: connection.verifiedAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function publicBotConnections(connections) {
  return (connections || []).filter(Boolean).map(publicBotConnection);
}

function validBotId(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value.trim()) ? value.trim() : "";
}

async function findSelectedBot(database, userId, botId) {
  const filter = { userId: userId };
  if (validBotId(botId)) filter.botId = validBotId(botId);
  return database.collection("botConnections").findOne(filter, { sort: { ready: -1, updatedAt: -1 } });
}

async function getOnboardingStatus(request, response) {
  const context = await authenticatedContext(request, response);
  if (!context) {
    sendJson(response, 401, { code: "AUTH_REQUIRED", authenticated: false });
    return;
  }

  const config = getAuthConfig();
  const connections = await context.database.collection("botConnections")
    .find({ userId: context.user._id })
    .sort({ ready: -1, updatedAt: -1 })
    .toArray();
  const connection = connections[0] || null;
  const membershipReady = context.user.requiredGuildMember === true;
  const botConnection = publicBotConnection(connection);

  sendJson(response, 200, {
    authenticated: true,
    user: publicUser(context.user),
    community: {
      id: config.requiredGuildId,
      name: "ValaxScrub",
      inviteUrl: `https://discord.gg/${config.inviteCode}`,
      iconUrl: "https://cdn.discordapp.com/icons/1490285060765515946/dc0b20c44964edf1c4160d9c3ca2d699.png?size=128",
      joined: membershipReady,
    },
    botConnection,
    botConnections: publicBotConnections(connections),
    currentStep: !membershipReady ? "community" : botConnection?.ready ? "complete" : "bot",
  });
}

function botHasAdministrator(guild) {
  try {
    return (BigInt(guild.permissions || "0") & ADMINISTRATOR_PERMISSION) === ADMINISTRATOR_PERMISSION;
  } catch {
    return false;
  }
}

function intentStatus(application) {
  const flags = Number(application.flags || 0);
  return {
    presence: (flags & INTENT_FLAGS.presence) !== 0,
    members: (flags & INTENT_FLAGS.members) !== 0,
    messageContent: (flags & INTENT_FLAGS.messageContent) !== 0,
  };
}

function botInviteUrl(applicationId) {
  const invite = new URL("https://discord.com/oauth2/authorize");
  invite.search = new URLSearchParams({
    client_id: applicationId,
    permissions: "8",
    scope: "bot applications.commands",
  }).toString();
  return invite.toString();
}

function guildIconUrl(guild) {
  if (!guild.icon) return null;
  const extension = guild.icon.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${extension}?size=128`;
}

function dashboardBot(connection) {
  return {
    id: connection.botId,
    applicationId: connection.applicationId,
    username: connection.username,
    avatarUrl: connection.avatarUrl || null,
    inviteUrl: connection.inviteUrl,
    verifiedAt: connection.verifiedAt,
  };
}

async function getDashboardContext(request, response, botId = "") {
  const context = await authenticatedContext(request, response);
  if (!context) {
    sendJson(response, 401, { code: "AUTH_REQUIRED", error: "Sign in to open the dashboard." });
    return null;
  }

  if (context.user.requiredGuildMember !== true) {
    sendJson(response, 403, { code: "SETUP_REQUIRED", error: "Complete the Valax community check first." });
    return null;
  }

  const requestedId = validBotId(botId);
  const connection = await findSelectedBot(context.database, context.user._id, requestedId);
  if (requestedId && !connection) {
    sendJson(response, 404, { code: "BOT_NOT_FOUND", error: "This bot connection is not available in your Valax account." });
    return null;
  }
  if (!connection?.encryptedToken || connection.ready !== true) {
    sendJson(response, 409, { code: "BOT_SETUP_REQUIRED", error: "Complete Bot setup before opening the dashboard." });
    return null;
  }

  let token;
  try {
    token = decryptSecret(connection.encryptedToken);
  } catch {
    sendJson(response, 409, {
      code: "BOT_TOKEN_RECONNECT_REQUIRED",
      error: "The saved Bot Token can no longer be decrypted. Reconnect the bot in Setup.",
    });
    return null;
  }

  return { ...context, connection, token };
}

function discordBotHeaders(token) {
  return { Authorization: `Bot ${token}` };
}

async function getDashboard(request, response, url) {
  const context = await getDashboardContext(request, response, url.searchParams.get("botId") || "");
  if (!context) return;

  let guildResponse;
  try {
    guildResponse = await fetch(`${DISCORD_API}/users/@me/guilds?limit=200`, {
      headers: discordBotHeaders(context.token),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    console.error("[Valax dashboard] Discord guild scan failed:", error instanceof Error ? error.message : error);
    sendJson(response, 502, {
      code: "DISCORD_API_UNREACHABLE",
      error: "Valax could not reach Discord while scanning servers.",
    });
    return;
  }

  if (guildResponse.status === 401) {
    sendJson(response, 401, { code: "BOT_TOKEN_INVALID", error: "Discord rejected the saved Bot Token." });
    return;
  }
  if (!guildResponse.ok) {
    sendJson(response, 502, { code: "DISCORD_API_ERROR", error: "Discord could not return the Bot server list." });
    return;
  }

  const discordGuilds = await guildResponse.json();
  const syncedGuilds = discordGuilds.map((guild) => ({
    id: guild.id,
    name: guild.name,
    icon: guild.icon || null,
    administrator: botHasAdministrator(guild),
  }));
  const guildIds = syncedGuilds.map((guild) => guild.id);
  const checks = guildIds.length
    ? await context.database.collection("guildChecks").find({
      userId: context.user._id,
      botId: context.connection.botId,
      guildId: { $in: guildIds },
      }).toArray()
    : [];
  const checksByGuild = new Map(checks.map((check) => [check.guildId, check]));
  const now = new Date();

  await context.database.collection("botConnections").updateOne(
    { _id: context.connection._id },
    { $set: { guilds: syncedGuilds, lastGuildSyncAt: now, updatedAt: now } }
  );

  const guilds = syncedGuilds.map((guild) => {
    const check = checksByGuild.get(guild.id);
    const available = guild.administrator && check?.available === true && check.botId === context.connection.botId;
    return {
      id: guild.id,
      name: guild.name,
      iconUrl: guildIconUrl(guild),
      administrator: guild.administrator,
      available,
      lastTestAt: check?.testedAt || null,
      testChannel: check?.channelId
        ? { id: check.channelId, name: check.channelName || "Unknown channel" }
        : null,
      lastError: check?.available === false ? check.failureCode || "TEST_FAILED" : null,
    };
  });
  const availableCount = guilds.filter((guild) => guild.available).length;
  const administratorCount = guilds.filter((guild) => guild.administrator).length;

  const allConnections = await context.database.collection("botConnections")
    .find({ userId: context.user._id, ready: true })
    .sort({ updatedAt: -1 })
    .toArray();
  sendJson(response, 200, {
    authenticated: true,
    user: publicUser(context.user),
    bot: dashboardBot(context.connection),
    bots: allConnections.map(dashboardBot),
    activeBotId: context.connection.botId,
    summary: {
      guildCount: guilds.length,
      availableCount,
      administratorCount,
      attentionCount: guilds.length - availableCount,
    },
    guilds,
    syncedAt: now,
  });
}

async function recordGuildCheck(database, filter, values) {
  const now = new Date();
  await database.collection("guildChecks").findOneAndUpdate(
    filter,
    {
      $set: { ...values, testedAt: now, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
  return now;
}

async function testDashboardGuild(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { code: "INVALID_REQUEST_BODY", error: "The server test request was not valid JSON." });
    return;
  }

  const context = await getDashboardContext(request, response, body.botId || "");
  if (!context) return;

  const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
  if (!/^\d{17,20}$/.test(guildId)) {
    sendJson(response, 400, { code: "GUILD_ID_INVALID", error: "Select a valid Discord server." });
    return;
  }

  const guild = (context.connection.guilds || []).find((item) => item.id === guildId);
  if (!guild) {
    sendJson(response, 404, { code: "GUILD_NOT_FOUND", error: "This bot is no longer connected to that server." });
    return;
  }
  if (!guild.administrator) {
    sendJson(response, 403, {
      code: "GUILD_ADMIN_REQUIRED",
      error: "Grant the bot Administrator permission before running a message test.",
    });
    return;
  }

  const checkFilter = { userId: context.user._id, botId: context.connection.botId, guildId };
  const previousCheck = await context.database.collection("guildChecks").findOne(checkFilter);
  const elapsed = previousCheck?.testedAt ? Date.now() - new Date(previousCheck.testedAt).getTime() : Infinity;
  if (elapsed < TEST_COOLDOWN_MS) {
    sendJson(response, 429, {
      code: "TEST_COOLDOWN",
      error: "Wait a few seconds before testing this server again.",
      retryAfter: Math.ceil((TEST_COOLDOWN_MS - elapsed) / 1000),
    });
    return;
  }

  const headers = discordBotHeaders(context.token);
  let guildResponse;
  let channelsResponse;
  try {
    [guildResponse, channelsResponse] = await Promise.all([
      fetch(`${DISCORD_API}/guilds/${guildId}`, { headers, signal: AbortSignal.timeout(8_000) }),
      fetch(`${DISCORD_API}/guilds/${guildId}/channels`, { headers, signal: AbortSignal.timeout(8_000) }),
    ]);
  } catch {
    sendJson(response, 502, {
      code: "DISCORD_API_UNREACHABLE",
      error: "Valax could not reach Discord while testing this server.",
    });
    return;
  }

  if (guildResponse.status === 401 || channelsResponse.status === 401) {
    sendJson(response, 401, { code: "BOT_TOKEN_INVALID", error: "Discord rejected the saved Bot Token." });
    return;
  }
  if (guildResponse.status === 403 || guildResponse.status === 404 || channelsResponse.status === 403) {
    await recordGuildCheck(context.database, checkFilter, {
      botId: context.connection.botId,
      available: false,
      failureCode: "GUILD_ACCESS_DENIED",
      channelId: null,
      channelName: null,
    });
    sendJson(response, 403, {
      code: "GUILD_ACCESS_DENIED",
      error: "Discord denied access to this server. Check the bot role and permissions.",
    });
    return;
  }
  if (!guildResponse.ok || !channelsResponse.ok) {
    sendJson(response, 502, { code: "DISCORD_API_ERROR", error: "Discord could not prepare the server test." });
    return;
  }

  const [discordGuild, discordChannels] = await Promise.all([guildResponse.json(), channelsResponse.json()]);
  const candidates = discordChannels
    .filter((channel) => MESSAGE_CHANNEL_TYPES.has(channel.type))
    .sort((left, right) => {
      if (left.id === discordGuild.system_channel_id) return -1;
      if (right.id === discordGuild.system_channel_id) return 1;
      return (left.position || 0) - (right.position || 0);
    })
    .slice(0, 20);

  for (const channel of candidates) {
    let sendResponse;
    try {
      sendResponse = await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Valax connection test. This message will be removed automatically.",
          allowed_mentions: { parse: [] },
          flags: TEST_MESSAGE_FLAGS,
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      continue;
    }

    if (sendResponse.status === 401) {
      sendJson(response, 401, { code: "BOT_TOKEN_INVALID", error: "Discord rejected the saved Bot Token." });
      return;
    }
    if (sendResponse.status === 429) {
      const rateLimit = await sendResponse.json().catch(() => ({}));
      sendJson(response, 429, {
        code: "DISCORD_RATE_LIMITED",
        error: "Discord rate-limited this test. Wait briefly and try again.",
        retryAfter: Math.ceil(Number(rateLimit.retry_after) || 1),
      });
      return;
    }
    if (!sendResponse.ok) continue;

    const message = await sendResponse.json();
    let messageRemoved = false;
    try {
      const deleteResponse = await fetch(`${DISCORD_API}/channels/${channel.id}/messages/${message.id}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      messageRemoved = deleteResponse.ok;
    } catch {
      messageRemoved = false;
    }

    const testedAt = await recordGuildCheck(context.database, checkFilter, {
      botId: context.connection.botId,
      available: true,
      failureCode: null,
      channelId: channel.id,
      channelName: channel.name,
      messageRemoved,
    });
    sendJson(response, 200, {
      success: true,
      guild: {
        id: guildId,
        available: true,
        testedAt,
        testChannel: { id: channel.id, name: channel.name },
        messageRemoved,
      },
    });
    return;
  }

  const testedAt = await recordGuildCheck(context.database, checkFilter, {
    botId: context.connection.botId,
    available: false,
    failureCode: "NO_WRITABLE_CHANNEL",
    channelId: null,
    channelName: null,
  });
  sendJson(response, 422, {
    code: "NO_WRITABLE_CHANNEL",
    error: "No text channel accepted the test message. Check channel-level permissions.",
    testedAt,
  });
}

async function getServerContext(request, response, guildId, botId = "") {
  if (!/^\d{17,20}$/.test(guildId || "")) {
    sendJson(response, 400, { code: "GUILD_ID_INVALID", error: "Select a valid Discord server." });
    return null;
  }

  const context = await getDashboardContext(request, response, botId);
  if (!context) return null;

  const guild = (context.connection.guilds || []).find((item) => item.id === guildId);
  if (!guild) {
    sendJson(response, 404, { code: "GUILD_NOT_FOUND", error: "This bot is not connected to that server." });
    return null;
  }

  const check = await context.database.collection("guildChecks").findOne({
    userId: context.user._id,
    guildId,
    botId: context.connection.botId,
    available: true,
  });
  if (!check) {
    sendJson(response, 403, {
      code: "SERVER_TEST_REQUIRED",
      error: "Run a successful Dashboard connection test before opening this server.",
    });
    return null;
  }

  return { ...context, guild, check };
}

function publicServerGuild(guild) {
  return {
    id: guild.id,
    name: guild.name,
    iconUrl: guildIconUrl(guild),
    administrator: guild.administrator === true,
  };
}

async function fetchDiscordChannels(context, response) {
  let channelsResponse;
  try {
    channelsResponse = await fetch(`${DISCORD_API}/guilds/${context.guild.id}/channels`, {
      headers: discordBotHeaders(context.token),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    sendJson(response, 502, {
      code: "DISCORD_API_UNREACHABLE",
      error: "Valax could not reach Discord while loading channels.",
    });
    return null;
  }

  if (channelsResponse.status === 401) {
    sendJson(response, 401, { code: "BOT_TOKEN_INVALID", error: "Discord rejected the saved Bot Token." });
    return null;
  }
  if (channelsResponse.status === 403 || channelsResponse.status === 404) {
    sendJson(response, 403, {
      code: "GUILD_ACCESS_DENIED",
      error: "Discord denied access to this server's channels.",
    });
    return null;
  }
  if (!channelsResponse.ok) {
    sendJson(response, 502, { code: "DISCORD_API_ERROR", error: "Discord could not return the channel list." });
    return null;
  }

  return channelsResponse.json();
}

async function getServerWorkspace(request, response, url) {
  const guildId = url.searchParams.get("guildId")?.trim() || "";
  const context = await getServerContext(request, response, guildId, url.searchParams.get("botId") || "");
  if (!context) return;

  const discordChannels = await fetchDiscordChannels(context, response);
  if (!discordChannels) return;

  const availableChecks = await context.database.collection("guildChecks").find({
    userId: context.user._id,
    botId: context.connection.botId,
    available: true,
  }).toArray();
  const availableIds = new Set(availableChecks.map((check) => check.guildId));
  const servers = (context.connection.guilds || [])
    .filter((guild) => availableIds.has(guild.id))
    .map(publicServerGuild);
  const categories = discordChannels
    .filter((channel) => channel.type === 4)
    .sort((left, right) => (left.position || 0) - (right.position || 0))
    .map((channel) => ({ id: channel.id, name: channel.name, position: channel.position || 0 }));
  const channels = discordChannels
    .filter((channel) => MESSAGE_CHANNEL_TYPES.has(channel.type))
    .sort((left, right) => (left.position || 0) - (right.position || 0))
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      announcement: channel.type === 5,
      parentId: channel.parent_id || null,
      position: channel.position || 0,
      topic: channel.topic || null,
      nsfw: channel.nsfw === true,
    }));

  sendJson(response, 200, {
    user: publicUser(context.user),
    bot: dashboardBot(context.connection),
    bots: (await context.database.collection("botConnections")
      .find({ userId: context.user._id, ready: true })
      .sort({ updatedAt: -1 })
      .toArray()).map(dashboardBot),
    server: publicServerGuild(context.guild),
    servers,
    categories,
    channels,
  });
}

function publicDiscordMessage(message) {
  const referencedMessage = message.referenced_message
    ? {
        id: message.referenced_message.id,
        content: typeof message.referenced_message.content === "string"
          ? message.referenced_message.content.slice(0, 240)
          : "",
        author: {
          id: message.referenced_message.author?.id,
          username: message.referenced_message.author?.username || "Discord user",
          displayName: message.referenced_message.author?.global_name
            || message.referenced_message.author?.username
            || "Discord user",
        },
      }
    : null;
  return {
    id: message.id,
    type: message.type,
    content: typeof message.content === "string" ? message.content : "",
    timestamp: message.timestamp,
    editedTimestamp: message.edited_timestamp || null,
    pinned: message.pinned === true,
    mentionEveryone: message.mention_everyone === true,
    referencedMessage,
    author: {
      id: message.author?.id,
      username: message.author?.username || "Discord user",
      displayName: message.author?.global_name || message.author?.username || "Discord user",
      avatarUrl: message.author ? avatarUrl(message.author) : null,
      bot: message.author?.bot === true,
    },
    mentions: Array.isArray(message.mentions)
      ? message.mentions.map((user) => ({ id: user.id, username: user.username, displayName: user.global_name || user.username }))
      : [],
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          url: attachment.url,
          contentType: attachment.content_type || null,
          size: attachment.size || 0,
          width: attachment.width || null,
          height: attachment.height || null,
        }))
      : [],
    embeds: Array.isArray(message.embeds)
      ? message.embeds.slice(0, 4).map((embed) => ({
          title: embed.title || null,
          description: embed.description || null,
          url: embed.url || null,
          color: embed.color || null,
        }))
      : [],
  };
}

async function validateMessageChannel(context, response, channelId) {
  if (!/^\d{17,20}$/.test(channelId || "")) {
    sendJson(response, 400, { code: "CHANNEL_ID_INVALID", error: "Select a valid Discord channel." });
    return null;
  }

  const cacheKey = `${context.connection.botId}:${context.guild.id}:${channelId}`;
  const cached = channelValidationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.channel;
  if (cached) channelValidationCache.delete(cacheKey);

  let channelResponse;
  try {
    channelResponse = await fetch(`${DISCORD_API}/channels/${channelId}`, {
      headers: discordBotHeaders(context.token),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    sendJson(response, 502, {
      code: "DISCORD_API_UNREACHABLE",
      error: "Valax could not reach Discord while checking this channel.",
    });
    return null;
  }

  if (channelResponse.status === 401) {
    sendJson(response, 401, { code: "BOT_TOKEN_INVALID", error: "Discord rejected the saved Bot Token." });
    return null;
  }
  if (channelResponse.status === 403 || channelResponse.status === 404) {
    sendJson(response, 403, { code: "CHANNEL_ACCESS_DENIED", error: "Discord denied access to this channel." });
    return null;
  }
  if (!channelResponse.ok) {
    sendJson(response, 502, { code: "DISCORD_API_ERROR", error: "Discord could not verify this channel." });
    return null;
  }

  const channel = await channelResponse.json();
  if (channel.guild_id !== context.guild.id || !MESSAGE_CHANNEL_TYPES.has(channel.type)) {
    sendJson(response, 403, { code: "CHANNEL_ACCESS_DENIED", error: "This channel does not belong to the selected server." });
    return null;
  }
  channelValidationCache.set(cacheKey, { channel, expiresAt: Date.now() + CHANNEL_CACHE_MS });
  if (channelValidationCache.size > 2_000) {
    for (const [key, value] of channelValidationCache) {
      if (value.expiresAt <= Date.now()) channelValidationCache.delete(key);
      if (channelValidationCache.size <= 1_500) break;
    }
  }
  return channel;
}

async function getServerMessages(request, response, url) {
  const guildId = url.searchParams.get("guildId")?.trim() || "";
  const channelId = url.searchParams.get("channelId")?.trim() || "";
  const context = await getServerContext(request, response, guildId, url.searchParams.get("botId") || "");
  if (!context) return;
  const channel = await validateMessageChannel(context, response, channelId);
  if (!channel) return;

  const after = /^\d{17,20}$/.test(url.searchParams.get("after") || "")
    ? url.searchParams.get("after")
    : "";
  const query = new URLSearchParams({ limit: after ? "100" : "50" });
  if (after) query.set("after", after);
  let messageResponse;
  try {
    messageResponse = await fetch(`${DISCORD_API}/channels/${channelId}/messages?${query}`, {
      headers: discordBotHeaders(context.token),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    sendJson(response, 502, {
      code: "DISCORD_API_UNREACHABLE",
      error: "Valax could not reach Discord while loading messages.",
    });
    return;
  }

  if (messageResponse.status === 401) {
    sendJson(response, 401, { code: "BOT_TOKEN_INVALID", error: "Discord rejected the saved Bot Token." });
    return;
  }
  if (messageResponse.status === 403 || messageResponse.status === 404) {
    sendJson(response, 403, { code: "CHANNEL_ACCESS_DENIED", error: "Discord denied access to this channel's messages." });
    return;
  }
  if (!messageResponse.ok) {
    sendJson(response, 502, { code: "DISCORD_API_ERROR", error: "Discord could not return recent messages." });
    return;
  }

  const messages = await messageResponse.json();
  sendJson(response, 200, {
    channel: {
      id: channel.id,
      name: channel.name,
      announcement: channel.type === 5,
      topic: channel.topic || null,
    },
    messages: messages.reverse().map(publicDiscordMessage),
    fetchedAt: new Date(),
  });
}

function formatDynamicValue(value, timeZone, options) {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(value);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(value);
  }
}

function resolveMessageTokens(source, serverName, timeZone) {
  const now = new Date();
  const values = {
    "/date": formatDynamicValue(now, timeZone, { month: "long", day: "numeric", year: "numeric" }),
    "/time": formatDynamicValue(now, timeZone, { hour: "numeric", minute: "2-digit" }),
    "/server": serverName,
  };
  return Object.entries(values).reduce((message, [token, value]) => message.replaceAll(token, value), source);
}

function allowedMentions(policy, userIds = [], repliedUser = false) {
  const users = [...new Set(userIds.filter((id) => /^\d{17,20}$/.test(id)))].slice(0, 100);
  if (policy === "all") return { parse: ["roles", "everyone"], users, replied_user: repliedUser };
  if (policy === "users") return { parse: [], users, replied_user: repliedUser };
  return { parse: [], replied_user: false };
}

async function sendServerMessage(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { code: "INVALID_REQUEST_BODY", error: "The message request was not valid JSON." });
    return;
  }

  const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  const context = await getServerContext(request, response, guildId, body.botId || "");
  if (!context) return;
  const channel = await validateMessageChannel(context, response, channelId);
  if (!channel) return;

  const source = typeof body.content === "string" ? body.content.trim() : "";
  const mode = body.mode === "announcement" ? "announcement" : "message";
  const mentionPolicy = ["none", "users", "all"].includes(body.mentionPolicy) ? body.mentionPolicy : "none";
  const mentionIds = Array.isArray(body.mentionIds) ? body.mentionIds.map(String) : [];
  const replyToId = /^\d{17,20}$/.test(body.replyToId || "") ? body.replyToId : "";
  const timeZone = typeof body.timeZone === "string" && body.timeZone.length <= 64 ? body.timeZone : "UTC";
  const content = resolveMessageTokens(source, context.guild.name, timeZone);
  if (!content || content.length > 2_000) {
    sendJson(response, 400, {
      code: "MESSAGE_LENGTH_INVALID",
      error: "Enter a message between 1 and 2,000 characters after dynamic values are applied.",
    });
    return;
  }

  const latestMessage = await context.database.collection("messageLogs").findOne(
    { userId: context.user._id, botId: context.connection.botId, channelId },
    { sort: { createdAt: -1 } }
  );
  const elapsed = latestMessage?.createdAt ? Date.now() - new Date(latestMessage.createdAt).getTime() : Infinity;
  if (elapsed < MESSAGE_COOLDOWN_MS) {
    sendJson(response, 429, {
      code: "MESSAGE_COOLDOWN",
      error: "Wait a moment before sending another message.",
      retryAfter: Math.ceil((MESSAGE_COOLDOWN_MS - elapsed) / 1000),
    });
    return;
  }

  const headers = discordBotHeaders(context.token);
  let discordResponse;
  try {
    discordResponse = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        allowed_mentions: allowedMentions(mentionPolicy, mentionIds, body.notifyReplyAuthor === true),
        ...(replyToId ? {
          message_reference: {
            message_id: replyToId,
            channel_id: channelId,
            guild_id: guildId,
            fail_if_not_exists: false,
          },
        } : {}),
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    sendJson(response, 502, { code: "DISCORD_API_UNREACHABLE", error: "Valax could not reach Discord while sending." });
    return;
  }

  if (discordResponse.status === 401) {
    sendJson(response, 401, { code: "BOT_TOKEN_INVALID", error: "Discord rejected the saved Bot Token." });
    return;
  }
  if (discordResponse.status === 403 || discordResponse.status === 404) {
    sendJson(response, 403, { code: "CHANNEL_SEND_DENIED", error: "Discord denied permission to send in this channel." });
    return;
  }
  if (discordResponse.status === 429) {
    const rateLimit = await discordResponse.json().catch(() => ({}));
    sendJson(response, 429, {
      code: "DISCORD_RATE_LIMITED",
      error: "Discord rate-limited this channel. Wait briefly and try again.",
      retryAfter: Math.ceil(Number(rateLimit.retry_after) || 1),
    });
    return;
  }
  if (!discordResponse.ok) {
    sendJson(response, 502, { code: "DISCORD_API_ERROR", error: "Discord could not send this message." });
    return;
  }

  const message = await discordResponse.json();
  let published = false;
  if (mode === "announcement" && channel.type === 5) {
    try {
      const publishResponse = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${message.id}/crosspost`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      published = publishResponse.ok;
    } catch {
      published = false;
    }
  }

  const createdAt = new Date();
  await context.database.collection("messageLogs").insertOne({
    userId: context.user._id,
    botId: context.connection.botId,
    guildId,
    channelId,
    discordMessageId: message.id,
    mode,
    mentionPolicy,
    mentionCount: mentionIds.length,
    replyToId: replyToId || null,
    published,
    createdAt,
  });

  sendJson(response, 200, {
    success: true,
    message: publicDiscordMessage(message),
    mode,
    published,
    createdAt,
  });
}

function publicGuildMember(member) {
  const user = member.user || {};
  return {
    id: user.id,
    username: user.username || "Discord user",
    displayName: member.nick || user.global_name || user.username || "Discord user",
    avatarUrl: avatarUrl(user),
    bot: user.bot === true,
    roles: Array.isArray(member.roles) ? member.roles : [],
    joinedAt: member.joined_at || null,
  };
}

async function getServerMembers(request, response, url) {
  const guildId = url.searchParams.get("guildId")?.trim() || "";
  const context = await getServerContext(request, response, guildId, url.searchParams.get("botId") || "");
  if (!context) return;

  const search = (url.searchParams.get("query") || "").trim().slice(0, 80);
  const after = /^\d{17,20}$/.test(url.searchParams.get("after") || "")
    ? url.searchParams.get("after")
    : "0";
  const endpoint = search
    ? `${DISCORD_API}/guilds/${guildId}/members/search?${new URLSearchParams({ query: search, limit: "100" })}`
    : `${DISCORD_API}/guilds/${guildId}/members?${new URLSearchParams({ limit: "100", after })}`;

  let discordResponse;
  try {
    discordResponse = await fetch(endpoint, {
      headers: discordBotHeaders(context.token),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    sendJson(response, 502, { code: "DISCORD_API_UNREACHABLE", error: "Valax could not reach Discord while loading members." });
    return;
  }

  if (discordResponse.status === 401) {
    sendJson(response, 401, { code: "BOT_TOKEN_INVALID", error: "Discord rejected the saved Bot Token." });
    return;
  }
  if (discordResponse.status === 403) {
    sendJson(response, 403, {
      code: "MEMBER_ACCESS_DENIED",
      error: "Discord denied member access. Enable Server Members Intent and verify the bot role.",
    });
    return;
  }
  if (!discordResponse.ok) {
    sendJson(response, 502, { code: "DISCORD_API_ERROR", error: "Discord could not return the member list." });
    return;
  }

  const members = await discordResponse.json();
  const publicMembers = members.map(publicGuildMember);
  sendJson(response, 200, {
    members: publicMembers,
    nextAfter: !search && members.length === 100 ? members[members.length - 1]?.user?.id || null : null,
    fetchedAt: new Date(),
  });
}

async function fetchGuildMember(context, response, recipientId) {
  if (!/^\d{17,20}$/.test(recipientId || "")) {
    sendJson(response, 400, { code: "RECIPIENT_INVALID", error: "Select a valid Discord member." });
    return null;
  }

  let memberResponse;
  try {
    memberResponse = await fetch(`${DISCORD_API}/guilds/${context.guild.id}/members/${recipientId}`, {
      headers: discordBotHeaders(context.token),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    sendJson(response, 502, { code: "DISCORD_API_UNREACHABLE", error: "Valax could not reach Discord while checking this member." });
    return null;
  }

  if (memberResponse.status === 404) {
    sendJson(response, 404, { code: "MEMBER_NOT_FOUND", error: "This user is no longer a member of the selected server." });
    return null;
  }
  if (!memberResponse.ok) {
    sendJson(response, memberResponse.status === 403 ? 403 : 502, {
      code: memberResponse.status === 403 ? "MEMBER_ACCESS_DENIED" : "DISCORD_API_ERROR",
      error: memberResponse.status === 403
        ? "Discord denied access to this server member."
        : "Discord could not verify this member.",
    });
    return null;
  }

  const member = await memberResponse.json();
  if (member.user?.bot) {
    sendJson(response, 400, { code: "BOT_RECIPIENT_NOT_ALLOWED", error: "Direct messages can only be sent to human members." });
    return null;
  }
  return member;
}

async function openDirectMessageChannel(token, recipientId) {
  try {
    const channelResponse = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: "POST",
      headers: { ...discordBotHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_id: recipientId }),
      signal: AbortSignal.timeout(8_000),
    });
    if (channelResponse.status === 429) {
      const rateLimit = await channelResponse.json().catch(() => ({}));
      return { ok: false, status: 429, retryAfter: Math.max(1, Number(rateLimit.retry_after) || 1) };
    }
    if (!channelResponse.ok) return { ok: false, status: channelResponse.status };
    return { ok: true, channel: await channelResponse.json() };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function fetchDirectMessages(token, channelId) {
  try {
    const messageResponse = await fetch(`${DISCORD_API}/channels/${channelId}/messages?limit=50`, {
      headers: discordBotHeaders(token),
      signal: AbortSignal.timeout(8_000),
    });
    if (!messageResponse.ok) return { ok: false, status: messageResponse.status, messages: [] };
    return { ok: true, messages: await messageResponse.json() };
  } catch {
    return { ok: false, status: 0, messages: [] };
  }
}

function directMessageOptedOut(messages, botId) {
  const newestInbound = (messages || []).find((message) => message.author?.id !== botId);
  return Boolean(newestInbound && /^(stop|unsubscribe|opt[ -]?out)$/i.test((newestInbound.content || "").trim()));
}

function resolveDirectMessageTokens(source, guildName, member, timeZone) {
  return resolveMessageTokens(source, guildName, timeZone)
    .replaceAll("/@", `<@${member.user.id}>`);
}

async function sendDirectMessageToMember(context, member, source, timeZone, { checkOptOut = true } = {}) {
  const opened = await openDirectMessageChannel(context.token, member.user.id);
  if (!opened.ok) return opened;

  if (checkOptOut) {
    const history = await fetchDirectMessages(context.token, opened.channel.id);
    if (history.ok && directMessageOptedOut(history.messages, context.connection.botId)) {
      return { ok: false, status: 403, optedOut: true, channel: opened.channel };
    }
  }

  const content = resolveDirectMessageTokens(source, context.guild.name, member, timeZone);
  try {
    const discordResponse = await fetch(`${DISCORD_API}/channels/${opened.channel.id}/messages`, {
      method: "POST",
      headers: { ...discordBotHeaders(context.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [], users: [member.user.id], replied_user: false },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (discordResponse.status === 429) {
      const rateLimit = await discordResponse.json().catch(() => ({}));
      return { ok: false, status: 429, retryAfter: Math.max(1, Number(rateLimit.retry_after) || 1), channel: opened.channel };
    }
    if (!discordResponse.ok) return { ok: false, status: discordResponse.status, channel: opened.channel };
    return { ok: true, channel: opened.channel, message: await discordResponse.json() };
  } catch {
    return { ok: false, status: 0, channel: opened.channel };
  }
}

async function getDirectConversation(request, response, url) {
  const guildId = url.searchParams.get("guildId")?.trim() || "";
  const recipientId = url.searchParams.get("recipientId")?.trim() || "";
  const context = await getServerContext(request, response, guildId, url.searchParams.get("botId") || "");
  if (!context) return;
  const member = await fetchGuildMember(context, response, recipientId);
  if (!member) return;
  const opened = await openDirectMessageChannel(context.token, recipientId);
  if (!opened.ok) {
    sendJson(response, opened.status === 429 ? 429 : 502, {
      code: opened.status === 429 ? "DISCORD_RATE_LIMITED" : "DM_CHANNEL_UNAVAILABLE",
      error: opened.status === 429 ? "Discord rate-limited this conversation." : "Discord could not open this direct conversation.",
      retryAfter: opened.retryAfter,
    });
    return;
  }
  const history = await fetchDirectMessages(context.token, opened.channel.id);
  if (!history.ok) {
    sendJson(response, history.status === 403 ? 403 : 502, {
      code: "DM_HISTORY_UNAVAILABLE",
      error: "Discord could not load this direct conversation.",
    });
    return;
  }
  sendJson(response, 200, {
    member: publicGuildMember(member),
    channelId: opened.channel.id,
    optedOut: directMessageOptedOut(history.messages, context.connection.botId),
    messages: history.messages.reverse().map(publicDiscordMessage),
  });
}

async function sendDirectMessage(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { code: "INVALID_REQUEST_BODY", error: "The direct message request was not valid JSON." });
    return;
  }
  const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
  const recipientId = typeof body.recipientId === "string" ? body.recipientId.trim() : "";
  const context = await getServerContext(request, response, guildId, body.botId || "");
  if (!context) return;
  const member = await fetchGuildMember(context, response, recipientId);
  if (!member) return;

  const source = typeof body.content === "string" ? body.content.trim() : "";
  const timeZone = typeof body.timeZone === "string" && body.timeZone.length <= 64 ? body.timeZone : "UTC";
  const content = resolveDirectMessageTokens(source, context.guild.name, member, timeZone);
  if (!content || content.length > 2_000) {
    sendJson(response, 400, { code: "MESSAGE_LENGTH_INVALID", error: "Enter a direct message between 1 and 2,000 characters." });
    return;
  }

  const latest = await context.database.collection("messageLogs").findOne(
    { userId: context.user._id, botId: context.connection.botId, recipientId },
    { sort: { createdAt: -1 } }
  );
  const elapsed = latest?.createdAt ? Date.now() - new Date(latest.createdAt).getTime() : Infinity;
  if (elapsed < DIRECT_MESSAGE_COOLDOWN_MS) {
    sendJson(response, 429, {
      code: "MESSAGE_COOLDOWN",
      error: "Wait a moment before sending another direct message.",
      retryAfter: Math.ceil((DIRECT_MESSAGE_COOLDOWN_MS - elapsed) / 1000),
    });
    return;
  }

  const result = await sendDirectMessageToMember(context, member, source, timeZone);
  if (!result.ok) {
    const optedOut = result.optedOut === true;
    sendJson(response, optedOut ? 403 : result.status === 429 ? 429 : result.status === 403 ? 403 : 502, {
      code: optedOut ? "DM_RECIPIENT_OPTED_OUT" : result.status === 429 ? "DISCORD_RATE_LIMITED" : "DM_SEND_FAILED",
      error: optedOut
        ? "This member asked the bot to stop direct notifications."
        : result.status === 429
          ? "Discord rate-limited this direct message."
          : "Discord could not deliver this direct message. The member may have disabled server DMs.",
      retryAfter: result.retryAfter,
    });
    return;
  }

  const createdAt = new Date();
  await context.database.collection("messageLogs").insertOne({
    userId: context.user._id,
    botId: context.connection.botId,
    guildId,
    channelId: result.channel.id,
    recipientId,
    discordMessageId: result.message.id,
    mode: "dm",
    createdAt,
  });
  sendJson(response, 200, { success: true, message: publicDiscordMessage(result.message), member: publicGuildMember(member), createdAt });
}

function publicCampaign(campaign) {
  return {
    id: campaign.campaignId,
    status: campaign.status,
    recipientCount: campaign.recipientCount || 0,
    processed: campaign.cursor || 0,
    sent: campaign.sent || 0,
    failed: campaign.failed || 0,
    skipped: campaign.skipped || 0,
    optedOut: campaign.optedOut || 0,
    truncated: campaign.truncated === true,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    completedAt: campaign.completedAt || null,
    nextAttemptAt: campaign.nextAttemptAt || null,
  };
}

async function collectCampaignMembers(context) {
  const recipients = [];
  let after = "0";
  let truncated = false;
  while (recipients.length < MAX_CAMPAIGN_RECIPIENTS) {
    let memberResponse;
    try {
      memberResponse = await fetch(
        `${DISCORD_API}/guilds/${context.guild.id}/members?${new URLSearchParams({ limit: "1000", after })}`,
        { headers: discordBotHeaders(context.token), signal: AbortSignal.timeout(8_000) }
      );
    } catch {
      return { ok: false, status: 0 };
    }
    if (!memberResponse.ok) return { ok: false, status: memberResponse.status };
    const batch = await memberResponse.json();
    for (const member of batch) {
      if (!member.user?.id || member.user.bot || member.user.id === context.connection.botId) continue;
      recipients.push({
        id: member.user.id,
        username: member.user.username || "Discord user",
        displayName: member.nick || member.user.global_name || member.user.username || "Discord user",
      });
      if (recipients.length >= MAX_CAMPAIGN_RECIPIENTS) break;
    }
    if (batch.length < 1000) break;
    if (recipients.length >= MAX_CAMPAIGN_RECIPIENTS) {
      truncated = true;
      break;
    }
    after = batch[batch.length - 1]?.user?.id || after;
  }
  return { ok: true, recipients, truncated };
}

async function previewDmCampaign(request, response, body) {
  const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
  const context = await getServerContext(request, response, guildId, body.botId || "");
  if (!context) return;
  const collected = await collectCampaignMembers(context);
  if (!collected.ok) {
    sendJson(response, collected.status === 403 ? 403 : 502, {
      code: collected.status === 403 ? "MEMBER_ACCESS_DENIED" : "DISCORD_API_ERROR",
      error: collected.status === 403
        ? "Discord denied member access. Enable Server Members Intent."
        : "Discord could not prepare the recipient preview.",
    });
    return;
  }
  sendJson(response, 200, {
    eligibleRecipients: collected.recipients.length,
    truncated: collected.truncated,
    confirmation: context.guild.name,
    safeguards: { campaignCooldownHours: 6, recipientCooldownHours: 24, stopWords: ["STOP", "UNSUBSCRIBE", "OPT OUT"] },
  });
}

async function createDmCampaign(request, response, body) {
  const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
  const context = await getServerContext(request, response, guildId, body.botId || "");
  if (!context) return;
  const source = typeof body.content === "string" ? body.content.trim() : "";
  const timeZone = typeof body.timeZone === "string" && body.timeZone.length <= 64 ? body.timeZone : "UTC";
  if (!source || source.length > 2_000) {
    sendJson(response, 400, { code: "MESSAGE_LENGTH_INVALID", error: "Enter a campaign message between 1 and 2,000 characters." });
    return;
  }
  if ((body.confirmation || "").trim() !== context.guild.name) {
    sendJson(response, 400, { code: "CAMPAIGN_CONFIRMATION_REQUIRED", error: "Type the server name exactly to confirm this notification." });
    return;
  }

  const latestCampaign = await context.database.collection("dmCampaigns").findOne(
    { userId: context.user._id, botId: context.connection.botId, guildId, status: { $ne: "cancelled" } },
    { sort: { createdAt: -1 } }
  );
  const elapsed = latestCampaign?.createdAt ? Date.now() - new Date(latestCampaign.createdAt).getTime() : Infinity;
  if (elapsed < DM_CAMPAIGN_COOLDOWN_MS) {
    sendJson(response, 429, {
      code: "CAMPAIGN_COOLDOWN",
      error: "This server recently started a DM notification. Wait before creating another campaign.",
      retryAfter: Math.ceil((DM_CAMPAIGN_COOLDOWN_MS - elapsed) / 1000),
      campaign: publicCampaign(latestCampaign),
    });
    return;
  }

  const collected = await collectCampaignMembers(context);
  if (!collected.ok) {
    sendJson(response, collected.status === 403 ? 403 : 502, {
      code: collected.status === 403 ? "MEMBER_ACCESS_DENIED" : "DISCORD_API_ERROR",
      error: "Discord could not build the recipient list for this campaign.",
    });
    return;
  }
  if (!collected.recipients.length) {
    sendJson(response, 422, { code: "NO_ELIGIBLE_RECIPIENTS", error: "No human server members are eligible for this notification." });
    return;
  }

  const now = new Date();
  const campaign = {
    campaignId: randomBytes(18).toString("base64url"),
    userId: context.user._id,
    botId: context.connection.botId,
    guildId,
    guildName: context.guild.name,
    encryptedSource: encryptSecret(source),
    contentLength: source.length,
    timeZone,
    recipients: collected.recipients,
    recipientCount: collected.recipients.length,
    truncated: collected.truncated,
    cursor: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    optedOut: 0,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await context.database.collection("dmCampaigns").insertOne(campaign);
  sendJson(response, 201, { success: true, campaign: publicCampaign(campaign) });
}

function campaignMember(recipient) {
  return {
    nick: recipient.displayName,
    user: { id: recipient.id, username: recipient.username, global_name: recipient.displayName, bot: false },
  };
}

async function processDmCampaign(request, response, body) {
  const campaignId = typeof body.campaignId === "string" ? body.campaignId.trim() : "";
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(campaignId)) {
    sendJson(response, 400, { code: "CAMPAIGN_ID_INVALID", error: "Select a valid DM campaign." });
    return;
  }
  const auth = await authenticatedContext(request, response);
  if (!auth) {
    sendJson(response, 401, { code: "AUTH_REQUIRED", error: "Sign in to manage this campaign." });
    return;
  }
  let campaign = await auth.database.collection("dmCampaigns").findOne({ campaignId, userId: auth.user._id });
  if (!campaign) {
    sendJson(response, 404, { code: "CAMPAIGN_NOT_FOUND", error: "This DM campaign could not be found." });
    return;
  }
  if (["completed", "cancelled"].includes(campaign.status)) {
    sendJson(response, 200, { success: true, campaign: publicCampaign(campaign) });
    return;
  }
  const waitMs = campaign.nextAttemptAt ? new Date(campaign.nextAttemptAt).getTime() - Date.now() : 0;
  if (waitMs > 0) {
    sendJson(response, 429, {
      code: "DISCORD_RATE_LIMITED",
      error: "Discord asked Valax to pause this campaign briefly.",
      retryAfter: Math.ceil(waitMs / 1000),
      campaign: publicCampaign(campaign),
    });
    return;
  }

  const leaseUntil = new Date(Date.now() + 20_000);
  campaign = await auth.database.collection("dmCampaigns").findOneAndUpdate(
    {
      _id: campaign._id,
      status: { $in: ["queued", "running"] },
      $or: [{ processingUntil: { $exists: false } }, { processingUntil: { $lte: new Date() } }],
    },
    { $set: { status: "running", processingUntil: leaseUntil, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!campaign) {
    sendJson(response, 409, { code: "CAMPAIGN_BUSY", error: "Another worker is already processing this campaign." });
    return;
  }

  const context = await getServerContext(request, response, campaign.guildId, campaign.botId);
  if (!context) {
    await auth.database.collection("dmCampaigns").updateOne({ _id: campaign._id }, { $unset: { processingUntil: "" } });
    return;
  }

  let source;
  try {
    source = decryptSecret(campaign.encryptedSource);
  } catch {
    await auth.database.collection("dmCampaigns").updateOne(
      { _id: campaign._id },
      { $set: { status: "failed", updatedAt: new Date() }, $unset: { processingUntil: "", encryptedSource: "" } }
    );
    sendJson(response, 409, { code: "CAMPAIGN_CONTENT_UNAVAILABLE", error: "This campaign can no longer decrypt its message content." });
    return;
  }

  let cursor = campaign.cursor || 0;
  let sent = campaign.sent || 0;
  let failed = campaign.failed || 0;
  let skipped = campaign.skipped || 0;
  let optedOut = campaign.optedOut || 0;
  let retryAfter = 0;
  const cutoff = new Date(Date.now() - DM_RECIPIENT_COOLDOWN_MS);
  const batchEnd = Math.min(campaign.recipients.length, cursor + CAMPAIGN_BATCH_SIZE);

  while (cursor < batchEnd) {
    const recipient = campaign.recipients[cursor];
    const recent = await auth.database.collection("dmDeliveryLogs").findOne({
      userId: auth.user._id,
      botId: campaign.botId,
      guildId: campaign.guildId,
      recipientId: recipient.id,
      status: "sent",
      createdAt: { $gt: cutoff },
    });
    if (recent) {
      skipped += 1;
      cursor += 1;
      continue;
    }

    const result = await sendDirectMessageToMember(context, campaignMember(recipient), source, campaign.timeZone);
    if (result.status === 429) {
      retryAfter = Math.max(1, result.retryAfter || 1);
      break;
    }
    const deliveryStatus = result.ok ? "sent" : result.optedOut ? "opted_out" : "failed";
    await auth.database.collection("dmDeliveryLogs").insertOne({
      userId: auth.user._id,
      botId: campaign.botId,
      guildId: campaign.guildId,
      campaignId,
      recipientId: recipient.id,
      status: deliveryStatus,
      discordMessageId: result.message?.id || null,
      contentLength: campaign.contentLength,
      createdAt: new Date(),
    });
    if (result.ok) sent += 1;
    else if (result.optedOut) optedOut += 1;
    else failed += 1;
    cursor += 1;
  }

  const complete = cursor >= campaign.recipientCount;
  const now = new Date();
  const update = {
    $set: {
      cursor,
      sent,
      failed,
      skipped,
      optedOut,
      status: complete ? "completed" : "queued",
      updatedAt: now,
      ...(complete ? { completedAt: now, nextAttemptAt: null } : {}),
      ...(retryAfter ? { nextAttemptAt: new Date(Date.now() + retryAfter * 1_000) } : { nextAttemptAt: null }),
    },
    $unset: { processingUntil: "", ...(complete ? { encryptedSource: "", recipients: "" } : {}) },
  };
  await auth.database.collection("dmCampaigns").updateOne({ _id: campaign._id }, update);
  const updated = await auth.database.collection("dmCampaigns").findOne({ _id: campaign._id });
  sendJson(response, 200, { success: true, retryAfter: retryAfter || null, campaign: publicCampaign(updated) });
}

async function cancelDmCampaign(request, response, body) {
  const auth = await authenticatedContext(request, response);
  if (!auth) {
    sendJson(response, 401, { code: "AUTH_REQUIRED", error: "Sign in to cancel this campaign." });
    return;
  }
  const campaignId = typeof body.campaignId === "string" ? body.campaignId.trim() : "";
  const campaign = await auth.database.collection("dmCampaigns").findOneAndUpdate(
    { campaignId, userId: auth.user._id, status: { $in: ["queued", "running"] } },
    {
      $set: { status: "cancelled", updatedAt: new Date() },
      $unset: { encryptedSource: "", recipients: "", processingUntil: "" },
    },
    { returnDocument: "after" }
  );
  if (!campaign) {
    sendJson(response, 404, { code: "CAMPAIGN_NOT_FOUND", error: "No active campaign was found." });
    return;
  }
  sendJson(response, 200, { success: true, campaign: publicCampaign(campaign) });
}

async function handleDmCampaignRequest(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { code: "INVALID_REQUEST_BODY", error: "The campaign request was not valid JSON." });
    return;
  }
  if (body.action === "preview") return previewDmCampaign(request, response, body);
  if (body.action === "process") return processDmCampaign(request, response, body);
  if (body.action === "cancel") return cancelDmCampaign(request, response, body);
  return createDmCampaign(request, response, body);
}

async function getDmCampaignStatus(request, response, url) {
  const guildId = url.searchParams.get("guildId")?.trim() || "";
  const context = await getServerContext(request, response, guildId, url.searchParams.get("botId") || "");
  if (!context) return;
  const campaign = await context.database.collection("dmCampaigns").findOne(
    { userId: context.user._id, botId: context.connection.botId, guildId },
    { sort: { createdAt: -1 } }
  );
  sendJson(response, 200, { campaign: campaign ? publicCampaign(campaign) : null });
}

const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  enabled: true,
  browser: true,
  sounds: true,
  normalMessages: false,
  mentions: true,
  replies: true,
  directMessages: true,
  groupWindowSeconds: 8,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
});

function publicNotificationSettings(settings) {
  const merged = { ...DEFAULT_NOTIFICATION_SETTINGS, ...(settings || {}) };
  return {
    enabled: merged.enabled === true,
    browser: merged.browser === true,
    sounds: merged.sounds === true,
    normalMessages: merged.normalMessages === true,
    mentions: merged.mentions === true,
    replies: merged.replies === true,
    directMessages: merged.directMessages === true,
    groupWindowSeconds: merged.groupWindowSeconds,
    quietHours: { ...DEFAULT_NOTIFICATION_SETTINGS.quietHours, ...(settings?.quietHours || {}) },
  };
}

async function notificationSettings(request, response, url, method) {
  const guildId = url.searchParams.get("guildId")?.trim() || "";
  const botId = url.searchParams.get("botId")?.trim() || "";
  const context = await getServerContext(request, response, guildId, botId);
  if (!context) return;
  const filter = { userId: context.user._id, botId: context.connection.botId, guildId };
  if (method === "GET") {
    const settings = await context.database.collection("notificationSettings").findOne(filter);
    sendJson(response, 200, { settings: publicNotificationSettings(settings) });
    return;
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { code: "INVALID_REQUEST_BODY", error: "The notification settings were not valid JSON." });
    return;
  }
  const input = body.settings || {};
  const booleanKeys = ["enabled", "browser", "sounds", "normalMessages", "mentions", "replies", "directMessages"];
  const normalized = Object.fromEntries(booleanKeys.map((key) => [key, input[key] === true]));
  normalized.groupWindowSeconds = Math.min(60, Math.max(3, Number(input.groupWindowSeconds) || 8));
  normalized.quietHours = {
    enabled: input.quietHours?.enabled === true,
    start: /^([01]\d|2[0-3]):[0-5]\d$/.test(input.quietHours?.start || "") ? input.quietHours.start : "22:00",
    end: /^([01]\d|2[0-3]):[0-5]\d$/.test(input.quietHours?.end || "") ? input.quietHours.end : "08:00",
  };
  const now = new Date();
  const settings = await context.database.collection("notificationSettings").findOneAndUpdate(
    filter,
    { $set: { ...normalized, updatedAt: now }, $setOnInsert: { ...filter, createdAt: now } },
    { upsert: true, returnDocument: "after" }
  );
  sendJson(response, 200, { success: true, settings: publicNotificationSettings(settings) });
}

async function configureBot(request, response) {
  const context = await authenticatedContext(request, response);
  if (!context) {
    sendJson(response, 401, { code: "AUTH_REQUIRED", error: "Sign in before configuring a bot." });
    return;
  }

  if (context.user.requiredGuildMember !== true) {
    sendJson(response, 403, { code: "MEMBERSHIP_REQUIRED", error: "Join the Valax Discord server before configuring a bot." });
    return;
  }

  getEncryptionKey();

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { code: "INVALID_REQUEST_BODY", error: "The Bot Token request was not valid JSON." });
    return;
  }

  const requestedBotId = validBotId(body.botId);
  let token = typeof body.token === "string" ? body.token.trim().replace(/^Bot\s+/i, "") : "";
  const existing = requestedBotId
    ? await context.database.collection("botConnections").findOne({ userId: context.user._id, botId: requestedBotId })
    : !token
      ? await findSelectedBot(context.database, context.user._id, "")
      : null;

  if (!token && existing?.encryptedToken) {
    try {
      token = decryptSecret(existing.encryptedToken);
    } catch {
      sendJson(response, 409, {
        code: "BOT_TOKEN_RECONNECT_REQUIRED",
        error: "The saved Bot Token can no longer be decrypted. Paste a fresh token to reconnect the bot.",
      });
      return;
    }
  }

  if (!/^[A-Za-z0-9._-]{40,200}$/.test(token)) {
    sendJson(response, 400, { code: "BOT_TOKEN_REQUIRED", error: "Enter a valid Discord bot token." });
    return;
  }

  const headers = { Authorization: `Bot ${token}` };
  let identityResponse;
  let applicationResponse;
  let guildsResponse;

  try {
    [identityResponse, applicationResponse, guildsResponse] = await Promise.all([
      fetch(`${DISCORD_API}/users/@me`, { headers }),
      fetch(`${DISCORD_API}/oauth2/applications/@me`, { headers }),
      fetch(`${DISCORD_API}/users/@me/guilds?limit=200`, { headers }),
    ]);
  } catch (error) {
    console.error(
      "[Valax bot] Discord API request failed:",
      error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error"
    );
    sendJson(response, 502, {
      code: "DISCORD_API_UNREACHABLE",
      error: "Valax could not reach Discord. Wait a moment, then try again.",
    });
    return;
  }

  if (identityResponse.status === 401 || applicationResponse.status === 401) {
    sendJson(response, 401, { code: "BOT_TOKEN_INVALID", error: "Discord rejected this bot token." });
    return;
  }
  if (!identityResponse.ok || !applicationResponse.ok || !guildsResponse.ok) {
    sendJson(response, 502, { code: "DISCORD_API_ERROR", error: "Discord could not verify this bot right now." });
    return;
  }

  const [identity, application, discordGuilds] = await Promise.all([
    identityResponse.json(),
    applicationResponse.json(),
    guildsResponse.json(),
  ]);

  if (!identity.bot) {
    sendJson(response, 400, { code: "BOT_TOKEN_INVALID", error: "The supplied token does not belong to a Discord bot." });
    return;
  }

  const intents = intentStatus(application);
  const guilds = discordGuilds.map((guild) => ({
    id: guild.id,
    name: guild.name,
    icon: guild.icon || null,
    administrator: botHasAdministrator(guild),
  }));
  const inviteUrl = botInviteUrl(application.id || identity.id);
  const allIntents = Object.values(intents).every(Boolean);
  const hasAdministratorGuild = guilds.some((guild) => guild.administrator);
  const ready = allIntents && hasAdministratorGuild;
  const now = new Date();

  const connectionCount = await context.database.collection("botConnections").countDocuments({ userId: context.user._id });
  const alreadyConnected = await context.database.collection("botConnections").findOne({
    userId: context.user._id,
    botId: identity.id,
  });
  if (!alreadyConnected && connectionCount >= 10) {
    sendJson(response, 409, { code: "BOT_LIMIT_REACHED", error: "A Valax account can manage up to 10 bots." });
    return;
  }

  const connection = await context.database.collection("botConnections").findOneAndUpdate(
    { userId: context.user._id, botId: identity.id },
    {
      $set: {
        userId: context.user._id,
        botId: identity.id,
        applicationId: application.id || identity.id,
        username: identity.username,
        avatarUrl: avatarUrl(identity),
        encryptedToken: encryptSecret(token),
        intents,
        guilds,
        inviteUrl,
        ready,
        verifiedAt: now,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true, returnDocument: "after" }
  );

  sendJson(response, 200, {
    success: true,
    connection: publicBotConnection(connection),
    botConnections: publicBotConnections(await context.database.collection("botConnections")
      .find({ userId: context.user._id })
      .sort({ ready: -1, updatedAt: -1 })
      .toArray()),
    issues: {
      missingIntents: Object.entries(intents).filter(([, enabled]) => !enabled).map(([name]) => name),
      botNotInServer: guilds.length === 0,
      administratorMissing: !hasAdministratorGuild,
    },
  });
}

async function logout(request, response) {
  const sessionToken = parseCookies(request)[SESSION_COOKIE];
  if (sessionToken) {
    const database = await getDatabase();
    await database.collection("sessions").deleteOne({ tokenHash: hashToken(sessionToken) });
  }

  appendCookie(response, sessionCookie("", request, 0));
  sendJson(response, 200, { success: true });
}

export async function handleApiRequest(request, response) {
  const url = requestUrl(request);
  const method = (request.method || "GET").toUpperCase();

  try {
    if (method === "GET" && url.pathname === "/api/auth/discord") {
      await beginDiscordLogin(request, response, url);
      return true;
    }

    if (method === "GET" && url.pathname === "/api/callback") {
      await completeDiscordLogin(request, response, url);
      return true;
    }

    if (method === "GET" && url.pathname === "/api/session") {
      await getSession(request, response);
      return true;
    }

    if (method === "POST" && url.pathname === "/api/logout") {
      await logout(request, response);
      return true;
    }

    if (method === "GET" && url.pathname === "/api/onboarding/status") {
      await getOnboardingStatus(request, response);
      return true;
    }

    if (method === "POST" && url.pathname === "/api/onboarding/bot") {
      await configureBot(request, response);
      return true;
    }

    if (method === "GET" && url.pathname === "/api/dashboard") {
      await getDashboard(request, response, url);
      return true;
    }

    if (method === "POST" && url.pathname === "/api/dashboard/test") {
      await testDashboardGuild(request, response);
      return true;
    }

    if (method === "GET" && url.pathname === "/api/server") {
      await getServerWorkspace(request, response, url);
      return true;
    }

    if (method === "GET" && url.pathname === "/api/server/messages") {
      await getServerMessages(request, response, url);
      return true;
    }

    if (method === "POST" && url.pathname === "/api/server/messages") {
      await sendServerMessage(request, response);
      return true;
    }

    if (method === "GET" && url.pathname === "/api/server/members") {
      await getServerMembers(request, response, url);
      return true;
    }

    if (method === "GET" && url.pathname === "/api/server/dm") {
      await getDirectConversation(request, response, url);
      return true;
    }

    if (method === "POST" && url.pathname === "/api/server/dm") {
      await sendDirectMessage(request, response);
      return true;
    }

    if (method === "POST" && url.pathname === "/api/server/dm-campaigns") {
      await handleDmCampaignRequest(request, response);
      return true;
    }

    if (method === "GET" && url.pathname === "/api/server/dm-campaigns") {
      await getDmCampaignStatus(request, response, url);
      return true;
    }

    if (["GET", "PUT"].includes(method) && url.pathname === "/api/server/notifications") {
      await notificationSettings(request, response, url, method);
      return true;
    }

    if (method === "GET" && url.pathname === "/api/health") {
      getAuthConfig();
      getEncryptionKey();
      const database = await getDatabase();
      await database.command({ ping: 1 });
      sendJson(response, 200, {
        status: "ok",
        auth: "configured",
        database: "connected",
        botEncryption: "configured",
      });
      return true;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Not found" });
      return true;
    }

    return false;
  } catch (error) {
    const databaseCode = databaseErrorCode(error);
    const configurationCode = configurationErrorCode(error);
    const databaseUnavailable = Boolean(databaseCode);
    const serviceUnavailable = databaseUnavailable || Boolean(configurationCode);
    const errorCode = databaseCode || configurationCode || "OAUTH_FAILED";
    console.error(
      `[Valax API] ${url.pathname} failed [${errorCode}]:`,
      error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error"
    );

    if (url.pathname === "/api/callback") {
      redirect(response, databaseUnavailable ? "/login?error=database_unavailable" : "/login?error=oauth_failed");
    } else {
      sendJson(response, serviceUnavailable ? 503 : 500, {
        code: errorCode,
        error: databaseErrorMessage(errorCode),
      });
    }
    return true;
  }
}
