export function parseCookies(request) {
  const cookies = {};
  const source = request.headers.cookie || "";

  for (const pair of source.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;

    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!key) continue;

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }

  return cookies;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  parts.push(`Path=${options.path || "/"}`);
  return parts.join("; ");
}

export function appendCookie(response, cookie) {
  const current = response.getHeader("Set-Cookie");
  if (!current) {
    response.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(current)) {
    response.setHeader("Set-Cookie", [...current, cookie]);
  } else {
    response.setHeader("Set-Cookie", [current, cookie]);
  }
}

