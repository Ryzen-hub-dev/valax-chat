/**
 * Discord OAuth 回调流程回归
 * =============================
 *
 * 【钉死的是什么】
 * 1. OAuth scope 必须含 `guilds.join` —— 否则「自动加入我们的服务器」做不到
 * 2. 用户**不在**我们的群 → 回调时自动加进去
 * 3. 自动加入**失败** → 如实记下错误（不静默当成「已加入」）
 * 4. 用户**已经**在群里 → 不重复调用加入接口
 * 5. 用户 token 加密存储（明文不落库）
 *
 * 【为什么单独一个文件】
 * OAuth 回调要**换一套 fetch mock**（Discord 的 token/users/guilds/join 端点），
 * 和工作流测试的那套 mock 完全不同。混在一起会让两套 mock 互相污染。
 *
 * ⚠️ **零外部依赖** —— 和主测试套件一样，不需要 MongoDB。
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { handleApiRequest } from "../lib/api-router.js";
import { closeDatabase, ensureDatabaseIndexes, getDatabase } from "../lib/database.js";

// ─────────────────────────────────────────────────────────────────────────────
// 测试环境自给自足
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
process.env.VALAX_DB_MODE = "memory";

const REQUIRED_GUILD = "1490285060765515946";
const DISCORD_USER_ID = "1490000000000009999";

let joinCalls = [];
let tokenExchangeCalls = 0;
/** 控制 mock 的行为 */
let scenario = {
  guilds: [],            // 用户当前在哪些群
  joinStatus: 204,       // 加入接口返回
  joinBody: null,        // 加入接口的 JSON 错误体
};

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(data); },
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const path = `${url.pathname}${url.search}`;
  const method = (init.method || "GET").toUpperCase();

  // OAuth token 交换
  if (path === "/api/oauth2/token" && method === "POST") {
    tokenExchangeCalls += 1;
    return json({
      access_token: "mock-access-token",
      token_type: "Bearer",
      scope: "identify email guilds guilds.join",
      expires_in: 604800,
    });
  }

  // 当前用户
  if (path === "/api/v10/users/@me") {
    return json({
      id: DISCORD_USER_ID,
      username: "valaxuser",
      global_name: "Valax User",
      avatar: null,
      email: "user@example.com",
      locale: "en-US",
      verified: true,
    });
  }

  // 用户所在的服务器
  if (path.startsWith("/api/v10/users/@me/guilds")) {
    return json(scenario.guilds);
  }

  // 自动加入我们的服务器
  if (path === `/api/v10/guilds/${REQUIRED_GUILD}/members/${DISCORD_USER_ID}` && method === "PUT") {
    joinCalls.push({ path, body: init.body });
    if (scenario.joinStatus === 204) return { ok: true, status: 204, async json() { return {}; } };
    return json(scenario.joinBody || { message: "Unknown Guild" }, scenario.joinStatus);
  }

  throw new Error(`unexpected Discord request: ${method} ${path}`);
};

class TestResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Map();
    this.body = "";
  }
  writeHead(status, headers) {
    this.statusCode = status;
    for (const [key, value] of Object.entries(headers || {})) this.headers.set(key.toLowerCase(), value);
  }
  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }
  getHeader(name) {
    return this.headers.get(name.toLowerCase());
  }
  end(body = "") {
    this.body = String(body);
  }
}

/** 发起一次 OAuth 回调（带合法的 state cookie）。 */
async function completeCallback(state = "valid-state") {
  const statePayload = Buffer.from(JSON.stringify({ state, returnTo: "/dashboard" }), "utf8").toString("base64url");
  const request = Readable.from([]);
  request.method = "GET";
  request.url = `http://localhost/api/callback?code=test-code&state=${encodeURIComponent(state)}`;
  request.headers = {
    host: "localhost",
    cookie: `valax_oauth_state=${encodeURIComponent(statePayload)}`,
  };
  const response = new TestResponse();
  await handleApiRequest(request, response);
  return { status: response.statusCode, location: response.getHeader("location"), body: response.body };
}

/** 直接构造 state cookie 并解析回调后的用户记录。 */
async function runCallbackAndReadUser() {
  const state = "valid-state";
  const statePayload = Buffer.from(JSON.stringify({ state, returnTo: "/dashboard" }), "utf8").toString("base64url");
  const request = Readable.from([]);
  request.method = "GET";
  request.url = `http://localhost/api/callback?code=test-code&state=${encodeURIComponent(state)}`;
  request.headers = {
    host: "localhost",
    cookie: `valax_oauth_state=${encodeURIComponent(statePayload)}`,
  };
  const response = new TestResponse();
  await handleApiRequest(request, response);
  const database = await getDatabase();
  const user = await database.collection("users").findOne({ discordId: DISCORD_USER_ID });
  return { status: response.statusCode, user };
}

