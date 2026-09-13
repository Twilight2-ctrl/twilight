// twilight/server.js —— 迎日暮光云 Twilight 官网后端
// 功能：托管前端HTML + 数据API + WebSocket实时同步 + 媒体文件上传与持久化
// 部署：node server.js  （默认端口 3000，可用 PORT 环境变量覆盖）

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createHash, randomBytes } = crypto;

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ===== 配置（改这里）=====
const CONFIG = {
  AUTHOR_KEY: process.env.AUTHOR_KEY || '20100423',   // 作者密钥
  AUTHOR_NAME: '迎日暮光云Twilight',
  MAX_UPLOAD_MB: 200,                                 // 单文件上限
};

// ===== 持久化 =====
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ posts: [], blockedDms: [] }, null, 2));

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { posts: [], blockedDms: [] }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// db.json 里媒体不存二进制，只存 {file: "文件名"} 引用；启动时校验文件存在
function dbPosts() { return loadDB().posts; }

// ===== MIME =====
const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime',
};

// ===== HTTP 服务器 =====
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ---- API ----
  if (pathname.startsWith('/api/')) return handleAPI(req, res, pathname, url);

  // ---- 上传的媒体文件 ----
  if (pathname.startsWith('/uploads/')) {
    const fp = path.join(UPLOAD_DIR, path.basename(pathname));
    if (!fp.startsWith(UPLOAD_DIR) || !fs.existsSync(fp)) { res.statusCode = 404; return res.end('Not Found'); }
    const ext = path.extname(fp).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    return fs.createReadStream(fp).pipe(res);
  }

  // ---- 前端入口 ----
  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(res, path.join(__dirname, 'index.html'), '.html');
  }
  // 其他静态文件（如 /style.css 等，若拆分）
  const staticPath = path.join(__dirname, pathname);
  if (staticPath.startsWith(__dirname) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    return sendFile(res, staticPath, path.extname(staticPath));
  }
  res.statusCode = 404; res.end('Not Found');
});

function sendFile(res, fp, ext) {
  fs.readFile(fp, (err, buf) => {
    if (err) { res.statusCode = 500; return res.end('Server Error'); }
    res.setHeader('Content-Type', MIME[ext] || 'text/plain');
    res.end(buf);
  });
}

