/**
 * Telegram → GitHub Pages publishing bot (interactive edition).
 *
 * Flow: send content → see a preview with inline buttons → publish / draft / edit / cancel.
 * Or use /new for a guided step-by-step flow (title → body → optional photo → preview).
 *
 * Secrets (`wrangler secret put`):
 *   TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, CHAT_ID, WEBHOOK_SECRET
 * Vars (wrangler.toml):
 *   GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, POSTS_DIR, IMAGES_DIR, SITE_URL
 * KV binding:
 *   SESSIONS — per-chat draft state
 */

const GITHUB_API = 'https://api.github.com';
const TELEGRAM_API = 'https://api.telegram.org';
const SESSION_TTL = 6 * 3600; // draft sessions expire after 6h

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== `/webhook/${env.WEBHOOK_SECRET}`) {
      return new Response('Not found', { status: 404 });
    }
    if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
      return new Response('Bad secret token', { status: 403 });
    }

    const update = await request.json();
    try {
      await handleUpdate(update, env);
    } catch (err) {
      console.error('handleUpdate failed:', err);
      const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
      if (chatId) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'Something went wrong on my side. Nothing was published.' });
      }
    }
    return new Response('ok');
  },
};

/* ————— routing ————— */

async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);

  const msg = update.message;
  if (!msg || (!msg.text && !msg.photo)) return;

  const chatId = msg.chat.id;
  if (String(chatId) !== String(env.CHAT_ID)) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'Not authorized.' });
    return;
  }

  if (msg.text && msg.text.startsWith('/')) return handleCommand(msg, env);
  if (await getSession(env, chatId)) return handleFlowMessage(msg, env);
  return previewFromContent(msg, env);
}

/* ————— commands ————— */

async function handleCommand(msg, env) {
  const [cmd, ...args] = msg.text.trim().split(/\s+/);
  const chatId = msg.chat.id;
  switch (cmd.toLowerCase()) {
    case '/start':
    case '/help':
      await clearSession(env, chatId);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: [
          'How publishing works:',
          '',
          '1. Send me anything — a message, or a photo with a caption.',
          '2. First line becomes the title, the rest is the body.',
          '3. You get a preview with buttons: publish, save as draft, edit, or cancel.',
          '',
          'Or /new for a guided flow: I ask for title, body, then an optional photo.',
          '',
          'Formatting: bold, italic, `code`, links, quotes — all kept.',
          'Commands: /new · /latest · /drafts · /cancel · /help',
        ].join('\n'),
      });
      break;

    case '/new':
      await setSession(env, chatId, { flow: 'new', step: 'title', title: '', body: '', photo_file_id: null });
      await tg(env, 'sendMessage', { chat_id: chatId, text: 'Let’s write a post.\n\nWhat’s the title? (Send /cancel to stop.)' });
      break;

    case '/latest':
      return listPosts(msg, env, false);
    case '/drafts':
      return listPosts(msg, env, true);

    case '/delete': {
      const slug = args[0];
      if (!slug) return tg(env, 'sendMessage', { chat_id: chatId, text: 'Usage: /delete <slug> — or use /latest and tap 🗑.' });
      return confirmDelete(msg, slug, env);
    }

    case '/skip': {
      const sess = await getSession(env, msg.chat.id);
      if (sess && sess.step === 'photo') return sendPreview(env, msg.chat.id, sess);
      return tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Nothing to skip right now.' });
    }

    case '/cancel':
      await clearSession(env, chatId);
      await tg(env, 'sendMessage', { chat_id: chatId, text: 'Okay, cancelled.' });
      break;

    default:
      await tg(env, 'sendMessage', { chat_id: chatId, text: 'Unknown command. Try /help.' });
  }
}

async function listPosts(msg, env, drafts) {
  const manifest = await getManifest(env);
  const posts = manifest.posts
    .filter((p) => !!p.draft === drafts)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 15);

  if (!posts.length) {
    return tg(env, 'sendMessage', { chat_id: msg.chat.id, text: drafts ? 'No drafts.' : 'No posts yet.' });
  }

  const rows = posts.map((p) => [{
    text: `🗑 ${p.title}`,
    callback_data: `del:${p.slug}`,
  }]);
  await tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: (drafts ? 'Drafts — tap to delete:\n\n' : 'Published — tap 🗑 to delete:\n\n') +
      posts.map((p) => `• ${p.title} (${p.date.slice(0, 10)})`).join('\n'),
    reply_markup: { inline_keyboard: rows },
  });
}

/* ————— guided flow (/new, edit) ————— */

