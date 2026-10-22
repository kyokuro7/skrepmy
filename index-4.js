/*
 * Telegram Scrape Loader Bot
 * - Kirim file .js/.txt (scrape) ke bot -> otomatis disimpan di folder plugins/
 * - Dependency (require) yang belum ada diinstall otomatis
 * - Bot langsung menampilkan menu tombol + command untuk tiap scrape
 *
 * Jalankan: node --env-file=.env index.js   (Node 20.6+)
 */

const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { execFile, exec, spawn } = require('child_process');
const { builtinModules } = require('module');

// ================= CONFIG =================
const TOKEN = process.env.BOT_TOKEN;
const OWNERS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const PUBLIC_RUN = process.env.PUBLIC_RUN === 'true'; // true = semua orang boleh menjalankan scrape
const RUN_TIMEOUT = 120000; // 2 menit
const MAX_FILE_SIZE = 300 * 1024; // 300 KB
const PLUGIN_DIR = path.join(__dirname, 'plugins');
const RESERVED = ['start', 'menu', 'list', 'delscrape', 'help'];

if (!TOKEN) { console.error('BOT_TOKEN belum diisi di .env'); process.exit(1); }
if (!OWNERS.length) { console.error('OWNER_IDS belum diisi di .env'); process.exit(1); }

fs.mkdirSync(PLUGIN_DIR, { recursive: true });
const bot = new Telegraf(TOKEN, { handlerTimeout: 10 * 60 * 1000 });
const running = new Set();

// ================= HELPERS =================
const isOwner = (ctx) => OWNERS.includes(String(ctx.from && ctx.from.id));
const canRun = (ctx) => PUBLIC_RUN || isOwner(ctx);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sanitize = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

const pluginPath = (name) => path.join(PLUGIN_DIR, `${name}.js`);
const listPlugins = () =>
  fs.readdirSync(PLUGIN_DIR).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort();

function menuKeyboard(prefix = 'run', icon = '▶️') {
  const names = listPlugins();
  if (!names.length) return null;
  return Markup.inlineKeyboard(
    names.map(n => Markup.button.callback(`${icon} ${n}`, `${prefix}:${n}`)),
    { columns: 2 }
  );
}

async function syncCommands() {
  const base = [
    { command: 'menu', description: 'Menu scrape (tombol)' },
    { command: 'list', description: 'Daftar scrape terpasang' },
    { command: 'delscrape', description: 'Hapus scrape' },
  ];
  const dyn = listPlugins().map(n => ({ command: n, description: `Jalankan scrape ${n}`.slice(0, 250) }));
  try { await bot.telegram.setMyCommands([...base, ...dyn].slice(0, 100)); }
  catch (e) { console.error('setMyCommands gagal:', e.message); }
}

// Deteksi require()/import dan install paket yang belum ada
function detectDeps(code) {
  const found = new Set();
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    let mod = m[1] || m[2];
    if (!mod || mod.startsWith('.') || mod.startsWith('/')) continue;
    mod = mod.replace(/^node:/, '');
    const parts = mod.split('/');
    const pkg = mod.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (builtinModules.includes(pkg)) continue;
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg)) continue;
    found.add(pkg);
  }
  return [...found];
}

async function installMissing(code) {
  const missing = detectDeps(code).filter(pkg => {
    try { require.resolve(pkg, { paths: [__dirname] }); return false; }
    catch { return true; }
  });
  if (!missing.length) return [];
  await new Promise((resolve, reject) => {
    exec(`npm install ${missing.join(' ')} --no-audit --no-fund`,
      { cwd: __dirname, timeout: 180000 },
      (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
  return missing;
}

function checkSyntax(file) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', file], (err, _o, stderr) =>
      err ? reject(new Error(stderr.split('\n').slice(0, 6).join('\n'))) : resolve());
  });
}

function runPlugin(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [pluginPath(name)], { cwd: PLUGIN_DIR });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message, timedOut }); });
  });
}

async function execScrape(ctx, name) {
  if (!canRun(ctx)) return ctx.reply('⛔ Kamu tidak punya akses menjalankan scrape.');
  if (!fs.existsSync(pluginPath(name))) return ctx.reply(`Scrape "${name}" tidak ditemukan.`);
  if (running.has(name)) return ctx.reply(`⏳ "${name}" masih berjalan, tunggu sebentar.`);

  running.add(name);
  const wait = await ctx.reply(`⏳ Menjalankan <b>${esc(name)}</b>...`, { parse_mode: 'HTML' });
  try {
    const r = await runPlugin(name);
    let out = r.stdout.trim();
    if (!out) out = r.stderr.trim() || '(tidak ada output)';
    if (r.timedOut) out = `⏱ Timeout ${RUN_TIMEOUT / 1000}s\n\n${out}`;

    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    if (out.length <= 3500) {
      await ctx.reply(`<b>${esc(name)}</b>\n<pre>${esc(out)}</pre>`, { parse_mode: 'HTML' });
    } else {
      await ctx.replyWithDocument({ source: Buffer.from(out), filename: `${name}.txt` },
        { caption: `Hasil ${name} (terlalu panjang, dikirim sebagai file)` });
    }
  } finally {
    running.delete(name);
  }
}

