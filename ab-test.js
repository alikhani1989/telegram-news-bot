// ==========================================
// تست A/B: NaraRouter (agnes-3-flash) در برابر Gemini Flash
// ------------------------------------------
// هدف: فهمیدن اینکه آیا واقعاً جعل مصاحبه/نام/عدد با مدل Gemini کمتر می‌شود؟
// این اسکریپت هیچ تأثیری روی خط تولید ندارد:
//   - چیزی به تلگرام نمی‌فرستد
//   - state.json را دست نمی‌زند
//   - فقط می‌خواند، مقایسه می‌کند، گزارش می‌دهد
//
// ورودی: همان RSS واقعی که ربات استفاده می‌کند (بدون کلید لازم است).
// پرامپت: همان buildPrompt تولیدی — نه نسخه‌ی کپی‌شده.
// امتیاز: همان validateNewsItem + verifyAgainstOriginal تولیدی.
//
// نحوه اجرا:
//   NARA_ROUTER_API_KEY=... GEMINI_API_KEY=... node ab-test.js
//   NARA_ROUTER_API_KEY=... GEMINI_API_KEY=... node ab-test.js --count 8
//   NARA_ROUTER_API_KEY=... GEMINI_API_KEY=... node ab-test.js --schema
//   NARA_ROUTER_API_KEY=... node ab-test.js            (فقط NaraRouter، برای خط پایه)
//
// --schema : پارامتر responseSchema را برای Gemini فعال می‌کند تا تأثیرش جداگانه دیده شود
// --count N: تعداد خبر در بسته‌ی آزمایشی (پیش‌فرض ۶)
// ==========================================

const fs = require('fs');
const path = require('path');
const bot = require('./index.js');

// کلیدها ممکن است به‌جای env در config.json باشند (همان‌طور که خط تولید loadConfig می‌خواند).
// وگرنه هارنس محلی کلید موجود را نمی‌بیند.
function loadLocalConfig() {
  try {
    const p = path.join(__dirname, 'config.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } catch (e) { return {}; }
}

const ARGV = process.argv.slice(2);
function argNum(name, def) {
  const i = ARGV.indexOf(name);
  if (i === -1) return def;
  const v = parseInt(ARGV[i + 1], 10);
  return isNaN(v) ? def : v;
}
const COUNT = argNum('--count', 6);
const USE_SCHEMA = ARGV.includes('--schema');
const SELFTEST = ARGV.includes('--selftest');

const LOCAL_CFG = loadLocalConfig();
// env مقدم است، مثل loadConfig تولیدی
const GEMINI_KEY = process.env.GEMINI_API_KEY || LOCAL_CFG.GEMINI_API_KEY || '';
const NARA_KEY = process.env.NARA_ROUTER_API_KEY || LOCAL_CFG.NARA_ROUTER_API_KEY || '';

// همان خروجی که تولید انتظار دارد
const NEWS_SCHEMA = {
  type: 'object',
  properties: {
    news: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          source_link: { type: 'string' },
          image_url: { type: 'string' },
        },
        required: ['title', 'body'],
      },
    },
  },
  required: ['news'],
};

// ------------------------------------------
// فراخوانی Gemini با مدل قابل انتخاب
// (کپی کنترل‌شده از callGemini تولیدی؛ تفاوت فقط: مدل و responseSchema اختیاری)
// ------------------------------------------
async function callGeminiAB(prompt, model) {
  if (!GEMINI_KEY) return { ok: false, error: 'GEMINI_API_KEY تنظیم نشده' };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + model + ':generateContent?key=' + encodeURIComponent(GEMINI_KEY);

  const systemMsg = 'You are a senior Persian-language news editor. You write concise Telegram news items. '
    + 'CRITICAL RULES: 1) ONLY output raw JSON. ZERO text before or after. 2) NEVER write analysis or reasoning. '
    + '3) Copy names EXACTLY from source. 4) Use مجلس not مجلس شورای اسلامی. '
    + '5) Start titles with ✴, body paragraphs with 🔸. 6) Body should be 1-2 short paragraphs. '
    + '7) Titles MUST be event-focused, NOT quote-style. NEVER start title with a person name followed by colon. '
    + '8) NEVER invent an interview or a media source that is not explicitly in the original text.';

  const generationConfig = {
    temperature: 0.1,
    maxOutputTokens: 16000,
    responseMimeType: 'application/json',
  };
  if (USE_SCHEMA) generationConfig.responseSchema = NEWS_SCHEMA;

  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: systemMsg + '\n\n' + prompt }] }],
    generationConfig,
  });

  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const data = await res.json();
    if (!res.ok || data.error) {
      return { ok: false, ms, error: 'HTTP ' + res.status + ': '
        + ((data.error && data.error.message) || 'خطای ناشناخته').substring(0, 200) };
    }
    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && cand.content.parts && cand.content.parts[0]
      && cand.content.parts[0].text;
    if (!text || !text.trim()) return { ok: false, ms, error: 'پاسخ خالی' };
    return { ok: true, ms, text };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.name === 'AbortError' ? 'timeout 45s' : e.message };
  }
}

