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

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request: Invalid JSON', { status: 400 });
    }

    try {
      await handleUpdate(update, env);
    } catch (err) {
      console.error('handleUpdate failed:', err);
      const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id ?? update?.callback_query?.from?.id;
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

  const currentSess = await getSession(env, chatId);
  if (currentSess) {
    // If user has a pending preview and sends new content, overwrite cleanly with the new post
    if (currentSess.step === 'confirm') {
      return previewFromContent(msg, env);
    }
    return handleFlowMessage(msg, env);
  }
  return previewFromContent(msg, env);
}

/* ————— commands ————— */

async function handleCommand(msg, env) {
  const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
  // Strip bot username if invoked via Telegram menu (e.g. /new@my_bot -> /new)
  const cmd = rawCmd.toLowerCase().split('@')[0];
  const chatId = msg.chat.id;

  switch (cmd) {
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
  if (!sess) return;

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
      // Preserve formatting in guided flow and edit flow
      sess.body = entitiesToMarkdown(msg.text, msg.entities || []);
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
      return previewFromContent(msg, env);

    default:
      await clearSession(env, chatId);
      return previewFromContent(msg, env);
  }
}

/* Direct send (no active flow): build a session from the message and preview it. */
async function previewFromContent(msg, env) {
  const chatId = msg.chat.id;
  const isPhoto = !!msg.photo;
  const raw = isPhoto ? (msg.caption || '') : msg.text;
  const entities = isPhoto ? (msg.caption_entities || []) : (msg.entities || []);
  const rawMd = entitiesToMarkdown(raw, entities);
  const lines = rawMd.split('\n');
  const title = lines[0].replace(/^#draft\s*/i, '').replace(/[*_`~\[\]()]/g, '').trim() || 'Untitled';
  const body = lines.slice(1).join('\n').trim();

  const sess = {
    flow: 'quick',
    step: 'confirm',
    title,
    body,
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
  const chatId = cb.message?.chat?.id ?? cb.from?.id;
  const data = cb.data || '';
  const ack = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => ({}));

  if (String(chatId) !== String(env.CHAT_ID)) return ack('Not authorized.');
  const [action, arg] = data.split(':');

  if (action === 'act') return handleActionCallback(cb, arg, env, ack);

  if (action === 'ph') {
    await ack('No photo, got it.');
    const sess = await getSession(env, chatId);
    if (sess && sess.step === 'photo') {
      await sendPreview(env, chatId, sess);
      return;
    }
    return;
  }

  if (action === 'del') return confirmDelete(cb.message, arg, env, ack);

  if (action === 'delno') {
    await ack('Kept.');
    await tg(env, 'deleteMessage', { chat_id: chatId, message_id: cb.message.message_id });
    return;
  }

  if (action === 'delok') {
    await ack('Deleting…');
    const { manifest, sha } = await getManifestWithSha(env);
    const idx = manifest.posts.findIndex((p) => p.slug === arg);
    if (idx === -1) {
      await tg(env, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: 'That post is already gone.' });
      return;
    }

    const postToDelete = manifest.posts[idx];
    const title = postToDelete.title;

    // Delete post Markdown file
    await deleteFile(env, `${env.POSTS_DIR}/${arg}.md`);

    // Clean up associated image if recorded
    if (postToDelete.image) {
      const imgPath = postToDelete.image.startsWith('site/') ? postToDelete.image : `site/${postToDelete.image}`;
      await deleteFile(env, imgPath);
    }

    manifest.posts.splice(idx, 1);
    await putManifest(env, manifest, sha);
    await tg(env, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: `🗑 Deleted “${title}”.` });
    return;
  }

  return ack('Unknown action.');
}

