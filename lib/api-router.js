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
const MESSAGE_CHANNEL_TYPES = new Set([0, 5]);
const INTENT_FLAGS = {
  presence: 1 << 12 | 1 << 13,
  members: 1 << 14 | 1 << 15,
  messageContent: 1 << 18 | 1 << 19,
};

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
  };
}

async function getOnboardingStatus(request, response) {
  const context = await authenticatedContext(request, response);
  if (!context) {
    sendJson(response, 401, { code: "AUTH_REQUIRED", authenticated: false });
    return;
  }

  const config = getAuthConfig();
  const connection = await context.database.collection("botConnections").findOne({ userId: context.user._id });
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

async function getDashboardContext(request, response) {
  const context = await authenticatedContext(request, response);
  if (!context) {
    sendJson(response, 401, { code: "AUTH_REQUIRED", error: "Sign in to open the dashboard." });
    return null;
  }

  if (context.user.requiredGuildMember !== true) {
    sendJson(response, 403, { code: "SETUP_REQUIRED", error: "Complete the Valax community check first." });
    return null;
  }

  const connection = await context.database.collection("botConnections").findOne({ userId: context.user._id });
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

async function getDashboard(request, response) {
  const context = await getDashboardContext(request, response);
  if (!context) return;

  let guildResponse;
  try {
    guildResponse = await fetch(`${DISCORD_API}/users/@me/guilds?limit=200`, {
      headers: discordBotHeaders(context.token),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
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

  sendJson(response, 200, {
    authenticated: true,
    user: publicUser(context.user),
    bot: dashboardBot(context.connection),
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
  const context = await getDashboardContext(request, response);
  if (!context) return;

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { code: "INVALID_REQUEST_BODY", error: "The server test request was not valid JSON." });
    return;
  }

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

  const checkFilter = { userId: context.user._id, guildId };
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

  const existing = await context.database.collection("botConnections").findOne({ userId: context.user._id });
  let token = typeof body.token === "string" ? body.token.trim().replace(/^Bot\s+/i, "") : "";

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

  const connection = await context.database.collection("botConnections").findOneAndUpdate(
    { userId: context.user._id },
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
      await getDashboard(request, response);
      return true;
    }

    if (method === "POST" && url.pathname === "/api/dashboard/test") {
      await testDashboardGuild(request, response);
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
