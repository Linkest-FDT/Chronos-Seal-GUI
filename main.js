// ★ 第一步：绕过 SSL 证书校验
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow = null;

if (app.isPackaged) {
  const exeDir = path.dirname(app.getPath('exe'));
  app.setPath('userData', path.join(exeDir, 'Config'));
  app.setPath('sessionData', path.join(exeDir, 'Config'));
} else {
  const devDataDir = path.join(os.tmpdir(), 'ChronosSealDev');
  if (!fs.existsSync(devDataDir)) fs.mkdirSync(devDataDir, { recursive: true });
  app.setPath('userData', devDataDir);
  app.setPath('sessionData', devDataDir);
  console.log('>>> [开发模式] 运行时数据已重定向至: ' + devDataDir);
}

const GITHUB_CLIENT_ID = 'Iv23liFUMvAWTK75MEx4';
const CALLBACK_PORT = 8080;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const PUBLIC_KEY_B64 = 'JcRAjq2AWR9+QPMXRQsqZC09yAnlOkS6Pguj45IRMk0=';
const KERNEL_VERSION = 'V2.2';
const SHELL_NAMES = ['CLARE_LocalizationCore','CLARE_ImageCache','CLARE_AssetPreloader','CLARE_SaveIntegrity','CLARE_DLCManager'];
const DEFAULT_KERNEL_SOURCES = [
  { host: 'raw.githubusercontent.com', label: 'GitHub' },
  { host: 'mirror.crclare.top',        label: 'CF Mirror' }
];

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function getKernelCacheDir(engine) { return path.join(app.getPath('userData'), 'kernels', KERNEL_VERSION, engine.toUpperCase()); }
function getFilesDir() { return path.join(app.getPath('userData'), 'Files'); }
function getConfigDir() { return app.getPath('userData'); }
function getConfigPath() { return path.join(getConfigDir(), 'config.ini'); }

function readConfig() {
  const f = getConfigPath();
  if (!fs.existsSync(f)) return {};
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return {}; }
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

function writeConfig(obj) {
  const f = getConfigPath();
  ensureDir(path.dirname(f));
  const lines = ['; Chronos Seal GUI - Config', '; Auto-generated. Edit with care.', ''];
  for (const k of Object.keys(obj).sort()) { lines.push(k + ' = ' + String(obj[k])); }
  fs.writeFileSync(f, lines.join('\n'), 'utf8');
}

function updateConfig(patch) { const cur = readConfig(); Object.assign(cur, patch); writeConfig(cur); }

function getKernelSources() {
  const cfg = readConfig();
  if (cfg.devMode === 'true' && cfg.customKernelSources) {
    try { const parsed = JSON.parse(cfg.customKernelSources); if (Array.isArray(parsed) && parsed.length > 0) return parsed; } catch (e) {}
  }
  return DEFAULT_KERNEL_SOURCES;
}

async function saveGithubToken(token) {
  const configDir = getConfigDir();
  ensureDir(configDir);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(token);
      fs.writeFileSync(path.join(configDir, 'GithubToken.enc'), encrypted.toString('base64'), 'utf8');
      return;
    }
  } catch (e) { console.warn('[safeStorage] 加密失败:', e.message); }
  fs.writeFileSync(path.join(configDir, 'GithubToken'), token, { encoding: 'utf8', mode: 0o600 });
}

async function loadGithubToken() {
  const configDir = getConfigDir();
  const encPath = path.join(configDir, 'GithubToken.enc');
  if (fs.existsSync(encPath)) {
    try {
      const b64Data = fs.readFileSync(encPath, 'utf8');
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(b64Data, 'base64'));
    } catch (e) { console.warn('[safeStorage] 解密失败:', e.message); }
  }
  const plainPath = path.join(configDir, 'GithubToken');
  if (fs.existsSync(plainPath)) {
    try { return fs.readFileSync(plainPath, 'utf8').trim(); } catch (e) { return null; }
  }
  return null;
}

async function clearGithubToken() {
  const configDir = getConfigDir();
  ['GithubToken.enc', 'GithubToken'].forEach(f => {
    const p = path.join(configDir, f);
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (e) {}
  });
}