async function handleActionCallback(cb, action, env, ack) {
  const chatId = cb.message?.chat?.id ?? cb.from?.id;
  const sess = await getSession(env, chatId);
  if (!sess || sess.step !== 'confirm') return ack('Nothing to publish — send me some content first.');

  if (action === 'cancel') {
    await ack('Cancelled.');
    await clearSession(env, chatId);
    await editOrSend(cb, env, 'Cancelled — nothing was published.');
    return;
  }

  if (action === 'edit') {
    await ack('Let’s edit.');
    sess.flow = 'edit';
    sess.step = 'title';
    await setSession(env, chatId, sess);
    await tg(env, 'sendMessage', { chat_id: chatId, text: `Editing. Current title: “${sess.title}”\n\nSend the new title.` });
    return;
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
  const isEdit = sess.flow === 'edit';
  let slug = slugify(sess.title);
  const now = new Date().toISOString();

  let imageRelativePath = null;
  let imageMd = '';
  if (sess.photo_file_id) {
    imageRelativePath = await commitImage(env, sess.photo_file_id, Math.floor(Date.now() / 1000));
    imageMd = `![image](${imageRelativePath})\n\n`;
  }
  const md = imageMd + (sess.body || '');

  // Check manifest for slug collisions if this is not an explicit edit
  const initialData = await getManifestWithSha(env);
  let manifest = initialData.manifest;
  let manifestSha = initialData.sha;

  const existingPost = manifest.posts.find((p) => p.slug === slug);
  if (existingPost && !isEdit) {
    let counter = 2;
    let candidate = `${slug}-${counter}`;
    while (manifest.posts.some((p) => p.slug === candidate)) {
      counter++;
      candidate = `${slug}-${counter}`;
    }
    slug = candidate;
  }

  const existingDate = manifest.posts.find((p) => p.slug === slug)?.date;
  const commitMsg = draft ? 'save draft' : (existingDate ? 'edit post' : 'new post');

  // 1. Commit post Markdown once
  await putFile(env, `${env.POSTS_DIR}/${slug}.md`, md, commitMsg);

  // 2. Commit updated manifest with conflict retry
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const refreshed = await getManifestWithSha(env);
      manifest = refreshed.manifest;
      manifestSha = refreshed.sha;
    }

    const entry = {
      slug,
      title: sess.title,
      date: existingDate ?? now,
      teaser: (sess.body || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[#>*_`~\[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160),
      draft,
    };
    if (imageRelativePath) {
      entry.image = imageRelativePath;
    }

    manifest.posts = manifest.posts.filter((p) => p.slug !== slug);
    manifest.posts.push(entry);

    try {
      await putManifest(env, manifest, manifestSha);
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

  // Commit image to repo path (e.g. site/assets/img/<name>)
  await putFileBinary(env, `${env.IMAGES_DIR}/${name}`, buf, 'add image');

  // Return relative path for markdown embedding: assets/img/<name>
  // Because post.html is served from site root, this resolves properly on GitHub Pages
  return `assets/img/${name}`;
}

function slugify(s) {
  const base = s.toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // Keep Unicode letters and numbers
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 45)                      // Keep under 45 chars so delok:<slug> <= 64 bytes
    .replace(/^-+|-+$/g, '');
  return base || `post-${Date.now()}`;
}

/* Apply Telegram message entities to raw text, producing Markdown without offset corruption. */
function entitiesToMarkdown(text, entities) {
  if (!text || !entities || !entities.length) return text || '';

  const tags = [];
  for (const e of entities) {
    let open = '', close = '';
    switch (e.type) {
      case 'bold': open = '**'; close = '**'; break;
      case 'italic': open = '*'; close = '*'; break;
      case 'underline': open = '<u>'; close = '</u>'; break;
      case 'strikethrough': open = '~~'; close = '~~'; break;
      case 'code': open = '`'; close = '`'; break;
      case 'pre': open = '```\n'; close = '\n```'; break;
      case 'blockquote': {
        const inner = text.slice(e.offset, e.offset + e.length);
        const quoted = inner.split('\n').map((l) => `> ${l}`).join('\n');
        tags.push({ pos: e.offset, type: 'replace', content: quoted, len: e.length });
        continue;
      }
      case 'url': open = '['; close = `](${text.slice(e.offset, e.offset + e.length)})`; break;
      case 'text_link': open = '['; close = `](${e.url})`; break;
      default: continue;
    }
    tags.push({ pos: e.offset, type: 'open', tag: open, len: e.length });
    tags.push({ pos: e.offset + e.length, type: 'close', tag: close, len: e.length });
  }

  // Sort: higher pos first.
  // If same pos: close tags before open tags.
  // If both open: larger len first (outermost starts first).
  // If both close: smaller len first (innermost closes first).
  tags.sort((a, b) => {
    if (b.pos !== a.pos) return b.pos - a.pos;
    if (a.type === 'replace' || b.type === 'replace') return 0;
    if (a.type !== b.type) return a.type === 'close' ? -1 : 1;
    if (a.type === 'open') return b.len - a.len;
    return a.len - b.len;
  });

  let out = text;
  for (const t of tags) {
    if (t.type === 'replace') {
      out = out.slice(0, t.pos) + t.content + out.slice(t.pos + t.len);
    } else {
      out = out.slice(0, t.pos) + t.tag + out.slice(t.pos);
    }
  }
  return out;
}

/* Rough markdown → Telegram HTML for previews. */
function mdToTelegramHtml(md) {
  if (!md) return '';

  const blocks = [];
  // 1. Code blocks (extract before escaping)
  let text = md.replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre>${escHtml(code.replace(/\n$/, ''))}</pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  // 2. Blockquotes (group contiguous quote lines into a single blockquote)
  const lines = text.split('\n');
  const quoteGrouped = [];
  let inQuote = false;
  let quoteLines = [];

  for (const line of lines) {
    if (line.startsWith('> ') || line === '>') {
      inQuote = true;
      quoteLines.push(line.replace(/^> ?/, ''));
    } else {
      if (inQuote) {
        quoteGrouped.push(`<blockquote>${escHtml(quoteLines.join('\n'))}</blockquote>`);
        quoteLines = [];
        inQuote = false;
      }
      quoteGrouped.push(escHtml(line));
    }
  }
  if (inQuote) {
    quoteGrouped.push(`<blockquote>${escHtml(quoteLines.join('\n'))}</blockquote>`);
  }
  text = quoteGrouped.join('\n');

  // 3. Inline formatting
  text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<i>$2</i>');
  text = text.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<i>$2</i>');
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  text = text.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>');

  // 4. Links: convert [text](url) to <a href="...">text</a> safely
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, linkText, href) => {
    const cleanHref = href.replace(/&amp;/g, '&');
    return `<a href="${cleanHref}">${linkText}</a>`;
  });

  // 5. Restore code blocks
  text = text.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[+i]);
  return text;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ————— modern utf-8 base64 encoding/decoding ————— */

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/* ————— github contents api ————— */

