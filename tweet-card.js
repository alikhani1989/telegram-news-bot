// ساخت کارت تصویری از توییت (PNG) با کروم بدون‌واسطه
// چرا کارت می‌سازیم و اسکرین‌شات نمی‌گیریم؟ صفحه‌ی توییتر برای کاربر مهمان
// فقط دیوار «وارد شوید» را نشان می‌دهد، پس اسکرین‌شات بی‌فایده است.
// کارت را از داده‌ی خودمان می‌سازیم: رایگان، سریع و همیشه درست.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'google-chrome', 'chromium-browser', 'chromium',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (p.includes('/') || p.includes('\\')) {
        if (fs.existsSync(p)) return p;
      } else {
        return p; // نام ساده: در PATH جست‌وجو می‌شود
      }
    } catch (e) { /* ادامه */ }
  }
  return null;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// حروف اول نام برای آواتار جایگزین وقتی عکس پروفایل در دسترس نیست
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '؟';
  if (parts.length === 1) return parts[0].slice(0, 1);
  return parts[0].slice(0, 1) + parts[1].slice(0, 1);
}

function faDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const months = ['ژانویه', 'فوریه', 'مارس', 'آوریل', 'مه', 'ژوئن', 'ژوئیه', 'اوت', 'سپتامبر', 'اکتبر', 'نوامبر', 'دسامبر'];
  return d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

// فونت فارسی داخل خود فایل جاسازی می‌شود (base64): کارت به اینترنت وابسته نیست و
// در رندر headless هم حروف به‌هم نمی‌چسبند (مشکلی که با لینک CDN دیده شد).
function fontFaceCss() {
  const dir = path.join(__dirname, 'fonts');
  const face = (file, weight) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return '';
    const b64 = fs.readFileSync(p).toString('base64');
    return `@font-face{font-family:Vazirmatn;src:url(data:font/woff2;base64,${b64}) format('woff2');font-weight:${weight};font-style:normal;}\n`;
  };
  return face('Vazirmatn-Regular.woff2', 400) + face('Vazirmatn-Bold.woff2', 700);
}

const CARD_CSS = `
${fontFaceCss()}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1100px;font-family:Vazirmatn,Tahoma,'Segoe UI',sans-serif;direction:rtl;
  background:linear-gradient(135deg,#0f2027 0%,#1b3a4b 55%,#14293a 100%);padding:36px}
.card{background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,.35)}
.head{display:flex;align-items:center;gap:18px;padding:28px 32px 22px;border-bottom:1px solid #eef1f4}
.avatar{width:96px;height:96px;border-radius:50%;object-fit:cover;background:#dfe6ec;flex:0 0 auto}
.initials{width:96px;height:96px;border-radius:50%;background:linear-gradient(135deg,#1b6ca8,#0e4d75);
  color:#fff;display:flex;align-items:center;justify-content:center;font-size:38px;font-weight:700;flex:0 0 auto}
.who{flex:1;min-width:0}
.name{font-size:31px;font-weight:700;color:#0f1b24;line-height:1.35}
.handle{font-size:24px;color:#5b6b7a;direction:ltr;text-align:right;line-height:1.5}
.date{font-size:21px;color:#8a97a3;margin-top:4px}
.badge{background:#eaf3fa;color:#12558c;font-size:20px;padding:9px 20px;border-radius:999px;
  align-self:flex-start;white-space:nowrap;font-weight:700}
.body{padding:30px 32px 8px;font-size:29px;line-height:2.05;color:#16222d;white-space:pre-wrap;word-wrap:break-word}
.foot{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:22px 32px 28px;border-top:1px solid #eef1f4;margin-top:10px}
.brand{font-size:22px;color:#54636f;line-height:1.7}
.brand b{color:#0f1b24;font-weight:700}
.hint{font-size:21px;color:#98a4ae;direction:ltr}
`;

function buildTweetCardHtml(t) {
  const avatar = t.avatarUrl && /^https?:\/\//.test(t.avatarUrl)
    ? '<img class="avatar" src="' + esc(t.avatarUrl) + '" alt="">'
    : '<div class="initials">' + esc(initials(t.name || t.handle)) + '</div>';
  const date = faDate(t.createdAt);
  return `<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8">
<style>${CARD_CSS}</style></head><body>
<div class="card">
  <div class="head">
    ${avatar}
    <div class="who">
      <div class="name">${esc(t.name || 'نماینده مجلس')}</div>
      <div class="handle">@${esc(t.handle || '')}</div>
      ${date ? '<div class="date">' + esc(date) + '</div>' : ''}
    </div>
    <div class="badge">نماینده مجلس</div>
  </div>
  <div class="body">${esc(t.text)}</div>
  <div class="foot">
    <div class="brand"><b>🇮🇷 این خانه</b> #ازما ست<br>🔰 @azmaa_net</div>
    <div class="hint">توییت اصلی نماینده در توییتر</div>
  </div>
</div>
</body></html>`;
}

function renderTweetCardPng(t, outPath) {
  const chrome = findChrome();
  if (!chrome) throw new Error('مرورگر کروم پیدا نشد');
  const html = buildTweetCardHtml(t);
  const tmpHtml = path.join(os.tmpdir(), 'tweet_card_' + Date.now() + '.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');
  // کروم مسیر نسبی را نمی‌پذیرد → مسیر مطلق با جداکننده‌ی / برای file://
  const outAbs = path.resolve(outPath);
  const url = 'file:///' + tmpHtml.split(path.sep).join('/');
  try {
    execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--virtual-time-budget=8000',
      '--window-size=1100,760', '--screenshot=' + outAbs, url,
    ], { stdio: 'pipe', timeout: 90000 });
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch (e) { /* بی‌اهمیت */ }
  }
  if (!fs.existsSync(outAbs)) throw new Error('تصویر ساخته نشد');
  return outAbs;
}

module.exports = { buildTweetCardHtml, renderTweetCardPng, findChrome };