let database;
try {
  await ensureDatabaseIndexes();
  database = await getDatabase();

  // ───────────────────────────────────────────────────────────────────────────
  // ① scope 必须含 `guilds.join`
  //
  // ⚠️ 断言的是**真正发给 Discord 的重定向 URL**（从 Location 头里取），
  //    不是 grep 源码 —— grep 只能证明「字符串出现过」，
  //    证明不了「真的发给了 Discord」。
  // ───────────────────────────────────────────────────────────────────────────
  {
    const request = Readable.from([]);
    request.method = "GET";
    request.url = "http://localhost/api/auth/discord";
    request.headers = { host: "localhost" };
    const response = new TestResponse();
    await handleApiRequest(request, response);

    assert.equal(response.statusCode, 302, "OAuth 应该是一次 302 重定向");
    const location = response.getHeader("location");
    assert.ok(location, "必须给 Location 头");
    const authorizeUrl = new URL(location);
    assert.equal(authorizeUrl.pathname, "/oauth2/authorize");

    const scope = authorizeUrl.searchParams.get("scope") || "";
    assert.ok(scope.includes("identify"), `scope 缺 identify: ${scope}`);
    assert.ok(scope.includes("email"), `scope 缺 email: ${scope}`);
    assert.ok(scope.includes("guilds"), `scope 缺 guilds: ${scope}`);
    assert.ok(
      scope.split(" ").includes("guilds.join"),
      `scope 缺 guilds.join（自动加入我们的服务器就做不到）: ${scope}`
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ② 用户**不在**群里 → 自动加进去
  // ───────────────────────────────────────────────────────────────────────────
  {
    scenario = { guilds: [], joinStatus: 204, joinBody: null };
    joinCalls = [];
    const { user } = await runCallbackAndReadUser();

    assert.equal(joinCalls.length, 1, "应该调用了一次自动加入");
    assert.equal(user.requiredGuildMember, true, "自动加入成功后应该算「已是成员」");
    assert.equal(user.autoJoinAttempted, true);
    assert.equal(user.autoJoinSucceeded, true);
    assert.equal(user.autoJoinError, null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ③ 自动加入**失败** → 如实记下错误，**不能**当成「已加入」
  // ───────────────────────────────────────────────────────────────────────────
  {
    scenario = {
      guilds: [],
      joinStatus: 403,
      joinBody: { message: "You do not have permission to add this member." },
    };
    joinCalls = [];
    const { user } = await runCallbackAndReadUser();

    assert.equal(joinCalls.length, 1, "应该尝试过自动加入");
    assert.equal(user.requiredGuildMember, false, "加入失败就不能算「已是成员」");
    assert.equal(user.autoJoinSucceeded, false);
    assert.ok(user.autoJoinError, "失败原因必须记下来，不能吞掉");
    assert.match(user.autoJoinError, /permission/i);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ④ 用户**已经**在群里 → 不重复调用加入接口
  // ───────────────────────────────────────────────────────────────────────────
  {
    scenario = {
      guilds: [{ id: REQUIRED_GUILD, name: "ValaxScrub", permissions: "32" }],
      joinStatus: 204,
      joinBody: null,
    };
    joinCalls = [];
    const { user } = await runCallbackAndReadUser();

    assert.equal(joinCalls.length, 0, "已经在群里就不该再调加入接口");
    assert.equal(user.requiredGuildMember, true, "本来就在群里");
    assert.equal(user.autoJoinAttempted, false, "没尝试加入就不该标记 attempted");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ⑤ 用户 token **加密**存储（明文不落库）
  // ───────────────────────────────────────────────────────────────────────────
  {
    scenario = {
      guilds: [{ id: REQUIRED_GUILD, name: "ValaxScrub", permissions: "32" }],
      joinStatus: 204,
      joinBody: null,
    };
    const { user } = await runCallbackAndReadUser();

    assert.ok(user.encryptedUserToken, "必须存加密后的用户 token");
    // ⚠️ 断言**结构**而不是解密 —— 这样测试不需要知道密钥
    assert.equal(typeof user.encryptedUserToken, "object");
    assert.ok(user.encryptedUserToken.iv, "密文必须有 iv");
    assert.ok(user.encryptedUserToken.tag, "密文必须有 auth tag");
    assert.ok(user.encryptedUserToken.data, "密文必须有数据");
    // ⚠️ 密文里**不能**出现明文 token
    assert.ok(
      !JSON.stringify(user.encryptedUserToken).includes("mock-access-token"),
      "用户 token 不能以明文落库"
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ⑥ 名字 / 邮箱 / id 都被授权下来了（用户的要求：授权我们的名字邮箱id）
  // ───────────────────────────────────────────────────────────────────────────
  {
    scenario = {
      guilds: [{ id: REQUIRED_GUILD, name: "ValaxScrub", permissions: "32" }],
      joinStatus: 204,
      joinBody: null,
    };
    const { user } = await runCallbackAndReadUser();

    assert.equal(user.discordId, DISCORD_USER_ID, "必须存 Discord id");
    assert.equal(user.username, "valaxuser", "必须存用户名");
    assert.equal(user.email, "user@example.com", "必须存邮箱");
  }

  console.log("Valax Discord OAuth scope (identify/email/guilds/guilds.join) passed.");
  console.log("Valax community auto-join (success / refusal / already-member / encrypted token) passed.");
} finally {
  globalThis.fetch = originalFetch;
  if (database) {
    await database.collection("users").deleteMany({ discordId: DISCORD_USER_ID });
    await database.collection("sessions").deleteMany({});
  }
  await closeDatabase();
}
