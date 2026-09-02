# Telegram-published blog on GitHub Pages

A minimal, editorial blog. You write posts by messaging a Telegram bot; a Cloudflare Worker
commits them to this repo; GitHub Pages serves the static site.

```
You (Telegram) → Cloudflare Worker → commit to repo → GitHub Pages rebuilds
```

## Repo layout

```
site/                 the blog itself (plain HTML/CSS/JS, no build step)
  posts/              Markdown posts + index.json manifest (bot-managed)
  assets/             stylesheet, scripts, images
worker/               Cloudflare Worker (the Telegram bot)
```

## One-time setup

### 1. GitHub repo + Pages

1. Create a public repo and push this project to it (branch `main`).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**
   (or "Deploy from a branch: main / root"). If you choose GitHub Actions, this
   workflow file covers it:

   `.github/workflows/pages.yml` — see below, or pick "Deploy from a branch"
   with folder `/root` and skip the workflow.

3. Note your repo URL, e.g. `https://github.com/your-username/your-repo`.

### 2. GitHub token

Create a **fine-grained personal access token**: GitHub → Settings → Developer
settings → Fine-grained tokens → Generate.

- Repository access: only your blog repo
- Permissions: **Contents → Read and write**

### 3. Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Get your numeric chat ID: message [@userinfobot](https://t.me/userinfobot),
   it replies with your "Id".

### 4. Deploy the worker

```bash
cd worker
npm install
npx wrangler login
```

Edit `worker/wrangler.toml` — set `GITHUB_OWNER` and `GITHUB_REPO`.

Set the secrets (each prompts for a value):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN   # token from BotFather
npx wrangler secret put GITHUB_TOKEN         # fine-grained PAT from step 2
npx wrangler secret put CHAT_ID              # your numeric Telegram chat ID
npx wrangler secret put WEBHOOK_SECRET       # any long random string, e.g. from: openssl rand -hex 24
```

Deploy:

```bash
npm run deploy
```

Note the deployed URL, e.g. `https://tg-blog-bot.<your-subdomain>.workers.dev`.

### 5. Register the Telegram webhook

Use the same `WEBHOOK_SECRET` value in both places:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://tg-blog-bot.<your-subdomain>.workers.dev/webhook/<WEBHOOK_SECRET>" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

Telegram should reply `{"ok":true,...}`.

## Publishing

Message your bot:

- **First line = title**, the rest is the body. Example:

  ```
  Notes on quiet software
  Most tools are too loud. Here's what I'd rather use...
  ```

- Telegram formatting (bold, italic, code, links, quotes) carries into the post.
- **Attach a photo** with the caption structured the same way — the image is
  uploaded to `site/assets/img/` and placed at the top of the post.
- Start the first line with `#draft` (e.g. `#draft My title`) to save without
  publishing. Re-send without the tag to publish it.
- Commands: `/latest`, `/delete <slug>`, `/help`.

After publishing, GitHub Pages rebuilds (usually under a minute) and the post
appears on the site.

## Customizing the site

- Site name, tagline, footer link: edit `site/index.html` and `site/post.html`.
- Look and feel: everything lives in `site/assets/style.css` — palette variables
  are at the top under `:root`.

## Local preview of the site

```bash
cd site
python -m http.server 8080    # then open http://localhost:8080
```

## Troubleshooting

- **Bot doesn't reply at all** — webhook not set, or wrong URL. Re-run step 5 and
  check with `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`.
- **"Something went wrong on my side"** — check worker logs with
  `npx wrangler tail`. Usually a bad `GITHUB_TOKEN` (needs Contents read/write)
  or wrong `GITHUB_OWNER`/`GITHUB_REPO`.
- **"Not authorized"** — `CHAT_ID` secret doesn't match your chat ID.
- **Post published but not on site** — Pages hasn't rebuilt yet, or Pages is
  serving from a different branch.