async function handleFlowMessage(msg, env) {
  const chatId = msg.chat.id;
  const sess = await getSession(env, chatId);

  switch (sess.step) {
    case 'title':
      if (!msg.text) {
        return tg(env, 'sendMessage', { chat_id: chatId, text: 'That’s not text. Please send the title, or /cancel.' });
      }
      sess.title = msg.text.trim();
      sess.step = 'body';
      await setSession(env, chatId, sess);
      await tg(env, 'sendMessage', { chat_id: chatId, text: `Title: “${sess.title}”\n\nNow send the body. Formatting (bold, italic, \`code\`, links, quotes) is kept.` });
      break;

    case 'body':
      if (!msg.text) {
        return tg(env, 'sendMessage', { chat_id: chatId, text: 'That’s not text. Please send the body, or /cancel. (You can attach a photo in the next step.)' });
      }
      sess.body = msg.text;
      sess.step = 'photo';
      await setSession(env, chatId, sess);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Body saved.\n\nOptionally attach a photo to include it — or send /skip.',
        reply_markup: { inline_keyboard: [[{ text: 'Skip photo →', callback_data: 'ph:skip' }]] },
      });
      break;

    case 'photo':
      if (msg.photo) {
        sess.photo_file_id = msg.photo.reduce((a, b) => (a.file_size > b.file_size ? a : b)).file_id;
        await setSession(env, chatId, sess);
        await sendPreview(env, chatId, sess);
      } else {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'That’s not a photo. Send a photo, or /skip.' });
      }
      break;

    case 'confirm':
      await tg(env, 'sendMessage', { chat_id: chatId, text: 'There’s a post waiting above 👆 — use the buttons, or /cancel.' });
      break;
  }
}

/* Direct send (no active flow): build a session from the message and preview it. */
async function previewFromContent(msg, env) {
  const chatId = msg.chat.id;
  const isPhoto = !!msg.photo;
  const raw = isPhoto ? (msg.caption || '') : msg.text;
  const entities = isPhoto ? (msg.caption_entities || []) : (msg.entities || []);
  const rawMd = entitiesToMarkdown(raw, entities);
  const sess = {
    flow: 'quick',
    step: 'confirm',
    title: rawMd.split('\n')[0].replace(/^#draft\s*/i, '').replace(/[*_`~\[\]()]/g, '').trim() || 'Untitled',
    body: rawMd.includes('\n') ? rawMd.split('\n').slice(1).join('\n') : '',
    photo_file_id: isPhoto ? msg.photo.reduce((a, b) => (a.file_size > b.file_size ? a : b)).file_id : null,
  };
  await setSession(env, chatId, sess);
  await sendPreview(env, chatId, sess);
}

/* ————— preview + inline buttons ————— */

function confirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ Publish', callback_data: 'act:publish' },
        { text: '💤 Draft', callback_data: 'act:draft' },
      ],
      [
        { text: '✏️ Edit', callback_data: 'act:edit' },
        { text: '❌ Cancel', callback_data: 'act:cancel' },
      ],
    ],
  };
}

async function sendPreview(env, chatId, sess) {
  sess.step = 'confirm';
  await setSession(env, chatId, sess);

  const md = buildMarkdown(sess, false);
  const parts = ['📝 Preview', '', `<b>${escHtml(sess.title)}</b>`, ''];
  parts.push(sess.body ? mdToTelegramHtml(sess.body) : '(empty body)');
  if (sess.photo_file_id) parts.push('', '🖼 A photo is attached.');
  parts.push('', 'Ready to publish?');

  if (sess.photo_file_id) {
    await tg(env, 'sendPhoto', { chat_id: chatId, photo: sess.photo_file_id });
  }
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: parts.join('\n'),
    parse_mode: 'HTML',
    reply_markup: confirmKeyboard(),
  });
}

async function handleCallback(cb, env) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  const ack = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text });

  if (String(chatId) !== String(env.CHAT_ID)) return ack('Not authorized.');
  const [action, arg] = data.split(':');

  if (action === 'act') return handleActionCallback(cb, arg, env, ack);
  if (action === 'ph') {
    const sess = await getSession(env, chatId);
    if (sess && sess.step === 'photo') {
      await sendPreview(env, chatId, sess);
      return ack('No photo, got it.');
    }
    return ack('Nothing in progress.');
  }
  if (action === 'del') return confirmDelete(cb.message, arg, env, ack);
  if (action === 'delno') {
    await tg(env, 'deleteMessage', { chat_id: chatId, message_id: cb.message.message_id });
    return ack('Kept.');
  }
  if (action === 'delok') {
    const manifest = await getManifest(env);
    const idx = manifest.posts.findIndex((p) => p.slug === arg);
    if (idx === -1) {
      await tg(env, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: 'That post is already gone.' });
      return ack('Already deleted.');
    }
    const title = manifest.posts[idx].title;
    await deleteFile(env, `${env.POSTS_DIR}/${arg}.md`);
    manifest.posts.splice(idx, 1);
    await putManifest(env, manifest);
    await tg(env, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: `🗑 Deleted “${title}”.` });
    return ack('Deleted.');
  }
  return ack('Unknown action.');
}