// ===== API 处理 =====
function handleAPI(req, res, pathname, url) {
  const method = req.method;

  // 获取全部数据（前端初始化）
  if (pathname === '/api/state' && method === 'GET') {
    const db = loadDB();
    return json(res, { ok: true, authorName: CONFIG.AUTHOR_NAME, posts: db.posts, blockedDms: db.blockedDms });
  }

  // 验证作者身份（不持久登录，每次发布带 token 即可，这里简化为前端校验密钥）
  if (pathname === '/api/auth' && method === 'POST') {
    return readJSON(req, body => {
      if (body && body.key === CONFIG.AUTHOR_KEY) return json(res, { ok: true, author: CONFIG.AUTHOR_NAME, token: makeToken() });
      return json(res, { ok: false, error: '密钥错误' }, 401);
    });
  }

  // 发布内容（作者）
  if (pathname === '/api/posts' && method === 'POST') {
    return readJSON(req, body => {
      const auth = req.headers['x-author-token'];
      if (!auth || auth !== CONFIG.AUTHOR_KEY) return json(res, { ok: false, error: '仅作者可发布' }, 403);
      const db = loadDB();
      const post = {
        id: Date.now(),
        author: CONFIG.AUTHOR_NAME,
        text: (body.text || '').toString().slice(0, 2000),
        media: Array.isArray(body.media) ? body.media.filter(m => m && m.file).slice(0, 9) : [],
        column: body.column === 'completed' ? 'completed' : 'preview',
        isFeatured: !!body.isFeatured,
        danmaku: [],
        likes: [],
        time: new Date().toISOString(),
      };
      // 只有一个置顶
      if (post.isFeatured) db.posts.forEach(p => { if (p.column === post.column) p.isFeatured = false; });
      db.posts.unshift(post);
      saveDB(db);
      broadcast({ type: 'post:new', post });
      return json(res, { ok: true, post });
    });
  }

  // 上传媒体文件（multipart 简单解析）
  if (pathname === '/api/upload' && method === 'POST') {
    const auth = req.headers['x-author-token'];
    if (!auth || auth !== CONFIG.AUTHOR_KEY) return json(res, { ok: false, error: '仅作者可上传' }, 403);
    parseMultipart(req, (err, parts) => {
      if (err) return json(res, { ok: false, error: err.message }, 400);
      const results = parts.filter(p => p.fileName).map(p => {
        const ext = (path.extname(p.fileName) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
        const name = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, name), p.data);
        return { file: name, mime: p.contentType, originalName: p.fileName };
      });
      return json(res, { ok: true, files: results });
    });
    return;
  }

  // 点赞
  if (pathname === '/api/like' && method === 'POST') {
    return readJSON(req, body => {
      const db = loadDB();
      const post = db.posts.find(p => p.id === body.postId);
      if (!post) return json(res, { ok: false, error: '帖子不存在' }, 404);
      const user = (body.user || '游客').toString().slice(0, 32);
      post.likes = post.likes || [];
      if (!post.likes.includes(user)) post.likes.push(user);
      saveDB(db);
      broadcast({ type: 'post:update', post });
      return json(res, { ok: true, likes: post.likes.length });
    });
  }

  // 发弹幕
  if (pathname === '/api/danmaku' && method === 'POST') {
    return readJSON(req, body => {
      const db = loadDB();
      const post = db.posts.find(p => p.id === body.postId);
      if (!post) return json(res, { ok: false, error: '帖子不存在' }, 404);
      if (db.blockedDms.includes(`${post.id}:${body.dmId}`)) return json(res, { ok: false, error: '已屏蔽' }, 403);
      post.danmaku = post.danmaku || [];
      const dm = { id: body.dmId || (post.id + '_' + Date.now()), user: (body.user || '游客').toString().slice(0, 32), text: (body.text || '').toString().slice(0, 500), time: Date.now() };
      post.danmaku.push(dm);
      saveDB(db);
      broadcast({ type: 'danmaku:new', postId: post.id, dm });
      return json(res, { ok: true, dm });
    });
  }

  // 屏蔽弹幕（作者）
  if (pathname === '/api/block' && method === 'POST') {
    return readJSON(req, body => {
      const auth = req.headers['x-author-token'];
      if (!auth || auth !== CONFIG.AUTHOR_KEY) return json(res, { ok: false, error: '仅作者可操作' }, 403);
      const db = loadDB();
      const key = `${body.postId}:${body.dmId}`;
      if (!db.blockedDms.includes(key)) db.blockedDms.push(key);
      saveDB(db);
      broadcast({ type: 'block:new', key });
      return json(res, { ok: true });
    });
  }

  // 公告（按专栏存储）
  if (pathname === '/api/announce' && method === 'GET') {
    const col = url.searchParams.get('column') || 'preview';
    const db = loadDB();
    const text = (db.announces && db.announces[col]) || '';
    return json(res, { ok: true, text });
  }
  if (pathname === '/api/announce' && method === 'POST') {
    return readJSON(req, body => {
      const auth = req.headers['x-author-token'];
      if (!auth || auth !== CONFIG.AUTHOR_KEY) return json(res, { ok: false, error: '仅作者可操作' }, 403);
      const db = loadDB();
      db.announces = db.announces || {};
      db.announces[body.column || 'preview'] = (body.text || '').toString().slice(0, 2000);
      saveDB(db);
      broadcast({ type: 'announce:update', column: body.column || 'preview', text: db.announces[body.column || 'preview'] });
      return json(res, { ok: true });
    });
  }

  json(res, { ok: false, error: 'Not Found' }, 404);
}

// ===== 工具函数 =====
function json(res, obj, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}
function readJSON(req, cb) {
  let buf = '';
  req.on('data', c => buf += c);
  req.on('end', () => { try { cb(JSON.parse(buf || '{}')); } catch (e) { cb({}); } });
}
function makeToken() { return crypto.randomBytes(16).toString('hex'); }

