# Valax

Valax is a free Discord bot communication workspace by Jotoro. This repository contains the
public English landing page, interactive product preview, Discord OAuth2 login, required-community
membership check, and encrypted Discord bot onboarding flow backed by MongoDB.

## Local preview

Run the zero-dependency Node.js preview server:

```powershell
npm run dev
```

The frontend is static, while the API endpoints run as Node.js functions on Vercel or through the
included local server. After signing in, `/setup` checks ValaxScrub membership and verifies the
bot identity, privileged intents, connected servers, and Administrator permission.

The `/dashboard` workspace synchronizes the connected Bot server list from Discord. Administrators
can run an explicit connection test for each server; Valax sends one notification-suppressed test
message, removes it immediately, and stores only the server, channel, result, and timestamp.

After a server passes its connection test, `/server` provides the channel workspace. It loads recent
Discord messages, displays image and file attachments, and sends standard messages or announcements
through the connected Bot. Announcement channels support Discord crossposting. Dynamic `/date`,
`/time`, and `/server` values are resolved on the server, and mention parsing is disabled by default.
Message audit records contain delivery metadata only and expire after 90 days; message content is not
stored in MongoDB.

## Authentication configuration

Create `.env.local` from `.env.example`, then add the Discord OAuth2 application and MongoDB Atlas
values. Run `npm run db:init` once to verify the connection and create the indexes. Never commit the
real `.env.local` file.

Required variables:

```text
MONGODB_URI
MONGODB_DB_NAME
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
DISCORD_REDIRECT_URI
SITE_URL
DISCORD_REQUIRED_GUILD_ID
DISCORD_INVITE_CODE
BOT_TOKEN_ENCRYPTION_KEY
```

Generate `BOT_TOKEN_ENCRYPTION_KEY` once as 32 random bytes encoded with base64url. Keep the same
value for the lifetime of stored bot connections; changing it prevents existing tokens from being
decrypted. Bot Tokens are validated only on the server and stored with AES-256-GCM encryption.

For production, add every variable to the Vercel Production environment and redeploy. The Discord
application redirect URI must exactly match `${SITE_URL}/api/callback`.
