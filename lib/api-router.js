import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendCookie, parseCookies, serializeCookie } from "./cookies.js";
import { ensureDatabaseIndexes, getDatabase } from "./database.js";
import { getAuthConfig } from "./env.js";
import { decryptSecret, encryptSecret } from "./encryption.js";

const SESSION_COOKIE = "valax_session";
const STATE_COOKIE = "valax_oauth_state";
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;
const DISCORD_API = "https://discord.com/api/v10";
const ADMINISTRATOR_PERMISSION = 8n;
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

  let source = "";
  for await (const chunk of request) {
    source += chunk;
    if (source.length > 8_192) throw new Error("Request body is too large.");
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

function databaseErrorMessage(code) {
  const messages = {
    DATABASE_CONFIG_INVALID: "The MongoDB connection string is not configured correctly.",
    DATABASE_AUTH_FAILED: "MongoDB rejected the configured database credentials.",
    DATABASE_DNS_FAILED: "The MongoDB cluster address could not be resolved.",
    DATABASE_NETWORK_BLOCKED: "MongoDB Atlas could not be reached from the server region.",
    DATABASE_UNAVAILABLE: "The database connection is temporarily unavailable.",
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

  const body = await readJsonBody(request);
  const existing = await context.database.collection("botConnections").findOne({ userId: context.user._id });
  let token = typeof body.token === "string" ? body.token.trim().replace(/^Bot\s+/i, "") : "";

  if (!token && existing?.encryptedToken) token = decryptSecret(existing.encryptedToken);
  if (token.length < 40 || token.length > 200 || /\s/.test(token)) {
    sendJson(response, 400, { code: "BOT_TOKEN_REQUIRED", error: "Enter a valid Discord bot token." });
    return;
  }

  const headers = { Authorization: `Bot ${token}` };
  const [identityResponse, applicationResponse, guildsResponse] = await Promise.all([
    fetch(`${DISCORD_API}/users/@me`, { headers }),
    fetch(`${DISCORD_API}/oauth2/applications/@me`, { headers }),
    fetch(`${DISCORD_API}/users/@me/guilds?limit=200`, { headers }),
  ]);

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

    if (method === "GET" && url.pathname === "/api/health") {
      getAuthConfig();
      const database = await getDatabase();
      await database.command({ ping: 1 });
      sendJson(response, 200, { status: "ok", auth: "configured", database: "connected" });
      return true;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Not found" });
      return true;
    }

    return false;
  } catch (error) {
    const databaseCode = databaseErrorCode(error);
    const databaseUnavailable = Boolean(databaseCode);
    const errorCode = databaseCode || "OAUTH_FAILED";
    console.error(
      `[Valax API] ${url.pathname} failed [${errorCode}]:`,
      error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error"
    );

    if (url.pathname === "/api/callback") {
      redirect(response, databaseUnavailable ? "/login?error=database_unavailable" : "/login?error=oauth_failed");
    } else {
      sendJson(response, databaseUnavailable ? 503 : 500, {
        code: errorCode,
        error: databaseErrorMessage(errorCode),
      });
    }
    return true;
  }
}
