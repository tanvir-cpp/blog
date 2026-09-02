/* Shared rendering logic for index and post pages. */

function setStatus(msg) {
  var el = document.getElementById('status');
  if (el) {
    el.textContent = msg;
    el.hidden = !msg;
  }
}

function fmtDate(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

function teaserOf(body) {
  var text = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 160) text = text.slice(0, 160).replace(/\s+\S*$/, '') + '…';
  return text;
}

function renderMarkdown(md) {
  return marked.parse(md, { breaks: true, gfm: true });
}

async function loadManifest() {
  var res = await fetch('posts/index.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('manifest ' + res.status);
  return res.json();
}

async function loadPost(slug) {
  var res = await fetch('posts/' + slug + '.md', { cache: 'no-cache' });
  if (!res.ok) throw new Error('post ' + res.status);
  return res.text();
}

/* Home page: list published posts, newest first. */
async function renderIndex() {
  var list = document.getElementById('post-list');
  try {
    var manifest = await loadManifest();
    var posts = (manifest.posts || [])
      .filter(function (p) { return !p.draft; })
      .sort(function (a, b) { return b.date.localeCompare(a.date); });

    setStatus('');
    if (!posts.length) {
      setStatus('Nothing here yet.');
      return;
    }

    list.innerHTML = '';
    posts.forEach(function (p) {
      var li = document.createElement('li');
      li.innerHTML =
        '<span class="meta"></span>' +
        '<a class="title" href="post.html?slug=' + encodeURIComponent(p.slug) + '"></a>' +
        '<p class="teaser"></p>';
      li.querySelector('.meta').textContent = fmtDate(p.date);
      li.querySelector('a.title').textContent = p.title;
      li.querySelector('.teaser').textContent = p.teaser || teaserOf(p.body || '');
      list.appendChild(li);
    });
    list.hidden = false;
  } catch (e) {
    setStatus('Could not load posts.');
  }
}

/* Post page: fetch and render a single post. */
async function renderPost() {
  var slug = new URLSearchParams(location.search).get('slug');
  if (!slug) { setStatus('No post specified.'); return; }

  try {
    var manifest = await loadManifest();
    var meta = (manifest.posts || []).find(function (p) { return p.slug === slug; });
    var md = await loadPost(slug);

    setStatus('');
    document.title = (meta ? meta.title : slug) + ' — Blog';
    document.getElementById('post-title').textContent = meta ? meta.title : slug;
    document.getElementById('post-date').textContent = meta ? fmtDate(meta.date) : '';

    var body = document.getElementById('post-body');
    body.innerHTML = renderMarkdown(md);
    body.hidden = false;
  } catch (e) {
    setStatus('This post could not be found.');
  }
}