function sendLog(msg) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('seal-log', String(msg)); }
function sendProgress(percent, step, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('seal-progress', { percent: Math.max(0, Math.min(100, Math.round(percent))), step: step || null, message: message || null });
  }
}

function httpsPost(hostname, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({ hostname, path: pathname, method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }, headers || {}) }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        console.log('\n>>> [API 响应] 状态码:', res.statusCode);
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } 
        catch (e) { reject(new Error('响应解析失败: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject); req.write(bodyStr); req.end();
  });
}

function httpsGet(hostname, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: pathname, method: 'GET', headers: headers || {} }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch (e) { reject(new Error('响应解析失败')); } });
    });
    req.on('error', reject); req.end();
  });
}

function httpsGetBuffer(hostname, pathname, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: pathname, method: 'GET', headers: headers || {} }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

function findNodePath() { return process.execPath; }

function spawnJS(scriptPath, args, cwd, onProgress) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(findNodePath(), [scriptPath, ...args], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    } catch (e) { return reject(new Error('无法启动内置 Node.js：' + e.message)); }

    let stderrBuf = '';
    child.stdout.on('data', (data) => {
      for (const raw of data.toString('utf8').split(/\r?\n/)) {
        const line = raw.trim(); if (!line) continue;
        const mProgress = line.match(/^\[CS_PROGRESS\]\s+(\d+)/);
        if (mProgress) { if (onProgress) onProgress(parseInt(mProgress[1], 10)); continue; }
        const mError = line.match(/^\[CS_ERROR\]\s+(.+)/);
        if (mError) { sendLog('[ERR] ' + mError[1]); continue; }
        sendLog(line);
      }
    });

    child.stderr.on('data', (data) => {
      stderrBuf += data.toString('utf8');
      for (const raw of data.toString('utf8').split(/\r?\n/)) {
        const line = raw.trim(); if (line) sendLog('[STDERR] ' + line);
      }
    });

    child.on('error', (e) => reject(new Error('Node.js 进程错误：' + e.message)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('脚本退出码 ' + code + (stderrBuf ? '：' + stderrBuf.slice(0, 300) : '')));
    });
  });
}

async function fetchKernelFile(repoPath, timeoutMs) {
  let lastErr = null;
  const sources = getKernelSources();
  for (const src of sources) {
    try { return await httpsGetBuffer(src.host, '/' + repoPath, { 'User-Agent': 'Chronos-Seal-GUI', 'Accept': '*/*' }, timeoutMs || 8000); } 
    catch (e) { lastErr = e; sendLog('[Kernel] ' + src.label + ' 失败: ' + e.message); }
  }
  throw new Error('所有源都不可用: ' + (lastErr ? lastErr.message : 'unknown'));
}

function verifyManifestSignature(manifestBuf, sigBytes) {
  const pubKeyRaw = Buffer.from(PUBLIC_KEY_B64, 'base64');
  const pubKeyObj = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubKeyRaw]), format: 'der', type: 'spki' });
  return crypto.verify(null, manifestBuf, pubKeyObj, sigBytes);
}

