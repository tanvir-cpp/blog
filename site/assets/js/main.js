/* Shared rendering logic for index and post pages. */

/* ————— theme toggle ————— */

function initTheme() {
  var current = document.documentElement.getAttribute('data-theme') || 'light';
  updateThemeButton(current);

  var btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.onclick = function() {
      var next = (document.documentElement.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('blog_theme', next);
      updateThemeButton(next);
    };
  }
}

function updateThemeButton(theme) {
  var btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }
}

document.addEventListener('DOMContentLoaded', initTheme);

/* ————— utilities ————— */

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
  var res = await fetch('posts/' + encodeURIComponent(slug) + '.md', { cache: 'no-cache' });
  if (!res.ok) throw new Error('post ' + res.status);
  return res.text();
}

/* ————— home page ————— */

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
      var teaser = p.teaser || teaserOf(p.body || '');
      li.innerHTML =
        '<span class="meta"></span>' +
        '<a class="title" href="post.html?slug=' + encodeURIComponent(p.slug) + '"></a>' +
        (teaser ? '<p class="teaser"></p>' : '');
      li.querySelector('.meta').textContent = fmtDate(p.date);
      li.querySelector('a.title').textContent = p.title;
      if (teaser) {
        li.querySelector('.teaser').textContent = teaser;
      }
      list.appendChild(li);
    });
    list.hidden = false;
  } catch (e) {
    setStatus('Could not load posts.');
  }
}

/* ————— post page ————— */

async function renderPost(retryCount) {
  retryCount = retryCount || 0;
  var slug = new URLSearchParams(location.search).get('slug');
  var article = document.getElementById('post-article');
  if (!slug) {
    if (article) article.hidden = true;
    setStatus('No post specified.');
    return;
  }

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
    if (article) article.hidden = false;
  } catch (e) {
    if (article) article.hidden = true;
    if (retryCount < 12) {
      setStatus('Waiting for GitHub Pages to deploy… retrying in 5s (' + (retryCount + 1) + '/12)');
      setTimeout(function () {
        renderPost(retryCount + 1);
      }, 5000);
    } else {
      setStatus('This post could not be found. (If you just published, please wait a minute and refresh.)');
    }
  }
}
