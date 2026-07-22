import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function parseEnvFile(source) {
  const values = {};

  for (const originalLine of source.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) continue;

    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

for (const filename of [".env.local", ".env"]) {
  const filePath = resolve(projectRoot, filename);
  if (!existsSync(filePath)) continue;

  const values = parseEnvFile(readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function requireValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getAuthConfig() {
  return {
    clientId: requireValue("DISCORD_CLIENT_ID"),
    clientSecret: requireValue("DISCORD_CLIENT_SECRET"),
    redirectUri: requireValue("DISCORD_REDIRECT_URI"),
    siteUrl: requireValue("SITE_URL").replace(/\/$/, ""),
    requiredGuildId: process.env.DISCORD_REQUIRED_GUILD_ID?.trim() || null,
  };
}

export function getDatabaseConfig() {
  return {
    uri: requireValue("MONGODB_URI"),
    databaseName: process.env.MONGODB_DB_NAME?.trim() || "valax",
  };
}