async function fetchAndVerifyKernel(engine) {
  const basePath = `CrCLARE/Chronos-Seal-GUI/main/Tools/${KERNEL_VERSION}/${engine.toUpperCase()}`;
  const localDir = getKernelCacheDir(engine);
  sendLog('[Kernel] 拉取 manifest.json ...');
  const manifestBuf = await fetchKernelFile(basePath + '/manifest.json');
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  sendLog('[Kernel] 拉取 manifest.sig ...');
  const sigBuf = await fetchKernelFile(basePath + '/manifest.sig');
  if (!verifyManifestSignature(manifestBuf, Buffer.from(sigBuf.toString('utf8').trim(), 'base64'))) throw new Error('❌ 内核签名验证失败！');

  const fileNames = Object.keys(manifest.files || {});
  ensureDir(localDir);
  for (const name of fileNames) {
    const fileBuf = await fetchKernelFile(basePath + '/' + name);
    if (crypto.createHash('sha256').update(fileBuf).digest('hex') !== manifest.files[name]) throw new Error('❌ 文件哈希不匹配');
    const dest = path.join(localDir, name);
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, fileBuf);
  }
  fs.writeFileSync(path.join(localDir, '_verified.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), manifest }, null, 2));
  return localDir;
}

async function ensureKernel(engine) {
  const localDir = getKernelCacheDir(engine);
  const manifestPath = path.join(localDir, 'manifest.json');
  const sigPath = path.join(localDir, 'manifest.sig');
  if (fs.existsSync(manifestPath) && fs.existsSync(sigPath)) {
    try {
      const manifestBuf = fs.readFileSync(manifestPath);
      const sigBytes = Buffer.from(fs.readFileSync(sigPath, 'utf8').trim(), 'base64');
      if (verifyManifestSignature(manifestBuf, sigBytes)) return localDir;
    } catch (e) {}
  }
  return await fetchAndVerifyKernel(engine);
}

async function sealProjectMV(pkg, gameName, version) {
  sendProgress(2, 1, '派生种子');
  const seedInfo = loadOrCreateSeed('mv', gameName, version);
  const today = new Date().toISOString().slice(0, 10);
  sendProgress(3, 2, '准备内核');
  const kernelDir = await ensureKernel('mv');
  sendProgress(5, 2, '生成 5 个壳插件');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-build-'));
  try {
    fs.copyFileSync(path.join(kernelDir, 'CLARE_Shell.mv.tmpl'), path.join(tmp, 'CLARE_Shell.mv.tmpl'));
    const buildScript = path.join(kernelDir, 'mv_build.js');
    for (let i = 1; i <= 5; i++) {
      await spawnJS(buildScript, ['--shell', String(i), '--name', gameName, '--version', version, '--date', today, '--seed', seedInfo.seed, '--salt', String(seedInfo.salt)], tmp);
    }
    const shellSrcDir = path.join(tmp, 'www', 'js', 'plugins');
    const shellDstDir = path.join(pkg, 'www', 'js', 'plugins');
    ensureDir(shellDstDir);
    if (fs.existsSync(shellSrcDir)) {
      fs.readdirSync(shellSrcDir).forEach(f => fs.copyFileSync(path.join(shellSrcDir, f), path.join(shellDstDir, f)));
    }
    const tmpConfig = path.join(tmp, 'encrypt_config.json');
    if (fs.existsSync(tmpConfig)) fs.copyFileSync(tmpConfig, path.join(pkg, 'encrypt_config.json'));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }

  const shellName = deriveShellName(seedInfo.seed, gameName, version);
  const wwwIndex = path.join(pkg, 'www', 'index.html');
  if (fs.existsSync(wwwIndex)) fs.writeFileSync(wwwIndex, renderIndexHtml(kernelDir, gameName, shellName), 'utf8');
  await spawnJS(path.join(kernelDir, 'encrypt_assets_mv.js'), ['--encrypt'], pkg);
  await spawnJS(path.join(kernelDir, 'encrypt_assets_mv.js'), ['--verify'], pkg);
  sendProgress(100, 7, '完成');
}

async function sealProjectMZ(pkg, gameName, version) { throw new Error('MZ 模式尚未支持（需实现基于 Fork 后的云端编译流程）'); }

function loadOrCreateSeed(engine, gameName, version) {
  const gameDir = path.join(getFilesDir(), gameName + ' ' + version);
  ensureDir(gameDir);
  const configPath = path.join(gameDir, 'encrypt_config.json');
  if (fs.existsSync(configPath)) {
    try { const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); if (cfg.seed && cfg.seedSalt !== undefined) return { seed: cfg.seed, salt: cfg.seedSalt, gameDir }; } catch (e) {}
  }
  return { seed: crypto.randomBytes(engine === 'mv' ? 32 : 48).toString('hex'), salt: Math.floor(Math.random() * 0xFFFFFFFF) >>> 0, gameDir };
}

function deriveShellName(seedStr, gameName, version) {
  return SHELL_NAMES[crypto.createHash('sha256').update(`${seedStr}|${gameName}|${version}`).digest()[0] % 5];
}