// ================= COMMANDS =================
bot.start((ctx) => ctx.reply(
  '👋 <b>Scrape Loader Bot</b>\n\n' +
  '• Kirim file <code>.js</code> / <code>.txt</code> berisi scrape → otomatis terpasang\n' +
  '• Isi caption file untuk menentukan nama (opsional)\n' +
  '• /menu → tombol semua scrape\n' +
  '• /delscrape → hapus scrape',
  { parse_mode: 'HTML' }
));

bot.command(['menu', 'list'], (ctx) => {
  const kb = menuKeyboard();
  if (!kb) return ctx.reply('Belum ada scrape. Kirim file .js/.txt untuk memasang.');
  return ctx.reply('📂 Pilih scrape:', kb);
});

bot.command('delscrape', (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('⛔ Khusus owner.');
  const kb = menuKeyboard('del', '🗑');
  if (!kb) return ctx.reply('Belum ada scrape.');
  return ctx.reply('Pilih scrape yang mau dihapus:', kb);
});

// ================= UPLOAD SCRAPE =================
bot.on('document', async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('⛔ Hanya owner yang boleh memasang scrape.');

  const doc = ctx.message.document;
  const fileName = doc.file_name || 'scrape.txt';
  if (!/\.(js|cjs|txt)$/i.test(fileName)) return ctx.reply('Kirim file berformat .js atau .txt');
  if (doc.file_size > MAX_FILE_SIZE) return ctx.reply('File terlalu besar (maks 300 KB).');

  const caption = (ctx.message.caption || '').trim();
  const name = sanitize(caption) || sanitize(fileName.replace(/\.[^.]+$/, ''));
  if (!name) return ctx.reply('Nama tidak valid. Beri caption nama scrape (huruf/angka/_).');
  if (RESERVED.includes(name)) return ctx.reply(`Nama "${name}" dipakai sistem, pilih nama lain.`);

  const status = await ctx.reply('📥 Mengunduh & memeriksa scrape...');
  const tmp = path.join(PLUGIN_DIR, `.tmp_${Date.now()}.js`);
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(link.href);
    if (!res.ok) throw new Error(`Download gagal (${res.status})`);
    const code = await res.text();

    fs.writeFileSync(tmp, code);
    await checkSyntax(tmp); // pastikan tidak ada syntax error

    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '📦 Mengecek dependency...');
    const installed = await installMissing(code);

    const existed = fs.existsSync(pluginPath(name));
    fs.renameSync(tmp, pluginPath(name));
    await syncCommands();

    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await ctx.reply(
      `✅ Scrape <b>${esc(name)}</b> ${existed ? 'diperbarui' : 'terpasang'}.\n` +
      (installed.length ? `📦 Dependency diinstall: ${esc(installed.join(', '))}\n` : '') +
      `Command: /${name}\n\nPilih scrape:`,
      { parse_mode: 'HTML', ...menuKeyboard() }
    );
  } catch (e) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await ctx.reply(`❌ Gagal memasang:\n<pre>${esc(e.message).slice(0, 1500)}</pre>`, { parse_mode: 'HTML' });
  }
});

// ================= BUTTON ACTIONS =================
bot.action(/^run:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Menjalankan...').catch(() => {});
  await execScrape(ctx, ctx.match[1]);
});

bot.action(/^del:(.+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const name = ctx.match[1];
  if (fs.existsSync(pluginPath(name))) fs.unlinkSync(pluginPath(name));
  await syncCommands();
  await ctx.answerCbQuery('Dihapus');
  const kb = menuKeyboard('del', '🗑');
  await ctx.editMessageText(kb ? `🗑 "${name}" dihapus. Hapus lagi?` : `🗑 "${name}" dihapus. Tidak ada scrape tersisa.`,
    kb || undefined).catch(() => {});
});

// ================= DYNAMIC COMMANDS (/namascrape) =================
bot.on('text', async (ctx, next) => {
  const m = ctx.message.text.match(/^\/([a-z0-9_]+)(@\w+)?(\s|$)/i);
  if (m && listPlugins().includes(m[1].toLowerCase())) return execScrape(ctx, m[1].toLowerCase());
  return next();
});

bot.catch((err) => console.error('Bot error:', err));

bot.launch().then(async () => {
  await syncCommands();
  console.log('Bot berjalan. Scrape terpasang:', listPlugins().join(', ') || '(kosong)');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