// ------------------------------------------
// ساخت بسته‌ی آزمایشی از RSS واقعی
// ------------------------------------------
async function buildCorpus(count) {
  console.log('📡 خواندن RSS واقعی...');
  const rss = await bot.fetchRSSNews();
  console.log('   ' + rss.length + ' خبر مرتبط با مجلس پیدا شد.');

  // اولویت با اخباری که «مصاحبه/گفتگو» دارند — دقیقاً همانجایی که جعل رخ می‌دهد
  const interviewRe = /مصاحبه|گفتگو|به خبرنگار|خبرنگار ما|گفت و گو/;
  const withIv = rss.filter(r => interviewRe.test(r.description || ''));
  const withoutIv = rss.filter(r => !interviewRe.test(r.description || ''));
  const picked = withIv.slice(0, Math.min(count, withIv.length));
  for (const r of withoutIv) {
    if (picked.length >= count) break;
    picked.push(r);
  }

  console.log('📖 خواندن متن کامل ' + picked.length + ' خبر...');
  const corpus = [];
  for (const r of picked) {
    let text = r.description || '';
    try {
      const full = await bot.fetchArticleText(r.link);
      if (full && full.length > text.length) text = full;
    } catch (e) { /* از description استفاده می‌شود */ }
    text = (text || '').trim();
    if (text.length < 120) { console.log('   ⏭️ رد شد (خیلی کوتاه): ' + (r.title || '').substring(0, 50)); continue; }
    corpus.push({ title: r.title, link: r.link, source: r.source, text, hasInterview: interviewRe.test(text) });
    console.log('   ✅ ' + (r.source || '?') + ' — ' + text.length + ' کاراکتر'
      + (interviewRe.test(text) ? ' [مصاحبه‌دار]' : ''));
  }
  return corpus;
}

// ------------------------------------------
// ارزیابی خروجی یک مدل
// ------------------------------------------
// نرمال‌سازی لینک: مدل‌ها گاهی / انتهاف query یا کدگذاری URL را عوض می‌کنند.
// بدون این، نگاشت خبر به متن اصلی می‌شکند و بررسی جعل بی‌صدا skip می‌شود.
function normLink(u) {
  if (!u) return '';
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const x = new URL(s);
    return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/+$/, '');
  } catch (e) {
    return s.replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
}

function scoreOutput(items, corpus) {
  const byLink = {};
  for (const c of corpus) if (c.link) byLink[normLink(c.link)] = c.text;

  const results = [];
  for (const item of items) {
    // اگر لینک خروجی با هیچ‌کدام از ورودی‌ها نخورد، نباید «بدون جعل» حساب شود؛
    // چون verifyAgainstOriginal با متن خالی همیشه صفر برمی‌گرداند.
    const original = byLink[normLink(item.source_link)] || '';
    const v = bot.validateNewsItem(item, original);
    const forgery = original ? bot.verifyAgainstOriginal(item, original) : [];
    results.push({
      title: item.title || '',
      body: item.body || '',
      source_link: item.source_link || '',
      verified: !!original,           // آیا اصلاً قابل مقایسه با منبع بود؟
      score: v.score,
      issues: v.issues,
      forgery: forgery,
      forgeryCount: forgery.length,
    });
  }
  return results;
}

function unverifiedCount(scored) {
  return scored.filter(s => !s.verified).length;
}

function avg(nums) {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 10) / 10;
}