function renderIndexHtml(kernelDir, gameName, shellName) {
  let content = fs.readFileSync(path.join(kernelDir, 'index.html'), 'utf8');
  return content.replace(/@@GAME_NAME@@/g, gameName).replace(/@@SHELL_NAME@@/g, shellName);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 650, minWidth: 720, minHeight: 480, frame: false, backgroundColor: '#0e0e12',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

// ============================================================
// 修复后的回调服务器（带端口占用处理和超时清理）
// ============================================================
function waitForCallback(timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
        if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(code ? '<h2>授权成功</h2><p>请返回 GUI</p>' : '<h2>授权失败</h2>');
        if (timer) clearTimeout(timer);
        server.close();
        if (code) resolve(code); else reject(new Error(error || '用户拒绝授权'));
      } catch (e) { if (timer) clearTimeout(timer); server.close(); reject(e); }
    });

    server.on('error', (e) => {
      if (timer) clearTimeout(timer);
      if (e.code === 'EADDRINUSE') {
        reject(new Error('端口 8080 被占用！请关闭占用该端口的程序（如其他Electron窗口、Java程序等）后重试。或者使用“设备码授权”模式。'));
      } else {
        reject(new Error('本地回调服务器失败：' + e.message));
      }
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => console.log('>>> 本地回调服务器已启动，监听 8080 端口'));
    timer = setTimeout(() => { server.close(); reject(new Error('授权超时，请重试或使用设备码授权')); }, timeoutMs || 300000);
  });
}

