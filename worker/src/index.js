/**
 * Telegram → GitHub Pages publishing bot.
 *
 * Deployment secrets (set with `wrangler secret put`):
 *   TELEGRAM_BOT_TOKEN  – token from @BotFather
 *   GITHUB_TOKEN        – fine-grained PAT with Contents read/write on the repo
 *   CHAT_ID             – numeric Telegram chat ID allowed to publish
 *   WEBHOOK_SECRET      – random string used in the webhook URL
 *
 * Vars (set in wrangler.toml):
 *   GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, POSTS_DIR, IMAGES_DIR, SITE_NAME
 */

const GITHUB_API = 'https://api.github.com';
const TELEGRAM_API = 'https://api.telegram.org';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== `/webhook/${env.WEBHOOK_SECRET}`) {
      return new Response('Not found', { status: 404 });
    }

    const update = await request.json();
    // Respond 200 immediately; process async so Telegram doesn't time out on retries.
    if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
      return new Response('Bad secret token', { status: 403 });
    }
    // Handle synchronously but never throw: Telegram retries on non-2xx.
    try {
      await handleUpdate(update, env);
    } catch (err) {
      console.error('handleUpdate failed:', err);
      await sendTelegram(env, update, 'Something went wrong on my side. The post was not published.');
    }
    return new Response('ok');
  },
};

/* ————— telegram plumbing ————— */

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.text && !msg.photo) return;

  const chatId = String(msg.chat.id);
  if (chatId !== String(env.CHAT_ID)) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'Not authorized.' });
    return;
  }

  if (msg.text && msg.text.startsWith('/')) {
    await handleCommand(msg, env);
    return;
  }

  await publishPost(msg, env);
}

async function handleCommand(msg, env) {
  const [cmd, ...args] = msg.text.trim().split(/\s+/);
  switch (cmd.toLowerCase()) {
    case '/help':
      await tg(env, 'sendMessage', {
        chat_id: msg.chat.id,
        text: [
          'How to publish:',
          '',
          '1. Send me a message. First line = title, rest = body.',
          '2. Markdown (bold, italic, code, links) is kept.',
          '3. Attach a photo with a caption to include an image.',
          '4. Start the title with "#draft" to save without publishing.',
          '',
          'Commands:',
          '/latest – list recent posts',
          '/delete <slug> – remove a post',
        ].join('\n'),
      });
      break;

    case '/latest':
      await cmdLatest(msg, env);
      break;

    case '/delete':
      await cmdDelete(msg, args[0], env);
      break;

    default:
      await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Unknown command. Try /help.' });
  }
}

async function cmdLatest(msg, env) {
  const manifest = await getManifest(env);
  const posts = manifest.posts
    .filter((p) => !p.draft)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10)
    .map((p) => `• \`${p.slug}\` — ${p.title} (${p.date.slice(0, 10)})`);
  await tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: posts.length ? 'Recent posts:\n\n' + posts.join('\n') : 'No posts yet.',
    parse_mode: 'MarkdownV2',
  }).catch(async () => {
    // MarkdownV2 escaping is brittle; fall back to plain text.
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: 'Recent posts:\n\n' + manifest.posts.map((p) => `• ${p.slug} — ${p.title}`).join('\n'),
    });
  });
}

async function cmdDelete(msg, slug, env) {
  if (!slug) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Usage: /delete <slug>' });
    return;
  }
  const manifest = await getManifest(env);
  const idx = manifest.posts.findIndex((p) => p.slug === slug);
  if (idx === -1) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `No post found with slug "${slug}". Use /latest to list slugs.` });
    return;
  }
  const title = manifest.posts[idx].title;
  await deleteFile(env, `${env.POSTS_DIR}/${slug}.md`);
  manifest.posts.splice(idx, 1);
  await putManifest(env, manifest);
  await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `Deleted "${title}".` });
}

/* ————— publishing ————— */

