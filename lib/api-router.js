import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendCookie, parseCookies, serializeCookie } from "./cookies.js";
import { ensureDatabaseIndexes, getDatabase } from "./database.js";
import { getAuthConfig } from "./env.js";

const SESSION_COOKIE = "valax_session";
const STATE_COOKIE = "valax_oauth_state";
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;

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

function isDatabaseConnectionError(error) {
  if (!(error instanceof Error)) return false;
  return (
    error.name.startsWith("Mongo") ||
    /server selection|querysrv|econnrefused|enotfound|etimeout|mongodb/i.test(error.message)
  );
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

async function beginDiscordLogin(request, response, url) {
  const config = getAuthConfig();
  const state = randomBytes(24).toString("base64url");
  const returnTo = normalizeReturnTo(url.searchParams.get("returnTo"));
  const statePayload = Buffer.from(JSON.stringify({ state, returnTo }), "utf8").toString("base64url");

  appendCookie(response, stateCookie(statePayload, request, 10 * 60));

  const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "identify email guilds",
    state,
  }).toString();

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

async function getSession(request, response) {
  const sessionToken = parseCookies(request)[SESSION_COOKIE];
  if (!sessionToken) {
    sendJson(response, 200, { authenticated: false });
    return;
  }

  const database = await getDatabase();
  const session = await database.collection("sessions").findOne({
    tokenHash: hashToken(sessionToken),
    expiresAt: { $gt: new Date() },
  });

  if (!session) {
    appendCookie(response, sessionCookie("", request, 0));
    sendJson(response, 200, { authenticated: false });
    return;
  }

  const user = await database.collection("users").findOne({ _id: session.userId });
  if (!user) {
    await database.collection("sessions").deleteOne({ _id: session._id });
    appendCookie(response, sessionCookie("", request, 0));
    sendJson(response, 200, { authenticated: false });
    return;
  }

  sendJson(response, 200, {
    authenticated: true,
    user: {
      id: user.discordId,
      username: user.username,
      displayName: user.globalName || user.username,
      avatarUrl: user.avatarUrl,
      guildCount: user.guildCount || 0,
      requiredGuildMember: user.requiredGuildMember,
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
    const databaseUnavailable = isDatabaseConnectionError(error);
    const errorCode = databaseUnavailable ? "DATABASE_UNAVAILABLE" : "OAUTH_FAILED";
    console.error(
      `[Valax API] ${url.pathname} failed [${errorCode}]:`,
      error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error"
    );

    if (url.pathname === "/api/callback") {
      redirect(response, databaseUnavailable ? "/login?error=database_unavailable" : "/login?error=oauth_failed");
    } else {
      sendJson(response, databaseUnavailable ? 503 : 500, {
        code: errorCode,
        error: databaseUnavailable
          ? "The database connection is temporarily unavailable."
          : "The authentication service is temporarily unavailable.",
      });
    }
    return true;
  }
}
