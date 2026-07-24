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

The `/dashboard` workspace manages up to ten encrypted Bot connections and synchronizes the selected
Bot's server list from Discord. Administrators
can run an explicit connection test for each server; Valax sends one notification-suppressed test
message, removes it immediately, and stores only the server, channel, result, and timestamp.

After a server passes its connection test, `/server` provides the channel workspace. It loads recent
Discord messages, renders custom and animated Discord emoji, stickers, images, GIFs, videos, and file
attachments, and sends standard messages or announcements through the connected Bot. Channel and
one-to-one DM composers accept one PNG, JPEG, WebP, AVIF, GIF, MP4, WebM, or MOV attachment up to
4 MB. Files are forwarded directly to Discord and are not stored by Valax or MongoDB. Channel
messages can also send up to three Discord server stickers. Announcement channels support Discord
crossposting. Dynamic `/date`,
`/time`, and `/server` values are resolved on the server, and mention parsing is disabled by default.
Message audit records contain delivery metadata only and expire after 90 days; message content is not
stored in MongoDB.

The server workspace also includes a searchable member directory, explicit user mentions, Discord
message replies, one-to-one Bot DMs, one-click private messages from a channel author, and a recent
conversation shortcut list. Recent conversation records contain only participant identity and activity
timestamps. Channel messages and active DMs use incremental synchronization and a five-minute channel
validation cache to reduce Discord API traffic. Notification preferences are stored per account, Bot,
and server; normal messages, mentions, replies, and DMs use separate browser tones with quiet hours
and an anti-noise grouping window. Desktop alerts require an explicit browser permission and work while
Valax remains open or backgrounded; closed-browser push delivery requires a separate persistent push
service and is intentionally not claimed by this project.

Member-wide DM notifications run as resumable campaigns. A campaign requires an exact server-name
confirmation, processes one recipient per serverless request, honors Discord `retry_after`, detects
`STOP`, `UNSUBSCRIBE`, or `OPT OUT`, and prevents a recipient from receiving another campaign message
from the same Bot and server for 24 hours. A server can start one campaign every six hours, and a
campaign is limited to the first 1,000 eligible human members. Campaign content is encrypted while
delivery is active and removed when the campaign completes or is cancelled. Delivery audit records
never contain message content.

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

## Verification

Run the database migration and workflow tests before deployment:

```powershell
npm run db:init
npm test
```

The workflow test uses a temporary MongoDB user record and mocked Discord responses to verify Bot
selection, member mentions, replies, server emoji and sticker discovery, multipart image delivery,
direct messages, recent conversations, campaigns, and notification settings. Temporary records are
removed in a `finally` block even when an assertion fails.