async function publishPost(msg, env) {
  const isPhoto = !!msg.photo;
  let title, body;

  if (isPhoto) {
    title = (msg.caption || 'Untitled').split('\n')[0].replace(/^#draft\s*/i, '');
    body = (msg.caption || '').split('\n').slice(1).join('\n');
  } else {
    title = msg.text.split('\n')[0].replace(/^#draft\s*/i, '');
    body = msg.text.split('\n').slice(1).join('\n');
  }
  const draft = /^#draft/i.test((msg.text || msg.caption || '').split('\n')[0]);
  if (!title.trim()) title = 'Untitled';

  // Telegram photos arrive in several sizes; pick the largest that's still a JPEG.
  let imageMd = '';
  if (isPhoto) {
    const photo = msg.photo.reduce((a, b) => (a.file_size > b.file_size ? a : b));
    const imageUrl = await commitImage(env, photo.file_id, msg.date);
    imageMd = `![image](${imageUrl})\n\n`;
  }

  const slug = slugify(title);
  const now = new Date().toISOString();
  const rawText = isPhoto ? (msg.caption || '') : msg.text;
  const entities = isPhoto ? (msg.caption_entities || []) : (msg.entities || []);
  // Convert the whole message to Markdown, then drop the title line from the body.
  const fullMd = entitiesToMarkdown(rawText, entities);
  const bodyMd = rawText.includes('\n') ? fullMd.slice(fullMd.indexOf('\n') + 1) : '';
  const md = imageMd + bodyMd;

  // Read-modify-write the manifest; retry on commit races.
  for (let attempt = 0; attempt < 4; attempt++) {
    const manifest = await getManifest(env);
    const existing = manifest.posts.findIndex((p) => p.slug === slug);
    const entry = {
      slug,
      title,
      date: existing !== -1 ? manifest.posts[existing].date : now,
      teaser: md.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[#>*_`~\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160),
      draft,
    };
    if (existing !== -1) manifest.posts[existing] = entry;
    else manifest.posts.push(entry);

    try {
      await putFile(env, `${env.POSTS_DIR}/${slug}.md`, md, existing !== -1 ? 'edit post' : 'new post');
      await putManifest(env, manifest);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(800);
    }
  }

  await tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: `${draft ? 'Draft saved' : 'Published'}: “${title}”\nSlug: ${slug}${draft ? '\nSend the same title again without #draft to publish.' : ''}`,
  });
}

/* Apply Telegram message entities to raw text, producing Markdown. */
function entitiesToMarkdown(text, entities) {
  // Walk entities right-to-left so earlier offsets stay valid.
  const sorted = [...entities].sort((a, b) => b.offset - a.offset);
  let out = text;
  for (const e of sorted) {
    // Entity offsets are in UTF-16 code units, matching JS string indices.
    const start = e.offset, end = e.offset + e.length;
    const inner = out.slice(start, end);
    let wrapped;
    switch (e.type) {
      case 'bold': case 'italic': case 'underline': case 'strikethrough': {
        const mark = e.type === 'bold' ? '**' : e.type === 'italic' ? '*' : e.type === 'underline' ? '<u>' : '~~';
        wrapped = e.type === 'underline' ? `<u>${inner}</u>` : `${mark}${inner}${mark}`;
        break;
      }
      case 'code': wrapped = '`' + inner + '`'; break;
      case 'pre': wrapped = '```\n' + inner + '\n```'; break;
      case 'blockquote': wrapped = inner.split('\n').map((l) => '> ' + l).join('\n'); break;
      case 'url': wrapped = `[${inner}](${inner})`; break;
      case 'text_link': wrapped = `[${inner}](${e.url})`; break;
      default: wrapped = inner;
    }
    out = out.slice(0, start) + wrapped + out.slice(end);
  }
  return out;
}

function slugify(s) {
  const base = s.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return base || `post-${Date.now()}`;
}

async function commitImage(env, fileId, unixDate) {
  const fileMeta = await tg(env, 'getFile', { file_id: fileId });
  const dl = await fetch(`${TELEGRAM_API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileMeta.file_path}`);
  if (!dl.ok) throw new Error(`image download ${dl.status}`);
  const buf = new Uint8Array(await dl.arrayBuffer());

  const ext = (fileMeta.file_path.split('.').pop() || 'jpg').toLowerCase();
  const d = new Date(unixDate * 1000);
  const name = `${d.toISOString().slice(0, 10)}-${Date.now()}.${ext}`;
  await putFileBinary(env, `${env.IMAGES_DIR}/${name}`, buf, 'add image');
  return `/${env.IMAGES_DIR}/${name}`;
}

/* ————— github contents api ————— */

function gh(env, path) {
  return `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
}

function ghHeaders(env) {
  return {
    // GitHub rejects API requests without a User-Agent; Workers fetch strips the default one.
    'User-Agent': 'tg-blog-bot',
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function getSha(env, path) {
  const res = await fetch(`${gh(env, path)}?ref=${env.GITHUB_BRANCH}`, { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getSha ${path} → ${res.status}`);
  return (await res.json()).sha;
}

async function putFile(env, path, text, message) {
  return putFileBase(env, path, btoa(unescape(encodeURIComponent(text))), message);
}

async function putFileBinary(env, path, bytes, message) {
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return putFileBase(env, path, btoa(bin), message);
}

async function putFileBase(env, path, base64, message) {
  const sha = await getSha(env, path);
  const res = await fetch(gh(env, path), {
    method: 'PUT',
    headers: ghHeaders(env),
    body: JSON.stringify({
      message,
      content: base64,
      branch: env.GITHUB_BRANCH,
      sha: sha || undefined,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`putFile ${path} → ${res.status}: ${detail.slice(0, 300)}`);
  }
}

async function deleteFile(env, path) {
  const sha = await getSha(env, path);
  if (!sha) return;
  const res = await fetch(gh(env, path), {
    method: 'DELETE',
    headers: ghHeaders(env),
    body: JSON.stringify({ message: 'delete post', sha, branch: env.GITHUB_BRANCH }),
  });
  if (!res.ok && res.status !== 404) throw new Error(`deleteFile ${path} → ${res.status}`);
}

async function getManifest(env) {
  const res = await fetch(`${gh(env, `${env.POSTS_DIR}/index.json`)}?ref=${env.GITHUB_BRANCH}`, {
    headers: ghHeaders(env),
  });
  if (res.status === 404) return { posts: [] };
  if (!res.ok) throw new Error(`getManifest → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const text = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ''))));
  return JSON.parse(text);
}

async function putManifest(env, manifest) {
  manifest.posts.sort((a, b) => b.date.localeCompare(a.date));
  await putFile(env, `${env.POSTS_DIR}/index.json`, JSON.stringify(manifest, null, 2) + '\n', 'update index');
}

/* ————— misc ————— */

async function tg(env, method, payload) {
  const res = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error(`tg ${method} failed: ${detail.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

function sendTelegram(env, update, text) {
  const chatId = update?.message?.chat?.id;
  if (!chatId) return;
  return tg(env, 'sendMessage', { chat_id: chatId, text });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
