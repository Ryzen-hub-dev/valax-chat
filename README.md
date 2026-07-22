# Valax

Valax is a free Discord bot communication workspace by Jotoro. This repository contains the
public English landing page, interactive product preview, and Discord OAuth2 login flow backed by
MongoDB sessions.

## Local preview

Run the zero-dependency Node.js preview server:

```powershell
npm run dev
```

The frontend is static, while the OAuth endpoints run as Node.js functions on Vercel or through the
included local server. Bot token handling and the dashboard are intentionally outside this login
milestone.

## Authentication configuration

Create `.env.local` from `.env.example`, then add the Discord OAuth2 application and MongoDB Atlas
values. Run `npm run db:init` once to verify the connection and create the indexes. Never commit the
real `.env.local` file.