function gh(env, path) {
  return `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
}

function ghHeaders(env) {
  return {
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

async function putFile(env, path, text, message, knownSha) {
  return putFileBase(env, path, utf8ToBase64(text), message, knownSha);
}

async function putFileBinary(env, path, bytes, message) {
  let bin = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return putFileBase(env, path, btoa(bin), message);
}

async function putFileBase(env, path, base64, message, knownSha) {
  const sha = knownSha !== undefined ? knownSha : await getSha(env, path);
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

async function getManifestWithSha(env) {
  const res = await fetch(`${gh(env, `${env.POSTS_DIR}/index.json`)}?ref=${env.GITHUB_BRANCH}`, {
    headers: ghHeaders(env),
  });
  if (res.status === 404) return { manifest: { posts: [] }, sha: null };
  if (!res.ok) throw new Error(`getManifest → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const text = base64ToUtf8(json.content);
  return { manifest: JSON.parse(text), sha: json.sha };
}

async function getManifest(env) {
  const data = await getManifestWithSha(env);
  return data.manifest;
}

async function putManifest(env, manifest, knownSha) {
  manifest.posts.sort((a, b) => b.date.localeCompare(a.date));
  await putFile(env, `${env.POSTS_DIR}/index.json`, JSON.stringify(manifest, null, 2) + '\n', 'update index', knownSha);
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