async function handleActionCallback(cb, action, env, ack) {
  const chatId = cb.message.chat.id;
  const sess = await getSession(env, chatId);
  if (!sess || sess.step !== 'confirm') return ack('Nothing to publish — send me some content first.');

  if (action === 'cancel') {
    await clearSession(env, chatId);
    await editOrSend(cb, env, 'Cancelled — nothing was published.');
    return ack('Cancelled.');
  }

  if (action === 'edit') {
    sess.flow = 'edit';
    sess.step = 'title';
    await setSession(env, chatId, sess);
    await tg(env, 'sendMessage', { chat_id: chatId, text: `Editing. Current title: “${sess.title}”\n\nSend the new title.` });
    return ack('Let’s edit.');
  }

  if (action === 'publish' || action === 'draft') {
    const draft = action === 'draft';
    await ack(draft ? 'Saving draft…' : 'Publishing…');
    const slug = await commitPost(env, sess, draft);
    await clearSession(env, chatId);
    const url = `${env.SITE_URL.replace(/\/$/, '')}/post.html?slug=${encodeURIComponent(slug)}`;
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: (draft ? `💤 Draft saved: “${sess.title}”\nSend it again (same title) to publish later.\n\n` : `✅ Published: “${sess.title}”\n\n`) + url,
    });
  }
}

async function editOrSend(cb, env, text) {
  const edited = await tg(env, 'editMessageText', {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    text,
  });
  if (!edited.ok) {
    await tg(env, 'sendMessage', { chat_id: cb.message.chat.id, text });
  }
}

/* ————— publishing ————— */

async function commitPost(env, sess, draft) {
  const slug = slugify(sess.title);
  const now = new Date().toISOString();

  let imageMd = '';
  if (sess.photo_file_id) {
    const imageUrl = await commitImage(env, sess.photo_file_id, Math.floor(Date.now() / 1000));
    imageMd = `![image](${imageUrl})\n\n`;
  }
  const md = imageMd + (sess.body || '');

  // Read-modify-write the manifest; retry on commit races.
  for (let attempt = 0; attempt < 4; attempt++) {
    const manifest = await getManifest(env);
    const existingDate = manifest.posts.find((p) => p.slug === slug)?.date;
    const entry = {
      slug,
      title: sess.title,
      date: existingDate ?? now,
      teaser: (sess.body || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[#>*_`~\[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160),
      draft,
    };
    manifest.posts = manifest.posts.filter((p) => p.slug !== slug);
    manifest.posts.push(entry);

    try {
      await putFile(env, `${env.POSTS_DIR}/${slug}.md`, md, draft ? 'save draft' : (existingDate ? 'edit post' : 'new post'));
      await putManifest(env, manifest);
      return slug;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(800);
    }
  }
}

async function confirmDelete(msg, slug, env, ack) {
  const manifest = await getManifest(env);
  const post = manifest.posts.find((p) => p.slug === slug);
  if (!post) {
    if (ack) await ack('No such post.');
    else await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `No post found with slug "${slug}".` });
    return;
  }
  await tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: `Delete “${post.title}” (${post.date.slice(0, 10)})? This can’t be undone.`,
    reply_markup: {
      inline_keyboard: [[
        { text: '🗑 Yes, delete', callback_data: `delok:${slug}` },
        { text: 'Keep it', callback_data: 'delno' },
      ]],
    },
  });
  if (ack) await ack('');
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

function slugify(s) {
  const base = s.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return base || `post-${Date.now()}`;
}

/* Apply Telegram message entities to raw text, producing Markdown. */
function entitiesToMarkdown(text, entities) {
  const sorted = [...entities].sort((a, b) => b.offset - a.offset);
  let out = text;
  for (const e of sorted) {
    const start = e.offset, end = e.offset + e.length;
    const inner = out.slice(start, end);
    let wrapped;
    switch (e.type) {
      case 'bold': wrapped = `**${inner}**`; break;
      case 'italic': wrapped = `*${inner}*`; break;
      case 'underline': wrapped = `<u>${inner}</u>`; break;
      case 'strikethrough': wrapped = `~~${inner}~~`; break;
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

/* Rough markdown → Telegram HTML for previews (subset: bold, italic, strike, code, pre, links, quotes). */
function mdToTelegramHtml(md) {
  const blocks = [];
  let text = md.replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre>${escHtml(code.replace(/\n$/, ''))}</pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  text = escHtml(text);
  text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<i>$2</i>');
  text = text.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<i>$2</i>');
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  text = text.split('\n').map((l) => (l.startsWith('&gt; ') ? `<blockquote>${l.slice(5)}</blockquote>` : l)).join('\n');
  text = text.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[+i]);
  return text;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

/* ————— session state (KV) ————— */

function sessKey(chatId) {
  return `sess:${chatId}`;
}

async function getSession(env, chatId) {
  return env.SESSIONS.get(sessKey(chatId), { type: 'json' });
}

async function setSession(env, chatId, sess) {
  await env.SESSIONS.put(sessKey(chatId), JSON.stringify(sess), { expirationTtl: SESSION_TTL });
}

async function clearSession(env, chatId) {
  await env.SESSIONS.delete(sessKey(chatId));
}

/* ————— misc ————— */

async function tg(env, method, payload) {
  const res = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    console.error(`tg ${method} failed: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