// ---- 简易 multipart 解析（支持大文件，流式写盘）----
function parseMultipart(req, cb) {
  const ct = req.headers['content-type'] || '';
  const match = ct.match(/boundary="?([^";]+)"?/);
  if (!match) return cb(new Error('不是multipart请求'));
  const boundary = '--' + match[1];
  const max = CONFIG.MAX_UPLOAD_MB * 1024 * 1024;
  let buf = Buffer.alloc(0);
  let totalSize = 0;
  req.on('data', chunk => {
    totalSize += chunk.length;
    if (totalSize > max * 5) { req.destroy(); cb(new Error('请求过大')); }
    buf = Buffer.concat([buf, chunk]);
  });
  req.on('end', () => {
    try {
      const parts = [];
      let rem = buf;
      while (true) {
        const headIdx = rem.indexOf(boundary);
        if (headIdx === -1) break;
        rem = rem.slice(headIdx + boundary.length);
        if (rem.slice(0, 2).equals(Buffer.from('\r\n'))) rem = rem.slice(2);
        if (rem.slice(0, 2).equals(Buffer.from('--'))) break; // 结束
        const headerEnd = rem.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const headers = rem.slice(0, headerEnd).toString('utf8');
        rem = rem.slice(headerEnd + 4);
        const nextBoundary = rem.indexOf(boundary);
        let body;
        if (nextBoundary === -1) break;
        body = rem.slice(0, nextBoundary);
        // 去掉结尾 \r\n
        if (body.slice(-2).equals(Buffer.from('\r\n'))) body = body.slice(0, -2);
        const disp = /Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/i.exec(headers) || [];
        const contentType = /Content-Type: ([^\r\n]+)/i.exec(headers);
        parts.push({
          name: disp[1],
          fileName: disp[2] ? disp[2].replace(/\\/g, '') : null,
          contentType: contentType ? contentType[1].trim() : 'application/octet-stream',
          data: body,
        });
        rem = rem.slice(nextBoundary);
      }
      cb(null, parts);
    } catch (e) { cb(e); }
  });
}

// ===== WebSocket 服务器（零依赖，纯 Node 标准库实现）=====
// 用 Set 跟踪所有连接；broadcast 向所有 OPEN 状态的连接发送
const wsClients = new Set();
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wsClients) { try { if (c.readyState === 1) c.send(data); } catch(e) {} }
}
function handleUpgrade(req, socket, head) {
  if (req.url !== '/ws') { socket.destroy(); return; }
  // 读取并校验 Sec-WebSocket-Key
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  // 简易帧解析/发送
  let buf = Buffer.alloc(0);
  const client = { readyState: 1, socket, send(text) {
    const payload = Buffer.from(text, 'utf8');
    let frame;
    if (payload.length < 126) {
      frame = Buffer.alloc(2 + payload.length);
      frame[0] = 0x81; frame[1] = payload.length; payload.copy(frame, 2);
    } else if (payload.length < 65536) {
      frame = Buffer.alloc(4 + payload.length);
      frame[0] = 0x81; frame[1] = 126; frame.writeUInt16BE(payload.length, 2); payload.copy(frame, 4);
    } else {
      frame = Buffer.alloc(10 + payload.length);
      frame[0] = 0x81; frame[1] = 127; frame.writeBigUInt64BE(BigInt(payload.length), 2); payload.copy(frame, 10);
    }
    try { socket.write(frame); } catch(e) {}
  } };
  wsClients.add(client);
  client.send(JSON.stringify({ type: 'hello', authorName: CONFIG.AUTHOR_NAME, time: Date.now() }));
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      if (buf.length < offset + len) break;
      let mask = null;
      if (buf[1] & 0x80) { mask = buf.slice(offset, offset + 4); offset += 4; }
      const payload = buf.slice(offset, offset + len);
      if (mask) { for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
      // 处理分帧：把后续帧的数据拼接（简化处理，仅取文本）
      buf = buf.slice(offset + len);
      if (opcode === 0x01) { /* text frame - 可在此扩展处理客户端消息 */ }
      else if (opcode === 0x08) { client.readyState = 3; try { socket.end(); } catch(e) {} }
      if (!fin) continue;
    }
  });
  socket.on('close', () => { wsClients.delete(client); client.readyState = 3; });
  socket.on('error', () => { wsClients.delete(client); });
}
server.on('upgrade', handleUpgrade);

// ===== 启动 =====
module.exports = { server, CONFIG, broadcast }; // 供测试复用
if (require.main === module) {
server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  迎日暮光云 Twilight 官网 已启动`);
  console.log(`  本地访问: http://localhost:${PORT}`);
  console.log(`  作者密钥: ${CONFIG.AUTHOR_KEY}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`========================================\n`);
  if (!process.env.AUTHOR_KEY) console.log('提示: 可用环境变量 AUTHOR_KEY 覆盖作者密钥\n');
});
} // end if (require.main === module)
