const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(POSTS_FILE)) fs.writeFileSync(POSTS_FILE, '[]');
if (!fs.existsSync(PROFILES_FILE)) fs.writeFileSync(PROFILES_FILE, '{}');

function readPosts() { try { return JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')); } catch (e) { return []; } }
function writePosts(p) { fs.writeFileSync(POSTS_FILE, JSON.stringify(p, null, 2)); }
function readProfiles() { try { return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch (e) { return {}; } }
function writeProfiles(p) { fs.writeFileSync(PROFILES_FILE, JSON.stringify(p, null, 2)); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// 清理过期预告
function sweepExpired(posts) {
  const now = Date.now();
  const before = posts.length;
  const alive = posts.filter(p => !(p.expireAt && now > p.expireAt && !String(p.id).startsWith('announce:')));
  if (alive.length !== before) writePosts(alive);
  return alive;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // API
  if (pathname.startsWith('/api/')) {
    handleAPI(req, res, pathname.slice(4), parsed.query);
    return;
  }

  // 静态文件：根目录 index.html 优先，其次 static/index.html
  let candidates;
  if (pathname === '/' || pathname === '/index.html') {
    candidates = [
      path.join(__dirname, 'index.html'),
      path.join(__dirname, 'static', 'index.html'),
      path.join(__dirname, 'public', 'index.html'),
    ];
  } else {
    candidates = [path.join(__dirname, pathname), path.join(__dirname, 'static', pathname)];
  }
  const safePath = candidates.find(c => c.startsWith(__dirname) && fs.existsSync(c) && fs.statSync(c).isFile());
  if (!safePath) {
    // 兜底：列出实际存在的目录，方便排查
    let listing = '';
    try { listing = fs.readdirSync(__dirname).join(', '); } catch (e) {}
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found. 根目录实际有: ' + listing);
    return;
  }
  fs.readFile(safePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(safePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

function send(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(resolve => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } }); }); }

async function handleAPI(req, res, p, q) {
  try {
  let posts = readPosts();
  // 每次请求前先清理过期
  posts = sweepExpired(posts);
  // 把持久化的媒体文件读成 dataUrl 内联，确保前端能直接显示图片/视频
  syncMediaIntoPosts(posts);

  // GET /api/posts
  if (p === '/posts' && req.method === 'GET') {
    const profiles = readProfiles();
    // 媒体只返回本会话内上传的；持久化的 dataUrl 直接内联在 media[].dataUrl
    const media = {};
    posts.forEach(post => {
      if (post.media && post.media.length > 0) {
        media[post.id] = post.media.map(m => ({ name: m.name, type: m.type, dataUrl: m.dataUrl || '' }));
      }
    });
    return send(res, 200, { posts, media });
  }

  // POST /api/posts
  if (p === '/posts' && req.method === 'POST') {
    const body = await readBody(req);
    const id = Date.now();
    const post = {
      id, ownerId: body.ownerId, author: body.author, authorAvatar: body.authorAvatar,
      text: body.text, media: body.media || [], danmaku: [], likes: [],
      isFeatured: !!body.isFeatured, column: body.column || 'preview', expireAt: body.expireAt || null,
    };
    // media 里的 dataUrl 写文件持久化
    if (post.media.length > 0) {
      post.media = post.media.map((m, i) => {
        if (m.dataUrl && m.dataUrl.startsWith('data:')) {
          const fileId = `${id}_${i}`;
          const ext = m.type === 'image' ? '.bin' : '.bin';
          const fpath = path.join(MEDIA_DIR, fileId + ext);
          const base64 = m.dataUrl.split(',')[1];
          fs.writeFileSync(fpath, Buffer.from(base64, 'base64'));
          return { name: m.name, type: m.type, fileId, dataUrl: null };
        }
        return m;
      });
    }
    posts.unshift(post);
    writePosts(posts);
    syncMediaIntoPosts(posts);
    return send(res, 200, { id });
  }

  // DELETE /api/posts/:id  —— 不再需要，但保留兼容
  const delMatch = p.match(/^\/posts\/(\d+)$/);
  if (delMatch && req.method === 'DELETE') {
    const id = Number(delMatch[1]);
    posts = posts.filter(x => x.id !== id);
    writePosts(posts);
    return send(res, 200, { ok: true });
  }

  // POST /api/like/:id
  const likeMatch = p.match(/^\/like\/(\d+)$/);
  if (likeMatch && req.method === 'POST') {
    const id = Number(likeMatch[1]);
    const { ownerId } = await readBody(req);
    const post = posts.find(x => x.id === id);
    if (post) { post.likes = post.likes || []; if (!post.likes.includes(ownerId)) post.likes.push(ownerId); writePosts(posts); }
    return send(res, 200, { count: post ? post.likes.length : 0 });
  }

  // POST /api/danmaku/:id
  const dmMatch = p.match(/^\/danmaku\/(\d+)$/);
  if (dmMatch && req.method === 'POST') {
    const id = Number(dmMatch[1]);
    const { ownerId, user, text } = await readBody(req);
    const post = posts.find(x => x.id === id);
    if (post) { post.danmaku = post.danmaku || []; post.danmaku.push({ ownerId, user, text }); writePosts(posts); }
    return send(res, 200, { ok: true });
  }

  // DELETE /api/danmaku/:id/:idx?ownerId=xxx&role=xxx
  const dmDelMatch = p.match(/^\/danmaku\/(\d+)\/(\d+)$/);
  if (dmDelMatch && req.method === 'DELETE') {
    const id = Number(dmDelMatch[1]); const idx = Number(dmDelMatch[2]);
    const { ownerId, role } = q; // DELETE 请求 body 不可靠，改用 query
    const post = posts.find(x => x.id === id);
    if (post && post.danmaku && post.danmaku[idx]) {
      const target = post.danmaku[idx];
      if (role === 'author' || target.ownerId === ownerId) { post.danmaku.splice(idx, 1); writePosts(posts); }
    }
    return send(res, 200, { ok: true });
  }

  // POST /api/announce
  if (p === '/announce' && req.method === 'POST') {
    const { column, text } = await readBody(req);
    const id = 'announce:' + column;
    const existing = posts.findIndex(x => x.id === id);
    if (text) {
      const ann = { id, column, text, author: '云上展厅', ownerId: 'a0', media: [], danmaku: [], likes: [], isFeatured: false, expireAt: null };
      if (existing >= 0) posts[existing] = ann; else posts.unshift(ann);
    } else if (existing >= 0) posts.splice(existing, 1);
    writePosts(posts);
    return send(res, 200, { ok: true });
  }

  // POST /api/profile
  if (p === '/profile' && req.method === 'POST') {
    const body = await readBody(req);
    const profiles = readProfiles();
    profiles[body.baseId] = { name: body.name, avatar: body.avatar, role: body.role };
    writeProfiles(profiles);
    return send(res, 200, { ok: true });
  }

  // POST /api/media/:fileId  (上传持久化媒体)
  const mediaMatch = p.match(/^\/media\/(.+)$/);
  if (mediaMatch && req.method === 'POST') {
    const body = await readBody(req);
    const { postId, index, dataUrl, type } = body;
    const post = posts.find(x => x.id === postId);
    if (post && dataUrl && dataUrl.startsWith('data:')) {
      const fileId = mediaMatch[1];
      const fpath = path.join(MEDIA_DIR, fileId + '.bin');
      fs.writeFileSync(fpath, Buffer.from(dataUrl.split(',')[1], 'base64'));
      if (post.media[index]) { post.media[index] = { name: post.media[index].name, type, fileId, dataUrl: null }; writePosts(posts); }
    }
    return send(res, 200, { ok: true });
  }

  // GET /api/media/:fileId  (读取持久化媒体)
  const mediaGet = p.match(/^\/media\/(.+)$/);
  if (mediaGet && req.method === 'GET') {
    const fpath = path.join(MEDIA_DIR, mediaGet[1] + '.bin');
    if (fs.existsSync(fpath)) {
      const b = fs.readFileSync(fpath);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(b);
      return;
    }
    return send(res, 404, { error: 'not found' });
  }

  send(res, 404, { error: 'not found' });
  } catch (e) {
    console.log('[ERROR] handleAPI exception:', e.message, e.stack);
    send(res, 500, { error: e.message });
  }
}

// 启动时把持久化媒体读成 dataUrl 内联进 posts，方便前端直接使用
function syncMediaIntoPosts(posts) {
  posts.forEach(post => {
    if (post.media && post.media.length > 0) {
      post.media = post.media.map(m => {
        if (m.fileId) {
          const fpath = path.join(MEDIA_DIR, m.fileId + '.bin');
          if (fs.existsSync(fpath)) {
            const b = fs.readFileSync(fpath);
            const mime = m.type === 'image' ? 'image/jpeg' : 'video/mp4';
            return { ...m, dataUrl: `data:${mime};base64,${b.toString('base64')}` };
          }
        }
        return m;
      });
    }
  });
}

// 启动时预热
syncMediaIntoPosts(readPosts());

// 定时清理过期（每 5 分钟）
setInterval(() => { try { sweepExpired(readPosts()); } catch (e) {} }, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Cloud Gallery server running on http://localhost:${PORT}`);
  if (process.argv.includes('--selftest')) runSelfTest();
});

// 自测模式：启动服务、跑一遍 API 流程、打印结果后退出
async function runSelfTest() {
  const base = 'http://localhost:' + PORT;
  async function post(path, body) {
    return new Promise((res, rej) => {
      const req = require('http').request(base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); });
      req.on('error', rej); req.write(JSON.stringify(body)); req.end();
    });
  }
  async function get(path) {
    return new Promise((res, rej) => {
      require('http').get(base + '/api' + path, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); }).on('error', rej);
    });
  }
  async function del(path, body) {
    return new Promise((res, rej) => {
      const req = require('http').request(base + '/api' + path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); });
      req.on('error', rej); req.write(JSON.stringify(body)); req.end();
    });
  }
  try {
    const id1 = JSON.parse(await post('/posts', { ownerId: 'a0', author: '云上展厅', authorAvatar: 'x', text: '第一条', media: [], isFeatured: false, column: 'preview', expireAt: null })).id;
    const id2 = JSON.parse(await post('/posts', { ownerId: 'a0', author: '云上展厅', authorAvatar: 'x', text: '作品', media: [], isFeatured: false, column: 'completed', expireAt: null })).id;
    console.log('TEST 发帖1 id=' + id1 + ':', await post('/posts', { ownerId: 'a0', author: '云上展厅', authorAvatar: 'x', text: '第一条', media: [], isFeatured: false, column: 'preview', expireAt: null }));
    console.log('TEST 点赞 id1:', await post('/like/' + id1, { ownerId: 'g1' }));
    console.log('TEST 重复点赞 id1:', await post('/like/' + id1, { ownerId: 'g1' }));
    console.log('TEST 弹幕 id1:', await post('/danmaku/' + id1, { ownerId: 'g1', user: '游客_xx', text: 'hello' }));
    console.log('TEST 公告:', await post('/announce', { column: 'preview', text: '欢迎' }));
    console.log('TEST 列表:', await get('/posts'));
    console.log('TEST 撤弹幕(作者) id1[0]:', await del('/danmaku/' + id1 + '/0', { ownerId: 'a0', role: 'author' }));
    console.log('TEST 过期预告:', await post('/posts', { ownerId: 'a0', author: 'x', authorAvatar: 'x', text: '过期', media: [], isFeatured: false, column: 'preview', expireAt: 1000 }));
    console.log('TEST 最终列表:', await get('/posts'));
  } catch (e) { console.log('SELFTEST ERROR:', e.message); }
  process.exit(0);
}