// ------------------------------------------
// اجرای اصلی
// ------------------------------------------
(async function main() {
  // ===== تست خود هارنس: بدون شبکه و بدون کلید =====
  // ثابت می‌کند نگاشت لینک، پرچم verified، شمارش جعل و جدول درست کار می‌کنند.
  if (SELFTEST) {
    console.log('\n🧪 تست خودکار هارنس (بدون شبکه/کلید)...');
    const corpus = [
      { title: 'خبر مصاحبه‌دار', link: 'https://www.icana.ir/news/1', source: 'ICANA',
        text: 'خبر مجلس: علی محمدی عضو کمیسیون صنایع و معادن مجلس در حاشیه جلسه علنی گفت این طرح با اکثریت آرا تصویب شد و رقم اعتبار آن ۲۵۰ میلیارد تومان برای سال آینده در نظر گرفته شده است. او همچنین از بررسی دو فوریت دیگر خبر داد و گفت جلسه بعدی هفته آینده برگزار می‌شود.',
        hasInterview: false },
      { title: 'خبر ساده', link: 'https://www.icana.ir/news/2', source: 'ICANA',
        text: 'محمدرضا رضایی کوچی رئیس کمیسیون عمران مجلس گفت عملیات جستجوی مفقودشدگان سیلاب ادامه دارد و تا کنون ۴۰ نفر نجات یافته‌اند. او از بسیج تمام ظرفیت‌های امدادی خبر داد و گفت اردوگاه‌های اسکان برپا شده است.',
        hasInterview: false },
    ];

    // خروجی تمیز: لینک دقیق، بدون جعل
    const cleanItems = [
      { title: '✴️ تصویب طرح در کمیسیون صنایع',
        body: '🔸 علی محمدی عضو کمیسیون صنایع و معادن مجلس گفت این طرح با اکثریت آرا تصویب شد و اعتبار آن ۲۵۰ میلیارد تومان است.',
        source_link: 'https://www.icana.ir/news/1' },
      { title: '✴️ ادامه عملیات جستجوی مفقودشدگان',
        body: '🔸 محمدرضا رضایی کوچی رئیس کمیسیون عمران مجلس گفت عملیات جستجو ادامه دارد و تا کنون ۴۰ نفر نجات یافته‌اند.',
        source_link: 'https://www.icana.ir/news/2' },
    ];

    // خروجی جعلی: مصاحبه‌ی ساختگی + عدد جعلی + لینک خراب (بدون https و با slash اضافه)
    const fakeItems = [
      { title: '✴️ اذعان مقام آمریکایی به شکست فشار حداکثری',
        body: '🔸 علی محمدی عضو کمیسیون صنایع و معادن مجلس در مصاحبه با خبرگزاری ایرنا گفت فشار حداکثری شکست خورده و ۹۸۰ میلیارد دلار خسارت به آمریکا وارد شده است.',
        source_link: 'www.icana.ir/news/1/' },
    ];

    const cleanScored = scoreOutput(cleanItems, corpus);
    const fakeScored = scoreOutput(fakeItems, corpus);

    let fail = 0;
    const check = (label, cond, got) => {
      console.log((cond ? '  ✅ ' : '  ❌ ') + label + ' → ' + got);
      if (!cond) fail++;
    };

    check('لینک دقیق → verified', cleanScored.every(s => s.verified),
      cleanScored.map(s => s.verified).join(','));
    check('لینک بدون https و با slash اضافه هم نگاشت می‌شود', fakeScored[0].verified, fakeScored[0].verified);
    check('خروجی تمیز: جعل صفر', cleanScored.every(s => s.forgeryCount === 0),
      cleanScored.reduce((a, s) => a + s.forgeryCount, 0));
    check('مصاحبه‌ی ساختگی گرفته می‌شود', /جعل مصاحبه/.test(fakeScored[0].forgery.join(' ')),
      fakeScored[0].forgeryCount + ' مورد');
    check('عدد جعلی گرفته می‌شود', /اعداد ناموجود/.test(fakeScored[0].forgery.join(' ')),
      fakeScored[0].forgery.join(' | ').substring(0, 60));
    check('نمره‌ی خروجی تمیز بالاست', cleanScored.every(s => s.score >= 90),
      cleanScored.map(s => s.score).join(','));

    // لینک ناشناخته نباید «بدون جعل» گزارش شود
    const orphan = scoreOutput([{ title: 't', body: cleanItems[0].body, source_link: 'https://example.com/x' }], corpus);
    check('لینک ناشناخته → verified=false (نه جعل صفر دروغین)', orphan[0].verified === false, orphan[0].verified);

    console.log('\n' + (fail === 0 ? '✅ هارنس سالم است — ' + 'همه‌ی بررسی‌ها گذشت' : '❌ ' + fail + ' بررسی ناموفق'));
    process.exit(fail === 0 ? 0 : 1);
  }

  console.log('\n🧪 ===== تست A/B خط تولید خبر =====');
  console.log('   مدل NaraRouter : agnes-3-flash (وضعیت فعلی تولید)');
  console.log('   مدل Gemini     : ' + (GEMINI_KEY ? 'gemini-2.5-flash' : '— (کلید نیست)'));
  console.log('   responseSchema : ' + (USE_SCHEMA ? 'روشن' : 'خاموش (دقیقاً مثل تولید)'));
  console.log('   تعداد خبر      : ' + COUNT);

  if (!NARA_KEY && !GEMINI_KEY) {
    console.log('\n❌ هیچ کلیدی تنظیم نشده. مثال:');
    console.log('   NARA_ROUTER_API_KEY=... GEMINI_API_KEY=... node ab-test.js');
    process.exit(1);
  }
  if (!NARA_KEY) {
    console.log('\n⚠️ NARA_ROUTER_API_KEY موجود نیست → مدل پایه‌ی agnes-3-flash اجرا نمی‌شود.');
    console.log('   مقایسه‌ی کامل فقط Gemini را نشان می‌دهد، نه برنده/بازنده را.');
  }

  const corpus = await buildCorpus(COUNT);
  if (corpus.length === 0) {
    console.log('\n❌ ورودی واقعی پیدا نشد؛ تست قابل اجرا نیست.');
    process.exit(1);
  }

  const rawNews = corpus.map((c, i) => {
    let block = '\n\n===== NEWS ' + (i + 1) + ' =====\n';
    block += '[لینک منبع: ' + c.link + ']\n';
    block += '[منبع: ' + (c.source || 'نامشخص') + ']\n';
    block += c.text.length > 2000 ? c.text.substring(0, 2000) + '...' : c.text;
    return block;
  }).join('');

  // همان پرامپت تولیدی، برای هر دو مدل یکسان
  const prompt = bot.buildPrompt(rawNews, '');

  const out = { timestamp: new Date().toISOString(), count: corpus.length, useSchema: USE_SCHEMA, corpus: [], models: {} };

  console.log('\n—— خلاصه‌ی ورودی ——');
  for (const c of corpus) {
    console.log(' • ' + (c.title || '').substring(0, 70));
    out.corpus.push({ title: c.title, link: c.link, source: c.source, len: c.text.length, hasInterview: c.hasInterview });
  }

  // ===== NaraRouter (خط پایه) =====
  if (NARA_KEY) {
    console.log('\n🟣 اجرای NaraRouter (agnes-3-flash)...');
    const t0 = Date.now();
    const raw = await bot.callNaraRouter(prompt);
    const ms = Date.now() - t0;
    if (!raw) {
      console.log('   ❌ پاسخی نگرفت');
      out.models.nara = { ok: false, error: 'پاسخی برنگشت' };
    } else {
      const items = bot.safeParseJson(raw);
      if (!items.length) {
        console.log('   ❌ JSON پارس نشد');
        out.models.nara = { ok: false, error: 'پارس JSON ناموفق', raw: raw.substring(0, 500) };
      } else {
        const scored = scoreOutput(items, corpus);
        out.models.nara = { ok: true, ms, itemCount: scored.length, items: scored };
        console.log('   ✅ ' + scored.length + ' خبر — جعل: ' + scored.reduce((a, s) => a + s.forgeryCount, 0)
          + ' مورد — بدون لینک: ' + unverifiedCount(scored) + ' — ' + (ms / 1000).toFixed(1) + 's');
      }
    }
  }

  // ===== Gemini =====
  if (GEMINI_KEY) {
    console.log('\n🔵 اجرای Gemini (gemini-2.5-flash)...');
    const r = await callGeminiAB(prompt, 'gemini-2.5-flash');
    if (!r.ok) {
      console.log('   ❌ ' + r.error);
      out.models.gemini = { ok: false, error: r.error };
    } else {
      const items = bot.safeParseJson(r.text);
      if (!items.length) {
        console.log('   ❌ JSON پارس نشد');
        out.models.gemini = { ok: false, error: 'پارس JSON ناموفق', raw: r.text.substring(0, 500) };
      } else {
        const scored = scoreOutput(items, corpus);
        out.models.gemini = { ok: true, ms: r.ms, itemCount: scored.length, items: scored };
        console.log('   ✅ ' + scored.length + ' خبر — جعل: ' + scored.reduce((a, s) => a + s.forgeryCount, 0)
          + ' مورد — بدون لینک: ' + unverifiedCount(scored) + ' — ' + (r.ms / 1000).toFixed(1) + 's');
      }
    }
  }

  // ===== گزارش مقایسه =====
  const naraScored = (out.models.nara && out.models.nara.items) || [];
  const gemScored = (out.models.gemini && out.models.gemini.items) || [];

  console.log('\n========== مقایسه ==========');
  // نمره فقط روی خروجی‌هایی محاسبه می‌شود که واقعاً با منبع مقایسه شده‌اند؛
  // وگرنه خروجی بدون لینک، نمره‌ی بدون‌مجاز می‌گیرد.
  const naraVerified = naraScored.filter(s => s.verified);
  const gemVerified = gemScored.filter(s => s.verified);

  // ستون‌بندی با padEnd برای متن فارسی (RTL) به‌هم می‌ریزد؛ پس ساده و خط‌به‌خط چاپ می‌شود
  const hasNara = !!(out.models.nara && out.models.nara.ok);
  const hasGem = !!(out.models.gemini && out.models.gemini.ok);
  const nOr = x => (hasNara ? x : '—');
  const gOr = x => (hasGem ? x : '—');
  // دسترسی محافظت‌شده: اگر کلید اصلاً نباشد، out.models.nara تعریف‌نشده می‌ماند
  // و خواندن ms روی آن TypeError می‌دهد.
  const msOf = m => (m && m.ms ? (m.ms / 1000).toFixed(1) : '—');

  const rows = [
    ['تعداد خبر خروجی', nOr(naraScored.length), gOr(gemScored.length)],
    ['قابل مقایسه با منبع', nOr(naraVerified.length), gOr(gemVerified.length)],
    ['میانگین نمره',
      nOr(naraVerified.length ? avg(naraVerified.map(s => s.score)) : '—'),
      gOr(gemVerified.length ? avg(gemVerified.map(s => s.score)) : '—')],
    ['🚩 مورد جعل',
      nOr(naraScored.reduce((a, s) => a + s.forgeryCount, 0)),
      gOr(gemScored.reduce((a, s) => a + s.forgeryCount, 0))],
    ['⚠️ بدون لینک منبع', nOr(unverifiedCount(naraScored)), gOr(unverifiedCount(gemScored))],
    ['زمان (ثانیه)', nOr(msOf(out.models.nara)), gOr(msOf(out.models.gemini))],
  ];
  for (const r of rows) {
    console.log('  ' + r[0] + '\n      NaraRouter: ' + r[1] + '   |   Gemini: ' + r[2]);
  }

  // خروجی چشمی برای مقایسه‌ی انسانی
  console.log('\n—— خروجی NaraRouter ——');
  for (const s of naraScored) {
    console.log('\n' + s.title);
    console.log(s.body);
    if (!s.verified) console.log('  ⛔ بدون لینک منبع — جعل قابل بررسی نیست');
    if (s.forgery.length) console.log('  🚩 جعل: ' + s.forgery.join(' | '));
    if (s.issues.length) console.log('  ⚠️ ' + s.issues.join(' | '));
  }
  console.log('\n—— خروجی Gemini ——');
  for (const s of gemScored) {
    console.log('\n' + s.title);
    console.log(s.body);
    if (!s.verified) console.log('  ⛔ بدون لینک منبع — جعل قابل بررسی نیست');
    if (s.forgery.length) console.log('  🚩 جعل: ' + s.forgery.join(' | '));
    if (s.issues.length) console.log('  ⚠️ ' + s.issues.join(' | '));
  }

  const outFile = path.join(__dirname, 'ab-report.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log('\n💾 گزارش کامل: ' + outFile);
  console.log('   (این گزارش فقط محلی است و commit نمی‌شود)\n');
})();