ipcMain.handle('github-login', async () => {
  const { verifier, challenge } = generatePKCE();
  const callbackPromise = waitForCallback(300000);
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent('repo user workflow')}&code_challenge=${challenge}&code_challenge_method=S256`;
  await shell.openExternal(authUrl);
  const code = await callbackPromise;
  
  const cfg = readConfig();
  const proxy = (cfg.devMode === 'true' && cfg.customProxy) ? cfg.customProxy : 'https://proxy.crclare.top';
  const proxyUrlObj = new URL(proxy);
  const tokenRes = await httpsPost(proxyUrlObj.hostname, proxyUrlObj.pathname, { code, code_verifier: verifier });
  if (tokenRes.json.error) throw new Error('换 token 失败：' + tokenRes.json.error);
  
  const userRes = await httpsGet('api.github.com', '/user', { 'User-Agent': 'Chronos-Seal-GUI', 'Authorization': 'Bearer ' + tokenRes.json.access_token, 'Accept': 'application/vnd.github+json' });
  await saveGithubToken(tokenRes.json.access_token);
  updateConfig({ github_login: userRes.json.login });
  return { login: userRes.json.login, avatar_url: userRes.json.avatar_url || '' };
});

ipcMain.handle('github-device-flow-start', async () => {
  const res = await httpsPost('github.com', '/login/device/code', { client_id: GITHUB_CLIENT_ID, scope: 'repo user workflow' }, { 'Accept': 'application/json' });
  if (res.json.error) throw new Error(res.json.error_description || res.json.error);
  return { device_code: res.json.device_code, user_code: res.json.user_code, verification_uri: res.json.verification_uri, expires_in: res.json.expires_in, interval: res.json.interval || 5 };
});

ipcMain.handle('github-device-flow-poll', async (event, { deviceCode }) => {
  const res = await httpsPost('github.com', '/login/oauth/access_token', { client_id: GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, { 'Accept': 'application/json' });
  if (res.json.error) { if (res.json.error === 'authorization_pending' || res.json.error === 'slow_down') return null; throw new Error(res.json.error_description || res.json.error); }
  const userRes = await httpsGet('api.github.com', '/user', { 'User-Agent': 'Chronos-Seal-GUI', 'Authorization': 'Bearer ' + res.json.access_token, 'Accept': 'application/vnd.github+json' });
  await saveGithubToken(res.json.access_token);
  updateConfig({ github_login: userRes.json.login });
  return { login: userRes.json.login, avatar_url: userRes.json.avatar_url || '' };
});

ipcMain.handle('open-external', async (event, url) => { await shell.openExternal(url); });
ipcMain.handle('github-logout', async () => { await clearGithubToken(); updateConfig({ github_login: '' }); return { ok: true }; });
ipcMain.handle('github-get-status', async () => {
  const token = await loadGithubToken();
  if (!token) return { connected: false };
  try {
    const userRes = await httpsGet('api.github.com', '/user', { 'User-Agent': 'Chronos-Seal-GUI', 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' });
    if (userRes.status === 200 && userRes.json.login) return { connected: true, login: userRes.json.login, avatar_url: userRes.json.avatar_url || '' };
  } catch (e) {}
  return { connected: false };
});

ipcMain.handle('detect-node', async () => { return { installed: true, version: process.versions.node, isEmbedded: true }; });
ipcMain.handle('install-node', async () => { return { success: true, version: process.versions.node, nodePath: process.execPath }; });
ipcMain.handle('load-config', async () => readConfig());
ipcMain.handle('save-config', async (event, patch) => { updateConfig(patch || {}); return { ok: true }; });

ipcMain.handle('toggle-dev-mode', async (event, enabled) => { updateConfig({ devMode: enabled ? 'true' : 'false' }); return { ok: true }; });
ipcMain.handle('save-dev-config', async (event, { customProxy, customKernelSources }) => { updateConfig({ customProxy: customProxy || '', customKernelSources: customKernelSources || '' }); return { ok: true }; });

ipcMain.handle('select-folder', async (event, type) => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: type === 'seal-output-path' ? '请选择发行包目录（包含 www/ 和 Game.exe）' : '请选择工程主目录（包含 Game.rpgproject）' });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const selectedPath = result.filePaths[0];
  let valid = true; let errorMsg = '';
  if (type === 'seal-output-path') {
    const wwwDir = path.join(selectedPath, 'www');
    const exe1 = path.join(selectedPath, 'Game.exe');
    const exe2 = path.join(selectedPath, 'game.exe');
    const projectFile = path.join(selectedPath, 'Game.rpgproject');
    if (!fs.existsSync(wwwDir) || (!fs.existsSync(exe1) && !fs.existsSync(exe2))) { valid = false; errorMsg = '该目录不是有效的发行包目录！'; } 
    else if (fs.existsSync(projectFile)) { valid = false; errorMsg = '检测到工程文件（Game.rpgproject）。请选择【发行包目录】！'; }
  } else if (type === 'patch-input-path') {
    const projectFile = path.join(selectedPath, 'Game.rpgproject');
    const wwwDir = path.join(selectedPath, 'www');
    const exe1 = path.join(selectedPath, 'Game.exe');
    if (!fs.existsSync(projectFile)) { valid = false; errorMsg = '该目录不是有效的工程目录！请选择包含 Game.rpgproject 的目录。'; } 
    else if (fs.existsSync(wwwDir) || fs.existsSync(exe1)) { valid = false; errorMsg = '检测到发行包文件。请选择【工程主目录】！'; }
  }
  return { canceled: false, path: selectedPath, valid, errorMsg };
});

ipcMain.handle('fork-template-repo', async (event, { templateOwner, templateRepo }) => {
  const token = await loadGithubToken();
  if (!token) throw new Error('未登录 GitHub，无法 Fork 仓库');
  return new Promise((resolve, reject) => {
    const options = { hostname: 'api.github.com', path: `/repos/${templateOwner}/${templateRepo}/forks`, method: 'POST', headers: { 'User-Agent': 'Chronos-Seal-GUI', 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' } };
    const req = https.request(options, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        console.log('\n>>> [Fork 响应] 状态码:', res.statusCode, '原始数据:', data, '\n');
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 202 || res.statusCode === 200) resolve({ success: true, repoUrl: json.clone_url, owner: json.owner.login });
          else reject(new Error(json.message || 'Fork 失败，请检查是否授予了 repo 权限'));
        } catch (e) { reject(new Error('响应解析失败')); }
      });
    });
    req.on('error', reject); req.end();
  });
});

ipcMain.handle('fetch-kernel', async (event, engine) => {
  sendLog('[Kernel] 开始拉取 ' + engine.toUpperCase() + ' 内核...');
  const dir = await ensureKernel(engine);
  sendLog('[Kernel] 内核已就绪: ' + dir);
  return dir;
});

ipcMain.handle('seal-project', async (event, opts) => {
  const { packagePath, gameName, version, engine } = opts || {};
  if (!packagePath || !gameName || !version) throw new Error('缺少必要参数');
  if (engine === 'mv') await sealProjectMV(packagePath, gameName, version);
  else if (engine === 'mz') await sealProjectMZ(packagePath, gameName, version);
  else throw new Error('未知引擎');
  return { ok: true, outputPath: packagePath };
});

app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
