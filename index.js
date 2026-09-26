const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ==========================================
// تنظیمات
// ==========================================
const CONFIG_FILE = path.join(__dirname, "config.json");
const STATE_FILE = path.join(__dirname, "state.json");

function loadConfig() {
  const envConfig = {};
  if (process.env.OPENROUTER_API_KEY) envConfig.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (process.env.GROQ_API_KEY) envConfig.GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (process.env.GEMINI_API_KEY) envConfig.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (process.env.NARA_ROUTER_API_KEY) envConfig.NARA_ROUTER_API_KEY = process.env.NARA_ROUTER_API_KEY;
  if (process.env.BOT_TOKEN) envConfig.BOT_TOKEN = process.env.BOT_TOKEN;
  if (process.env.DESTINATION_CHAT_ID) envConfig.DESTINATION_CHAT_ID = process.env.DESTINATION_CHAT_ID;
  if (process.env.SOURCE_CHANNEL_ID) envConfig.SOURCE_CHANNEL_ID = process.env.SOURCE_CHANNEL_ID;
  let fileConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
  return { ...fileConfig, ...envConfig };
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  }
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ==========================================
// جلوگیری از تکرار
// ==========================================
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000; // حافظه نیم ساعته برای جلوگیری از تکرار
const QUALITY_LOG_FILE = path.join(__dirname, 'quality-log.json');
const REVIEW_LOG_FILE = path.join(__dirname, 'review-log.json');

// ==========================================
// سیستم بازخورد و اعتبارسنجی کیفیت
// ==========================================
function validateNewsItem(item, originalText) {
  const issues = [];
  let score = 100;

  // ۱. بررسی تیتر
  if (!item.title || item.title.length < 5) {
    issues.push('تیتر خیلی کوتاه است');
    score -= 20;
  }
  if (item.title && item.title.includes(':') && /^\s*[\u0600-\u06FF]+\s*:/i.test(item.title.replace('✴️', ''))) {
    issues.push('تیتر به صورت نقل قول است');
    score -= 15;
  }
  if (item.title && item.title.length > 60) {
    issues.push('تیتر خیلی بلند است (' + item.title.length + ' کاراکتر)');
    score -= 10;
  }

  // ۲. بررسی نام و سمّت
  if (item.body) {
    const nameMatch = item.body.match(/([\u0600-\u06FF]+\s+[\u0600-\u06FF]+)\s+(عضو|نماینده|رئیس|نایب|سخنگو)/);
    if (!nameMatch) {
      issues.push('نام و سمّت شخص در خط اول متن پیدا نشد');
      score -= 15;
    }
    // بررسی مجلس شورای اسلامی
    if (item.body.includes('مجلس شورای اسلامی')) {
      issues.push(' مجلس شورای اسلامی باید مجلس باشد');
      score -= 5;
    }
  }

  // ۳. بررسی حجم متن
  if (item.body && item.body.length < 80) {
    issues.push('متن خیلی کوتاه است (' + item.body.length + ' کاراکتر)');
    score -= 20;
  }
  if (item.body && item.body.length > 1500) {
    issues.push('متن خیلی بلند است (' + item.body.length + ' کاراکتر)');
    score -= 10;
  }

  // ۴. بررسی عبارات خشک
  if (item.body && /اظهار کرد|وی افزود|خاطرنشان کرد|تصریح کرد/.test(item.body)) {
    issues.push('عبارات خشک خبری استفاده شده');
    score -= 10;
  }

  // ۵. بررسی منبع
  if (item.body && item.body.includes('در مصاحبه با') && !item.body.includes('خبرنگار')) {
    issues.push('منبع مصاحبه بدون نام خبرنگار ذکر شده');
    score -= 5;
  }

  // ۶. بررسی حوزه انتخابیه
  if (item.body && /نماینده مردم [^،]+ در مجلس/.test(item.body)) {
    issues.push('حوزه انتخابیه آورده شده');
    score -= 5;
  }

  // ۷. بررسی «وی»
  if (item.body && /\bوی\b/.test(item.body)) {
    issues.push('کلمه «وی» استفاده شده به جای نام');
    score -= 10;
  }

  return { score: Math.max(0, score), issues };
}

function saveQualityReport(report) {
  let existing = [];
  try {
    if (fs.existsSync(QUALITY_LOG_FILE)) {
      existing = JSON.parse(fs.readFileSync(QUALITY_LOG_FILE, 'utf8'));
    }
  } catch (e) {}
  existing.push(report);
  if (existing.length > 50) existing = existing.slice(-50);
  fs.writeFileSync(QUALITY_LOG_FILE, JSON.stringify(existing, null, 2), 'utf8');
  console.log('📋 گزارش کیفیت ذخیره شد. نمره: ' + report.avgScore + '/100');
}

// ==========================================
// چک‌لیست جامع اشتباهات رایج
// ==========================================
const COMMON_MISTAKES = [
  // اشتباهات نام و سمت
  { pattern: 'رئیس دفتر ریاست جمهوری', fix: 'رئیس دفتر رئیس‌جمهور', category: 'سمت اشتباه', penalty: 20 },
  { pattern: 'وزیر محیط زیست', fix: 'رئیس سازمان محیط زیست', category: 'سمت اشتباه', penalty: 20 },
  { pattern: 'رئیس مجلس شورای اسلامی', fix: 'رئیس مجلس', category: 'سمت اشتباه', penalty: 5 },
  { pattern: 'نایب رئیس مجلس شورای اسلامی', fix: 'نایب رئیس مجلس', category: 'سمت اشتباه', penalty: 5 },
  { pattern: 'عضو کمیسیون مجلس', fix: 'عضو کمیسیون', category: 'سمت اشتباه', penalty: 5 },
  { pattern: 'نماینده مجلس شورای اسلامی', fix: 'نماینده مجلس', category: 'سمت اشتباه', penalty: 5 },
  // اشتباهات رایج در نام افراد (از تجربه قبلی)
  { pattern: 'قالباب', fix: 'قالیباف', category: 'نام غلط', penalty: 30 },
  { pattern: 'نیکزاد ثمرین', fix: 'نیکزاد ثمرین', category: 'نام', penalty: 0 }, // فقط چک کن
  // اشتباهات مصاحبه
  { pattern: 'در مصاحبه با', checkOriginal: true, category: 'مصاحبه اشتباه', penalty: 25 },
  { pattern: 'در گفتگو با', checkOriginal: true, category: 'مصاحبه اشتباه', penalty: 25 },
];

// ==========================================
// دیتابیس ذخیره خبرها در state.json (پایدار)
// ==========================================
function saveNewsToState(state, item, originalText, model) {
  if (!state.NEWS_DATABASE) state.NEWS_DATABASE = [];
  const entry = {
    id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    title: (item.title || '').substring(0, 200),
    body: (item.body || '').substring(0, 500),
    source_link: item.source_link || '',
    model: model || 'unknown',
    qualityScore: 0,
    qualityIssues: [],
    reviewed: false
  };
  state.NEWS_DATABASE.push(entry);
  // نگه‌داشتن فقط ۲۰۰ خبر آخر
  if (state.NEWS_DATABASE.length > 200) {
    state.NEWS_DATABASE = state.NEWS_DATABASE.slice(-200);
  }
  console.log('💾 خبر در دیتابیس ذخیره شد: ' + (item.title || '').substring(0, 50));
}

function trackMistake(state, issueCategory) {
  if (!state.MISTAKE_STATS) state.MISTAKE_STATS = {};
  if (!state.MISTAKE_STATS[issueCategory]) state.MISTAKE_STATS[issueCategory] = 0;
  state.MISTAKE_STATS[issueCategory]++;
}

// ==========================================
// بازبینی خودکار کیفیت بعد از انتشار
// ==========================================
autoReviewPublishedNews = async function(state, newsItems, sourceLinks) {
  console.log('\n🔍 === بازبینی خودکار کیفیت ===');
  const reviewResults = [];
  
  for (let i = 0; i < newsItems.length; i++) {
    const item = newsItems[i];
    const originalText = ''; // متن اصلی قبلاً خوانده شده
    const issues = [];
    let score = 100;
    
    // ۱. بررسی مصاحبه اشتباه
    const hasInterviewClaim = /مصاحبه با|گفتگو با/.test(item.body);
    if (hasInterviewClaim) {
      // اگه مصاحبه ذکر شده ولی در متن اصلی نبوده
      issues.push('⚠️ مصاحبه ذکر شده - نیاز به بررسی دستی');
      score -= 10;
      trackMistake(state, 'مصاحبه اشتباه');
    }
    
    // ۲. بررسی چک‌لیست اشتباهات رایج
    for (const mistake of COMMON_MISTAKES) {
      if (mistake.fix && item.body && item.body.includes(mistake.pattern) && mistake.pattern !== mistake.fix) {
        issues.push('❌ ' + mistake.category + ': «' + mistake.pattern + '» → «' + mistake.fix + '»');
        score -= mistake.penalty;
        trackMistake(state, mistake.category);
      }
    }
    
    // ۳. بررسی نام افراد
    const summaryNames = (item.body || '').match(/([\u0600-\u06FF]+\s+[\u0600-\u06FF]+)\s+(عضو|نماینده|رئیس|نایب|سخنگو)/g) || [];
    if (summaryNames.length === 0 && item.body && item.body.length > 50) {
      issues.push('⚠️ نام و سمّت شخص در خط اول متن پیدا نشد');
      score -= 10;
    }
    
    // ۴. بررسی طول متن
    if (item.body && item.body.length < 100) {
      issues.push('⚠️ متن خیلی کوتاه: ' + item.body.length + ' کاراکتر');
      score -= 15;
      trackMistake(state, 'متن کوتاه');
    }
    
    // ۵. بررسی مجلس شورای اسلامی
    if (item.body && item.body.includes('مجلس شورای اسلامی')) {
      issues.push('⚠️ مجلس شورای اسلامی → مجلس');
      score -= 5;
      trackMistake(state, 'مجلس شورای اسلامی');
    }
    
    // ۶. بررسی حوزه انتخابیه
    if (item.body && /نماینده مردم [^،]+ در مجلس/.test(item.body)) {
      issues.push('⚠️ حوزه انتخابیه آورده شده');
      score -= 5;
      trackMistake(state, 'حوزه انتخابیه');
    }
    
    // ۷. بررسی تیتر کلی/مبهم
    if (item.title) {
      const weakTitlePatterns = ['بررسی', 'نشست', 'بازدید', 'گفتگو', 'مصاحبه'];
      for (const weak of weakTitlePatterns) {
        if (item.title.replace('✴️', '').trim().startsWith(weak)) {
          issues.push('⚠️ تیتر کلی: شروع با «' + weak + '»');
          score -= 10;
          trackMistake(state, 'تیتر کلی');
          break;
        }
      }
    }
    
    // ۸. بررسی «وی» به جای نام
    if (item.body && /\bوی\b/.test(item.body)) {
      issues.push('⚠️ کلمه «وی» استفاده شده به جای نام');
      score -= 10;
      trackMistake(state, 'استفاده از وی');
    }
    
    // ۹. بررسی عبارات خشک
    if (item.body && /اظهار کرد|خاطرنشان کرد|تصریح کرد/.test(item.body)) {
      issues.push('⚠️ عبارات خشک خبری');
      score -= 5;
      trackMistake(state, 'عبارات خشک');
    }
    
    score = Math.max(0, score);
    
    // ذخیره نتیجه در دیتابیس
    if (state.NEWS_DATABASE) {
      for (const entry of state.NEWS_DATABASE) {
        if (entry.source_link === item.source_link && !entry.reviewed) {
          entry.qualityScore = score;
          entry.qualityIssues = issues;
          entry.reviewed = true;
          break;
        }
      }
    }
    
    reviewResults.push({
      title: (item.title || '').substring(0, 60),
      source_link: item.source_link || '',
      score: score,
      issues: issues
    });
    
    console.log('  📊 ' + (item.title || '').substring(0, 40) + ': ' + score + '/100' + (issues.length > 0 ? ' (' + issues.length + ' مشکل)' : ''));
  }
  
  // محاسبه نمره میانگین
  const avgScore = reviewResults.length > 0 
    ? Math.round(reviewResults.reduce((s, r) => s + r.score, 0) / reviewResults.length)
    : 0;
  
  console.log('\n📈 نمره میانگین: ' + avgScore + '/100');
  console.log('📋 تعداد مشکلات: ' + reviewResults.reduce((s, r) => s + r.issues.length, 0));
  
  return { items: reviewResults, avgScore: avgScore };
}

// ==========================================
// گزارش روزانه کیفیت
// ==========================================
function generateDailyReport(state) {
  const db = state.NEWS_DATABASE || [];
  const today = getTehranDateStr();
  // مقایسه تاریخ تهران (نه UTC) با تاریخ ثبت هر خبر
  const todayTehran = getTehranDate();
  const todayStr = todayTehran.getUTCFullYear() + '-' + String(todayTehran.getUTCMonth() + 1).padStart(2, '0') + '-' + String(todayTehran.getUTCDate()).padStart(2, '0');
  const todayEntries = db.filter(e => {
    try {
      return getTehranDateStrFromIso(e.timestamp) === todayStr;
    } catch (err) { return false; }
  });

  if (todayEntries.length === 0) {
    return null;
  }

  const reviewed = todayEntries.filter(e => e.reviewed);
  const withIssues = reviewed.filter(e => e.qualityIssues && e.qualityIssues.length > 0);
  const avgScore = reviewed.length > 0
    ? Math.round(reviewed.reduce((s, e) => s + e.qualityScore, 0) / reviewed.length)
    : 0;

  const report = {
    date: today,
    totalNews: todayEntries.length,
    reviewedCount: reviewed.length,
    withIssuesCount: withIssues.length,
    avgScore: avgScore,
    models: {},
    topIssues: []
  };

  // شمارش مدل‌ها
  for (const e of todayEntries) {
    report.models[e.model] = (report.models[e.model] || 0) + 1;
  }

  // جمع‌آوری مشکلات رایج
  const issueCounts = {};
  for (const e of withIssues) {
    for (const issue of e.qualityIssues) {
      const key = issue.substring(0, 50);
      issueCounts[key] = (issueCounts[key] || 0) + 1;
    }
  }
  report.topIssues = Object.entries(issueCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([issue, count]) => ({ issue, count }));

  // جزئیات پست‌های امروز (برای گزارش خوانا)
  report.posts = todayEntries.map(e => ({
    title: (e.title || '').replace('✴️', '').trim().substring(0, 50),
    model: e.model || 'نامشخص',
    problems: (e.qualityIssues || []).map(i => humanizeIssue(i))
  }));

  // مدل‌های مشکل‌ساز امروز
  const modelStats = {};
  for (const e of todayEntries) {
    const m = e.model || 'نامشخص';
    if (!modelStats[m]) modelStats[m] = { total: 0, bad: 0 };
    modelStats[m].total++;
    if (e.qualityIssues && e.qualityIssues.length > 0) modelStats[m].bad++;
  }
  report.badModels = Object.entries(modelStats)
    .filter(function (s) { return s[1].bad > 0; })
    .map(function (s) { return { model: s[0], bad: s[1].bad, total: s[1].total }; });

  return report;
}

// تبدیل عنوان داخلی مشکل به جمله فارسی قابل‌فهم
function humanizeIssue(issue) {
  const s = String(issue || '');
  const map = [
    ['تیتر کلی', 'تیتر کلی و بی‌ربط بود (مثلاً فقط «بررسی» یا «نشست»)'],
    ['متن خیلی کوتاه', 'متن خلاصه خیلی کوتاه و ناقص بود'],
    ['نام و سمّت شخص', 'نام یا سمت اشخاص به‌درستی نیامده بود'],
    ['مجلس شورای اسلامی', 'به‌جای «مجلس» نوشته شده بود «مجلس شورای اسلامی»'],
    ['حوزه انتخابیه', 'حوزه انتخابیه اضافه نوشته شده بود'],
    ['مصاحبه', 'برای خبرِ غیرمصاحبه‌ای، ادعای مصاحبه/منبع آمده بود'],
    ['عبارات خشک', 'از عبارات خشک خبری (اظهار کرد، تصریح کرد و…) استفاده شده بود'],
    ['استفاده از وی', 'به‌جای نام شخص از کلمه «وی» استفاده شده بود'],
    ['قالباب', 'غلط املایی در نام («قالباب» به‌جای «قالیباف»)']
  ];
  for (const pair of map) {
    if (s.includes(pair[0])) return '▪️ ' + pair[1];
  }
  return '▪️ ' + s;
}

// تاریخ جلالی تهران از یک timestamp ایزو (yyyy-mm-dd تهران)
function getTehranDateStrFromIso(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const tehran = new Date(d.getTime() + (3.5 * 3600000));
  return tehran.getUTCFullYear() + '-' + String(tehran.getUTCMonth() + 1).padStart(2, '0') + '-' + String(tehran.getUTCDate()).padStart(2, '0');
}

function formatDailyReport(report, state) {
  if (!report) return '🔍 گزارش نظارت: امروز خبری منتشر نشد';

  let msg = '🔍 <b>گزارش نظارت بر پست‌های امروز</b>\n';
  msg += '📅 ' + report.date + '\n';
  msg += '━━━━━━━━━━━━━━━━━\n\n';
  msg += '📣 امروز ' + report.totalNews + ' خبر منتشر شد.\n\n';

  // وضعیت هر پست به زبان ساده
  if (report.posts && report.posts.length > 0) {
    let okCount = 0;
    for (const post of report.posts) {
      if (post.problems.length === 0) { okCount++; continue; }
      msg += '⚠️ <b>' + post.title + '</b>\n';
      for (const pr of post.problems) {
        msg += '   ' + pr + '\n';
      }
    }
    msg += '\n✅ ' + okCount + ' پست از ' + report.posts.length + ' پست سالم بود';
    if (okCount === report.posts.length) msg += ' — همه پست‌ها مشکلی ندارند 👌';
    msg += '\n';
  }

  // مدل‌های مشکل‌ساز
  if (report.badModels && report.badModels.length > 0) {
    msg += '\n🤖 <b>مدل‌های مشکل‌ساز امروز:</b>\n';
    for (const bm of report.badModels) {
      msg += '  • ' + bm.model + ': ' + bm.bad + ' پست مشکل‌دار از ' + bm.total + ' پست\n';
    }
  }

  // آمار کلی اشتباهات (حافظه بلندمدت)
  if (state.MISTAKE_STATS && Object.keys(state.MISTAKE_STATS).length > 0) {
    msg += '\n🔄 <b>اشتباهات پرتکرار از ابتدا:</b>\n';
    const sorted = Object.entries(state.MISTAKE_STATS).sort((a, b) => b[1] - a[1]);
    for (const [category, count] of sorted.slice(0, 5)) {
      msg += '  • ' + category + ': ' + count + ' بار\n';
    }
  }

  msg += '\n━━━━━━━━━━━━━━━━━\n';
  msg += '🤖 خبرخوان مجلس | @selectednewsmajlis';

  return msg;
}

// ==========================================
// بازخوانی بعد از انتشار
// ==========================================
async function reviewPublishedNews(chatId, publishedTitles) {
  console.log('🔍 بازخوانی کانال مقصد...');
  try {
    const channelName = chatId.replace('@', '');
    const channelMessages = await fetchTelegramMessages(channelName);
    if (!channelMessages || channelMessages.length === 0) {
      console.log('  ⚠️ پیامی در کانال مقصد پیدا نشد');
      return null;
    }
    console.log('  📨 ' + channelMessages.length + ' پیام در کانال مقصد');

    // پیدا کردن خبرهایی که تازه منتشر شدند
    const recentPublished = [];
    for (const msg of channelMessages.slice(0, 10)) {
      const text = msg.text;
      if (text.includes('ازما') || text.includes('azmaa_net')) {
        recentPublished.push({
          text: text.substring(0, 500),
          hasImage: !!(msg.imageUrl && msg.imageUrl.length > 10),
          imageUrl: msg.imageUrl || ''
        });
      }
    }

    if (recentPublished.length === 0) {
      console.log('  ⚠️ خبری از ما در کانال مقصد پیدا نشد');
      return null;
    }

    console.log('  ✅ ' + recentPublished.length + ' خبر منتشر شده پیدا شد');

    // بررسی کیفیت خبرهای منتشر شده
    const issues = [];
    for (const pub of recentPublished) {
      // بررسی آیا عکس داره
      if (!pub.hasImage) {
        issues.push('خبر بدون عکس: ' + pub.text.substring(0, 40) + '...');
      }
      // بررسی آیا متن انگلیسی داره (لینک‌ها و آیدی‌ها حذف می‌شن چون طبیعتاً لاتین هستن)
      const textWithoutLinks = pub.text
        .replace(/https?:\/\/\S+/g, '')          // لینک‌ها
        .replace(/@[A-Za-z0-9_]+/g, '')           // آیدی‌ها
        .replace(/[\u2190-\u2BFF\u2600-\u27BF\uFE0F\u200F\u200E]/g, '');  // ایموجی و نمادها
      if (/[A-Za-z]{5,}/.test(textWithoutLinks)) {
        issues.push('متن انگلیسی در خبر: ' + pub.text.replace(/https?:\/\/\S+/g, '').substring(0, 40) + '...');
      }
      // بررسی برچسب مدل (هر پست باید برچسب داشته باشه)
      if (!pub.text.includes('🤖 مدل:')) {
        issues.push('بدون برچسب مدل: ' + pub.text.substring(0, 40) + '...');
      }
      // بررسی جعل منبع/مصاحبه (دروغ رایج مدل‌های ضعیف)
      // تیتر نباید حاوی «گفتگو با» یا «مصاحبه با» یا «در خبر ... گفت» باشد
      const titleLine = (pub.text.split('\n')[0] || '');
      if (/گفتگو با|مصاحبه با|در (خبر|سایت|خبرگزاری)\s/.test(titleLine)) {
        issues.push('تیتر آلوده به ذکر منبع/رسانه: ' + titleLine.substring(0, 50));
      }
      // «در خبر ایرنا گفت» / «در تابناک گفت» و مشابه در بدنه — ذکر رسانه بدون مصاحبه واقعی ممنوع
      const mediaAttr1 = pub.text.match(/در (خبر|سایت|پایگاه|روزنامه|خبرگزاری)\s+[^،,\.\n]{2,30}?\s+(گفت|نوشت|تاکید کرد)(?=\s|،|\.|$)/);
      const mediaAttr2 = pub.text.match(/در (ایرنا|خانه ملت|تابناک|دنیای اقتصاد|باشگاه خبرنگاران جوان|سنتی نیوز|یجس|خبر جوان)\s+(گفت|نوشت|تاکید کرد)(?=\s|،|\.|$)/);
      const mediaAttr = mediaAttr1 || mediaAttr2;
      if (mediaAttr) {
        issues.push('ذکر رسانه به‌عنوان منبع نقل‌قول (مشکوک به جعل): «...' + mediaAttr[0].substring(0, 40) + '»');
      }
      // بررسی غلط املایی شناخته‌شده
      for (const mistake of COMMON_MISTAKES) {
        if (mistake.penalty > 0 && mistake.fix && mistake.pattern !== mistake.fix && pub.text.includes(mistake.pattern)) {
          issues.push('غلط املایی/نام: «' + mistake.pattern + '» باید «' + mistake.fix + '» باشد: ' + pub.text.substring(0, 30) + '...');
        }
      }
      // بررسی آیا مجلس شورای اسلامی نوشته
      if (pub.text.includes('مجلس شورای اسلامی')) {
        issues.push('مجلس شورای اسلامی نوشته شده: ' + pub.text.substring(0, 40) + '...');
      }
    }

    return {
      timestamp: new Date().toISOString(),
      totalPublished: recentPublished.length,
      withImage: recentPublished.filter(p => p.hasImage).length,
      withoutImage: recentPublished.filter(p => !p.hasImage).length,
      issues: issues,
      score: Math.max(0, 100 - (issues.length * 15))
    };
  } catch (err) {
    console.log('  ❌ خطا در بازخوانی:', err.message);
    return null;
  }
}

function saveReviewReport(report) {
  if (!report) return;
  let existing = [];
  try {
    if (fs.existsSync(REVIEW_LOG_FILE)) {
      existing = JSON.parse(fs.readFileSync(REVIEW_LOG_FILE, 'utf8'));
    }
  } catch (e) {}
  existing.push(report);
  if (existing.length > 50) existing = existing.slice(-50);
  fs.writeFileSync(REVIEW_LOG_FILE, JSON.stringify(existing, null, 2), 'utf8');
  console.log('📋 گزارش بازخوانی ذخیره شد. نمره: ' + report.score + '/100');
}

async function sendQualityReportToTelegram(qualityReport, reviewReport, newsCount, botToken, chatId) {
  try {
    const time = getTehranTimeStr();
    const date = getTehranDateStr();
    const period = isTehranNight() ? '🌙 شب' : '☀️ روز';
    const interval = isTehranNight() ? 'هر ۱ ساعت' : 'هر ۲ ساعت';

    let report = '📊 <b>گزارش دوره‌ای کیفیت</b>\n';
    report += '🕐 ' + time + ' | 📅 ' + date + ' (' + period + ')\n';
    report += '⏱️ ' + interval + '\n';
    report += '━━━━━━━━━━━━━━━━━\n\n';

    // قبل از انتشار: خلاصه ساده
    if (qualityReport && qualityReport.items && qualityReport.items.length > 0) {
      const badItems = qualityReport.items.filter(i => (i.issues || []).length > 0);
      if (badItems.length === 0) {
        report += '✍️ <b>قبل از انتشار:</b> ' + qualityReport.items.length + ' خبر تولید شد و هر ' + qualityReport.items.length + ' تاش مشکلی نداشت.\n';
      } else {
        report += '✍️ <b>قبل از انتشار:</b> ' + badItems.length + ' خبر از ' + qualityReport.items.length + ' خبر مشکل داشت:\n';
        for (const it of badItems.slice(0, 4)) {
          report += '  • ' + (it.title || '').replace('✴️', '').trim().substring(0, 40) + '\n';
          for (const issue of (it.issues || []).slice(0, 3)) {
            report += '     ' + humanizeIssue(issue) + '\n';
          }
        }
      }
    } else {
      report += '✍️ <b>قبل از انتشار:</b> خبری تولید نشد\n';
    }

    report += '\n';

    // بعد از انتشار: پست‌های واقعی کانال که بازخوانی شدن
    if (reviewReport) {
      report += '📣 <b>بعد از انتشار:</b> ' + reviewReport.totalPublished + ' پست آخر کانال بازخوانی شد\n';
      report += '🖼 عکس‌دار: ' + reviewReport.withImage + ' | بدون عکس: ' + reviewReport.withoutImage + '\n';
      if (reviewReport.issues && reviewReport.issues.length > 0) {
        report += '\n⚠️ <b>مشکلات پست‌های منتشرشده:</b>\n';
        const seen = new Set();
        reviewReport.issues.forEach(issue => {
          const key = issue.substring(0, 30);
          if (seen.has(key)) return;
          seen.add(key);
          report += '  • ' + issue.substring(0, 100) + '\n';
        });
      } else {
        report += '✨ هیچ مشکلی در پست‌های منتشرشده دیده نشد\n';
      }
    }

    report += '\n━━━━━━━━━━━━━━━━━\n';
    report += '🤖 خبرخوان مجلس | @selectednewsmajlis';
    
    // ارسال به تلگرام (به صورت پیام خصوصی به خودمان)
    // از همان چت مقصد استفاده می‌کنیم ولی می‌توانیم چت جداگانه بسازیم
    const payload = JSON.stringify({
      chat_id: chatId,
      text: report,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    
    const response = await httpPost(
      'https://api.telegram.org/bot' + botToken + '/sendMessage',
      payload,
      { 'Content-Type': 'application/json' }
    );
    
    const result = JSON.parse(response);
    if (result.ok) {
      console.log('📊 گزارش کیفیت ارسال شد');
    } else {
      console.log('⚠️ خطا در ارسال گزارش:', result.description);
    }
  } catch (err) {
    console.log('⚠️ خطا در ارسال گزارش:', err.message);
  }
}

// ==========================================
// زمان تهران و مدیریت فاصله گزارش
// ==========================================
function getTehranDate() {
  // تبدیل به ساعت تهران (UTC+3:30)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const tehran = new Date(utc + (3.5 * 3600000));
  return tehran;
}

function getTehranTimeStr() {
  const t = getTehranDate();
  return t.getUTCHours().toString().padStart(2, '0') + ':' + t.getUTCMinutes().toString().padStart(2, '0');
}

function gregorianToJalali(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let gy2 = (gm > 2) ? (gy + 1) : gy;
  let days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1];
  let jy = -1595 + (33 * Math.floor(days / 12053));
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let jm, jd;
  if (days < 186) { jm = 1 + Math.floor(days / 31); jd = 1 + (days % 31); }
  else { jm = 7 + Math.floor((days - 186) / 30); jd = 1 + ((days - 186) % 30); }
  return { jy: jy, jm: jm, jd: jd };
}

const PERSIAN_DAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
const PERSIAN_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

function getTehranDateStr() {
  const t = getTehranDate();
  const j = gregorianToJalali(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  // نکته: getUTCDay برمی‌گرداند ۰=یکشنبه ... ۶=شنبه — هفته فارسی از شنبه شروع می‌شود
  const dayName = PERSIAN_DAYS[(t.getUTCDay() + 1) % 7];
  const monthName = PERSIAN_MONTHS[j.jm - 1];
  return dayName + ' ' + j.jd + ' ' + monthName + ' ' + j.jy;
}

function isTehranNight() {
  // شب: ساعت 20 تا 8 صبح به وقت تهران
  const hour = getTehranDate().getUTCHours();
  return hour >= 20 || hour < 8;
}

function shouldSendReport(state) {
  const lastReportTime = state.LAST_REPORT_TIME || 0;
  const now = Date.now();
  const elapsed = now - lastReportTime;
  
  if (isTehranNight()) {
    // شب: هر 1 ساعت
    const NIGHT_INTERVAL = 60 * 60 * 1000; // 1 ساعت
    return elapsed >= NIGHT_INTERVAL;
  } else {
    // روز: هر 2 ساعت
    const DAY_INTERVAL = 2 * 60 * 60 * 1000; // 2 ساعت
    return elapsed >= DAY_INTERVAL;
  }
}

function cleanOldPublished(publishedNews) {
  const now = Date.now();
  return publishedNews.filter(item => (now - item.timestamp) < DUPLICATE_WINDOW_MS);
}

function extractDomain(url) {
  try {
    const m = url.match(/https?:\/\/([^/]+)/);
    return m ? m[1].replace(/^www\./, '') : '';
  } catch (e) {
    return '';
  }
}

function isDuplicate(newsItem, publishedNews) {
  for (const pub of publishedNews) {
    if (newsItem.source_link && pub.source_link && newsItem.source_link === pub.source_link) return true;
    if (newsItem.source_link && pub.source_link) {
      try {
        const cleanA = newsItem.source_link.split('?')[0].split('#')[0].replace(/\/$/, '');
        const cleanB = pub.source_link.split('?')[0].split('#')[0].replace(/\/$/, '');
        if (cleanA && cleanB && cleanA === cleanB) return true;
      } catch (e) {}
    }
    if (newsItem.title && pub.title) {
      const cleanTitle = (s) => s.replace(/[✴️🔸🔗]/g, '').trim().toLowerCase();
      const wordsA = cleanTitle(newsItem.title).split(/\s+/).filter(w => w.length > 2);
      const wordsB = cleanTitle(pub.title).split(/\s+/).filter(w => w.length > 2);
      if (wordsA.length > 0 && wordsB.length > 0) {
        const common = wordsA.filter(w => wordsB.includes(w)).length;
        const similarity = common / Math.min(wordsA.length, wordsB.length);
        if (similarity > 0.6) return true;
      }
    }
  }
  return false;
}

// ==========================================
// ابزار HTTP
// ==========================================
function httpGet(url, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith("/")) {
          const urlObj = new URL(url);
          redirectUrl = urlObj.origin + redirectUrl;
        }
        return httpGet(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = url.startsWith("https") ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + (urlObj.search || ""),
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
    };
    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpGetBuffer(url, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith("/")) {
          const urlObj = new URL(url);
          redirectUrl = urlObj.origin + redirectUrl;
        }
        return httpGetBuffer(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

function httpPostMultipart(url, boundary, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = url.startsWith("https") ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": body.length,
      },
    };
    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ==========================================
// خواندن پیام‌های تلگرام
// ==========================================
async function fetchTelegramMessages(channelId) {
  const url = "https://t.me/s/" + channelId;
  const response = await httpGet(url);
  const messages = [];
  const blocks = response.split(/<div class="tgme_widget_message\b/);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const textMatch = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    if (textMatch) {
      let htmlText = textMatch[1];
      const text = htmlText.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/gm, " ").trim();
      let newsLink = "";
      const allLinks = htmlText.match(/href="(https?:\/\/[^"]+)"/g);
      if (allLinks) {
        for (const linkTag of allLinks) {
          const href = linkTag.match(/href="([^"]+)"/)[1];
          if (!href.includes("t.me") && href.includes("http")) {
            newsLink = href.replace(/&amp;/g, "&");
            break;
          }
        }
      }
      const bgMatch = block.match(/background-image:url\(['"]?([^'")\s]+)['"]?\)/);
      let imgUrl = bgMatch ? bgMatch[1].replace(/&amp;/g, "&") : "";
      if (!imgUrl) {
        const allImgTags = block.match(/<img[^>]+src="([^"]+)"/g);
        if (allImgTags) {
          for (const tag of allImgTags) {
            const srcMatch = tag.match(/src="([^"]+)"/);
            if (srcMatch && !srcMatch[1].includes("user_photo") && srcMatch[1].includes("cdn")) {
              imgUrl = srcMatch[1].replace(/&amp;/g, "&");
              break;
            }
          }
        }
      }
      if (text.length > 10) {
        messages.push({ text, imageUrl: imgUrl || "", newsLink });
      }
    }
  }
  return messages;
}

// ==========================================
// RSS
// ==========================================
const RSS_FEEDS = [
  { name: 'ICANA', url: 'https://www.icana.ir/rss' },
  { name: 'IRNA', url: 'https://www.irna.ir/rss' },
  { name: 'ISNA', url: 'https://www.isna.ir/rss' },
  { name: 'Mehr', url: 'https://www.mehrnews.com/rss' },
  { name: 'Khabaronline', url: 'https://www.khabaronline.ir/rss' },
  { name: 'Mashregh', url: 'https://www.mashreghnews.ir/rss' },
  { name: 'IMNA', url: 'https://www.imna.ir/rss' },
  { name: 'Shana', url: 'https://www.shana.ir/rss' },
  { name: 'Ettelaat', url: 'https://www.ettelaat.com/rss' },
  { name: 'Hamshahri', url: 'https://www.hamshahrionline.ir/rss' },
];

const PARLIAMENT_KEYWORDS = ['مجلس', 'نماینده', 'کمیسیون', 'شورای نگهبان', 'طرح', 'قانون', 'بودجه', 'فراکسیون', 'استیضاح'];

async function fetchRSSNews() {
  const allNews = [];
  for (const feed of RSS_FEEDS) {
    try {
      const xml = await httpGet(feed.url);
      const items = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];
      for (const item of items) {
        const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
        const descMatch = item.match(/<description>([\s\S]*?)<\/description>/i);
        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/i);
        if (titleMatch && linkMatch) {
          const title = titleMatch[1].trim();
          const description = descMatch ? descMatch[1].trim() : '';
          const link = linkMatch[1].trim();
          const fullText = title + ' ' + description;
          const isRelevant = PARLIAMENT_KEYWORDS.some(kw => fullText.includes(kw));
          if (isRelevant && description.length > 50) {
            allNews.push({
              title,
              description: description.replace(/<[^>]*>/gm, ' ').replace(/\s+/g, ' ').trim(),
              link,
              source: feed.name
            });
          }
        }
      }
    } catch (e) {
      console.log('  ⚠️ خطا در خواندن RSS ' + feed.name + ': ' + e.message);
    }
  }
  return allNews;
}

// ==========================================
// استخراج عکس اصلی
// ==========================================
async function fetchOgImage(url) {
  try {
    // اول با Node.js تلاش کن
    let html = await httpGet(url);
    let img = extractOgImage(html);
    if (img) return img;
    
    // اگر پیدا نشد، با curl تلاش کن (سایت‌هایی که Node.js رو بلاک می‌کنند)
    const curlHtml = fetchHtmlWithCurl(url);
    if (curlHtml) {
      img = extractOgImage(curlHtml);
      if (img) return img;
    }
    return null;
  } catch (err) {
    return null;
  }
}

function extractOgImage(html) {
  if (!html) return null;
  // روش ۱: og:image
  let m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  if (m) return fixUrl(m[1]);
  // روش ۱ب: content قبل از property
  m = html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
  if (m) return fixUrl(m[1]);
  // روش ۲: twitter:image
  m = html.match(/<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"/i);
  if (m) return fixUrl(m[1]);
  // روش ۳: twitter:image:src
  m = html.match(/<meta[^>]+name="twitter:image:src"[^>]+content="([^"]+)"/i);
  if (m) return fixUrl(m[1]);
  // روش ۴: schema.org image
  m = html.match(/"image"\s*:\s*"([^"]+)"/i);
  if (m && m[1].startsWith('http')) return fixUrl(m[1]);
  // روش ۵: هر meta tag که محتوای jpg/png/jpeg/webp داره
  m = html.match(/<meta[^>]+content="([^"]+\.(jpg|jpeg|png|webp)[^"]*)"/i);
  if (m) return fixUrl(m[1]);
  // روش ۶: لینک canonical با تصویر
  m = html.match(/<link[^>]+rel="image_src"[^>]+href="([^"]+)"/i);
  if (m) return fixUrl(m[1]);
  // روش ۷: اولین عکس بزرگ در article
  m = html.match(/<article[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i);
  if (m && m[1].length > 20) return fixUrl(m[1]);
  return null;
}

function fixUrl(url) {
  if (!url) return null;
  url = url.replace(/&amp;/g, '&').trim();
  // اگر نسبی باشد
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    try {
      const u = new URL(url, 'https://www.icana.ir');
      return u.href;
    } catch (e) {}
  }
  return url;
}

// ==========================================
// خواندن متن کامل خبر
// ==========================================
// استخراج متن از HTML
function extractTextFromHtml(html) {
  // روش ۰: JSON-LD
  const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatches) {
    for (const match of jsonLdMatches) {
      const content = match.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
      try {
        const data = JSON.parse(content);
        if (data.articleBody && data.articleBody.length > 50) {
          return data.articleBody.trim();
        }
      } catch (e) {}
    }
  }
  // روش ۱: articleBody
  let m = html.match(/itemprop=["']articleBody["'][^>]*>([\s\S]*?)(?:<\/div>|<\/section>)/i);
  if (m) {
    const text = m[1].replace(/<[^>]*>/gm, " ").replace(/\s+/g, " ").trim();
    if (text.length > 50) return text;
  }
  m = html.match(/itemprop=["']articleBody["'][^>]*>([\s\S]{50,2000}?)(?:<div|<footer|<aside|<section)/i);
  if (m) {
    const text = m[1].replace(/<[^>]*>/gm, " ").replace(/\s+/g, " ").trim();
    if (text.length > 50) return text;
  }
  // روش ۲: تگ article
  m = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (m) {
    const text = m[1].replace(/<[^>]*>/gm, " ").replace(/\s+/g, " ").trim();
    if (text.length > 50) return text;
  }
  // روش ۳: class های رایج
  const contentPatterns = [
    /class=["'][^"]*news[_-]?content[^"]*["'][^>]*>([\s\S]*?)<\/div>/i,
    /class=["'][^"]*story[^"]*["'][^>]*>([\s\S]*?)<\/div>/i,
    /class=["'][^"]*article[_-]?body[^"]*["'][^>]*>([\s\S]*?)<\/div>/i,
    /class=["'][^"]*body[^"]*["'][^>]*>([\s\S]*?)<\/div>/i,
    /class=["'][^"]*text[^"]*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const pat of contentPatterns) {
    m = html.match(pat);
    if (m) {
      const text = m[1].replace(/<[^>]*>/gm, " ").replace(/\s+/g, " ").trim();
      if (text.length > 100) return text;
    }
  }
  // روش ۴: meta description
  m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (m) return m[1].trim();
  return null;
}

// خواندن HTML با curl (برای سایت‌هایی که با Node.js timeout می‌دهند)
function fetchHtmlWithCurl(url) {
  try {
    const result = execSync('curl -s -L --max-time 15 "' + url.replace(/"/g, '\\"') + '"', { 
      encoding: 'utf8', 
      maxBuffer: 5 * 1024 * 1024,
      timeout: 20000
    });
    return result;
  } catch (e) {
    return null;
  }
}

async function fetchArticleText(url) {
  try {
    // اول با Node.js تلاش کن
    const html = await httpGet(url);
    if (html && html.length > 1000) {
      const text = extractTextFromHtml(html);
      if (text && text.length > 100) return text;
    }
    
    // اگر متن کافی نبود، با curl تلاش کن
    console.log("    🔄 تلاش با curl...");
    const curlHtml = fetchHtmlWithCurl(url);
    if (curlHtml && curlHtml.length > 1000) {
      const text = extractTextFromHtml(curlHtml);
      if (text && text.length > 100) return text;
    }
    
    return null;
  } catch (err) {
    // اگر Node.js خطا داد، با curl تلاش کن
    try {
      const curlHtml = fetchHtmlWithCurl(url);
      if (curlHtml && curlHtml.length > 1000) {
        const text = extractTextFromHtml(curlHtml);
        if (text && text.length > 100) return text;
      }
    } catch (e2) {}
    return null;
  }
}

// ==========================================
// NaraRouter API (پشتیبان رایگان)
// ==========================================
async function callNaraRouter(prompt) {
  const NARA_KEY = process.env.NARA_ROUTER_API_KEY || '';
  if (!NARA_KEY) { console.log('  ⚠️ NARA_ROUTER_API_KEY تنظیم نشده'); return null; }
  const url = 'https://router.bynara.id/v1/chat/completions';
  const systemMsg = 'شما یک سردبیر حرفه‌ای خبر تلگرام هستید. فقط JSON خروجی بدهید.' + '\n' +
    'قانون ۱: فقط JSON خام. هیچ متن دیگری.' + '\n' +
    'قانون ۲: تیتر باید خبر اصلی را کوتاه و گویا بگوید. حداکثر ۸ کلمه.' + '\n' +
    'قانون ۳: تیتر نباید فقط «بررسی» یا «نشست» یا «بازدید» باشد. باید نتیجه یا تصمیم اصلی را بگوید.' + '\n' +
    'قانون ۴: تیتر نباید اسم شخص داشته باشد.' + '\n' +
    'قانون ۵: اگر خبر مربوط به کمیسیون است، اسم دقیق کمیسیون را در تیتر بنویسید (مثلاً «کمیسیون صنایع و معادن» نه فقط «کمیسیون»).' + '\n' +
    'قانون ۶: متن با 🔸 شروع شود. خط اول: نام شخص + سمتش + فعل.' + '\n' +
    'قانون ۷: مجلس شورای اسلامی = مجلس' + '\n' +
    'قانون ۸: فقط فارسی بنویسید.' + '\n' +
    'قانون ۹: فقط از فعل «گفت» استفاده کنید. اظهار داشت، خاطرنشان کرد، تصریح کرد ممنوع!' + '\n' +
    'قانون ۱۰: تیتر حداکثر ۸ کلمه باشد.' + '\n\n' +
    'نمونه تیتر خوب: ✴️ تشکر نایب‌رئیس مجلس از تلاش نیروهای مرزی کرمانشاه' + '\n' +
    'نمونه تیتر خوب: ✴️ تصویب طرح پتروشیمی اردبیل در کمیسیون صنایع و معادن' + '\n' +
    'نمونه تیتر خوب: ✴️ بنزین گران نخواهد شد' + '\n' +
    'نمونه تیتر خوب: ✴️ پیشنهاد انحلال ۹۵ شورا' + '\n' +
    'نمونه تیتر بد: ❌ بررسی طرح مقابله با نفوذ' + '\n' +
    'نمونه تیتر بد: ❌ نشست کمیسیون امنیت ملی' + '\n\n' +
    'فرمت: {"news":[{"title":"✴️ تیتر","body":"🔸 جمله اول.\n\n🔸 جمله دوم.","source_link":"لینک","image_url":"لینک یا خالی"]}';
  // فقط agnes-2.5-flash روی NaraRouter فعال است (tencent-hy3-free وجود ندارد)
  const models = ['agnes-2.5-flash'];
  for (const model of models) {
    console.log('  🟣 تلاش با NaraRouter: ' + model);
    const payload = JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 4000,
    });
    try {
      const response = await Promise.race([
        httpPost(url, payload, { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + NARA_KEY }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000))
      ]);
      const data = JSON.parse(response);
      if (data.error) {
        console.log('  ⚠️ خطا از NaraRouter ' + model + ': ' + (data.error.message || '').substring(0, 80));
        continue;
      }
      const content = data.choices[0].message.content;
      if (!content || content.trim().length === 0) { console.log('  ⚠️ پاسخ خالی از NaraRouter'); continue; }
      console.log('  ✅ مدل NaraRouter ' + model + ' پاسخ داد');
      return content;
    } catch (e) {
      console.log('  ⚠️ خطا از NaraRouter: ' + e.message);
    }
  }
  return null;
}

// ==========================================
// Groq API
// ==========================================
async function callGroq(prompt) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
  if (!GROQ_API_KEY) { console.log('  ⚠️ GROQ_API_KEY تنظیم نشده'); return null; }
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const systemMsg = 'شما یک سردبیر حرفه‌ای خبر تلگرام هستید. فقط JSON خروجی بدهید.' + '\n' +
    'قانون ۱: فقط JSON خام. هیچ متن دیگری.' + '\n' +
    'قانون ۲: تیتر باید خبر اصلی را کوتاه و گویا بگوید. حداکثر ۸ کلمه.' + '\n' +
    'قانون ۳: تیتر نباید فقط «بررسی» یا «نشست» یا «بازدید» باشد. باید نتیجه یا تصمیم اصلی را بگوید.' + '\n' +
    'قانون ۴: تیتر نباید اسم شخص داشته باشد.' + '\n' +
    'قانون ۵: اگر خبر مربوط به کمیسیون است، اسم دقیق کمیسیون را در تیتر بنویسید (مثلاً «کمیسیون صنایع و معادن» نه فقط «کمیسیون»).' + '\n' +
    'قانون ۶: متن با 🔸 شروع شود. خط اول: نام شخص + سمتش + فعل.' + '\n' +
    'قانون ۷: مجلس شورای اسلامی = مجلس' + '\n' +
    'قانون ۸: فقط فارسی بنویسید.' + '\n' +
    'قانون ۹: فقط از فعل «گفت» استفاده کنید. اظهار داشت، خاطرنشان کرد، تصریح کرد ممنوع!' + '\n' +
    'قانون ۱۰: تیتر حداکثر ۸ کلمه باشد.' + '\n\n' +
    'نمونه تیتر خوب: ✴️ تشکر نایب‌رئیس مجلس از تلاش نیروهای مرزی کرمانشاه' + '\n' +
    'نمونه تیتر خوب: ✴️ تصویب طرح پتروشیمی اردبیل در کمیسیون صنایع و معادن' + '\n' +
    'نمونه تیتر خوب: ✴️ بنزین گران نخواهد شد' + '\n' +
    'نمونه تیتر خوب: ✴️ پیشنهاد انحلال ۹۵ شورا' + '\n' +
    'نمونه تیتر بد: ❌ بررسی طرح مقابله با نفوذ' + '\n' +
    'نمونه تیتر بد: ❌ نشست کمیسیون امنیت ملی' + '\n\n' +
    'فرمت: {"news":[{"title":"✴️ تیتر","body":"🔸 جمله اول.\n\n🔸 جمله دوم.","source_link":"لینک","image_url":"لینک یا خالی"]}';
  const models = [
    'openai/gpt-oss-120b',  // بهترین مدل رایگان Groq
    'openai/gpt-oss-20b',    // مدل کوچکتر ولی سریع‌تر
  ];
  for (const model of models) {
    console.log('  🟡 تلاش با Groq: ' + model);
    const payload = JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 4000,
    });
    try {
      const response = await Promise.race([
        httpPost(url, payload, { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_API_KEY }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 30000))
      ]);
      const data = JSON.parse(response);
      if (data.error) {
        const errMsg = (data.error.message || '').substring(0, 100);
        console.log('  ⚠️ خطا از Groq ' + model + ': ' + errMsg);
        // اگه model_not_found بود، از مدل بعدی رد شو
        if (data.error.code === 'model_not_found' || errMsg.includes('does not exist')) {
          continue;
        }
        // اگه rate limit بود، بقیه مدل‌ها رو رد کن (همگی سهمیه مشترک دارن)
        if (data.error.code === 'rate_limit_exceeded' || errMsg.includes('Rate limit') || data.error.code === 429) {
          console.log('  ⛔ Groq Rate Limit! بقیه مدل‌ها رو رد کن.');
          return null;
        }
        continue;
      }
      const content = data.choices[0].message.content;
      if (!content || content.trim().length === 0) { console.log('  ⚠️ پاسخ خالی از Groq'); continue; }
      console.log('  ✅ مدل Groq ' + model + ' پاسخ داد');
      return content;
    } catch (e) {
      console.log('  ⚠️ خطا از Groq: ' + e.message);
    }
  }
  return null;
}

// ==========================================
// OpenRouter API
// ==========================================
const AI_MODELS = [
  // اولویت اول: Qwen3.8 (کیفیت بالا، فارسی خوب)
  'qwen/qwen3.8-27b:free',
  // اولویت دوم: Nemotron Ultra (اگر Qwen خطا داد)
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  // اولویت سوم: Z.ai GLM 5.2
  'z-ai/glm-5.2:free',
];


// ==========================================
// فراخوانی Gemini (اولویت اول)
// ==========================================
async function callGemini(prompt, apiKey) {
  if (!apiKey) return null;
  
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey;
  const systemMsg = "You are a senior Persian-language news editor. You write concise Telegram news items. CRITICAL RULES: 1) ONLY output raw JSON. ZERO text before or after. 2) NEVER write analysis, thinking, or reasoning. 3) Copy names EXACTLY from source. 4) Use مجلس not مجلس شورای اسلامی. 5) Start titles with ✴, body paragraphs with 🔸. 6) Body should be 1-2 short paragraphs. 7) Titles MUST be event-focused, NOT quote-style. NEVER start title with a person name followed by colon. 8) Avoid sensational comparisons in titles. Just output { \"news\": [...] }";
  
  const payload = JSON.stringify({
    contents: [
      { role: "user", parts: [{ text: systemMsg + "\n\n" + prompt }] }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 16000,
      responseMimeType: "application/json"
    }
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await Promise.race([
        httpPost(url, payload, { "Content-Type": "application/json" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 120000))
      ]);
      const data = JSON.parse(response);
      if (data.error) {
        console.log("  ⚠️ خطا از Gemini: " + (data.error.message || JSON.stringify(data.error)));
        return null;
      }
      const content = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      if (!content || content.trim().length === 0) {
        console.log("  ⚠️ پاسخ خالی از Gemini");
        return null;
      }
      console.log("  ✅ مدل Gemini پاسخ داد");
      return content;
    } catch (e) {
      console.log("  ⚠️ خطا Gemini: " + e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
    }
  }
  return null;
}

// ==========================================
// فراخوانی Gemini از طریق Proxy (Apps Script)
// ==========================================
async function callGeminiProxy(prompt, proxyUrl) {
  if (!proxyUrl) return null;
  
  console.log("  🔗 فراخوانی Gemini Proxy...");
  const payload = JSON.stringify({
    prompt: prompt,
    model: "gemini-2.5-flash"
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await Promise.race([
        httpPost(proxyUrl, payload, { "Content-Type": "application/json" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 120000))
      ]);
      const data = JSON.parse(response);
      if (data.error) {
        console.log("  ⚠️ خطا از Gemini Proxy: " + (data.error || JSON.stringify(data)));
        return null;
      }
      if (data.content) {
        console.log("  ✅ Gemini Proxy پاسخ داد");
        return data.content;
      }
      console.log("  ⚠️ پاسخ غیرمنتظره از Proxy:", response.substring(0, 200));
      return null;
    } catch (e) {
      console.log("  ⚠️ خطا Gemini Proxy: " + e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
    }
  }
  return null;
}

async function callFallbackModels(prompt) {
  // مدل‌های رایگان OpenRouter
  // توجه: سهمیه ۵۰ درخواست در روز بین همه مدل‌ها مشترکه
  const fallbackModels = [
    'qwen/qwen3.8-27b:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'z-ai/glm-5.2:free',
    'google/gemma-4-31b-it:free',
  ];
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const systemMsg = 'شما یک سردبیر حرفه‌ای خبر تلگرام هستید. فقط JSON خروجی بدهید.' + '\n' +
    'قانون ۱: فقط JSON خام. هیچ متن دیگری.' + '\n' +
    'قانون ۲: تیتر باید خبر اصلی را کوتاه و گویا بگوید. حداکثر ۸ کلمه.' + '\n' +
    'قانون ۳: تیتر نباید فقط «بررسی» یا «نشست» یا «بازدید» باشد. باید نتیجه یا تصمیم اصلی را بگوید.' + '\n' +
    'قانون ۴: تیتر نباید اسم شخص داشته باشد.' + '\n' +
    'قانون ۵: متن با 🔸 شروع شود. خط اول: نام شخص + سمتش + فعل.' + '\n' +
    'قانون ۶: مجلس شورای اسلامی = مجلس' + '\n' +
    'قانون ۷: فقط فارسی بنویسید.' + '\n' +
    'قانون ۸: فقط از فعل «گفت» استفاده کنید. اظهار داشت، خاطرنشان کرد، تصریح کرد ممنوع!' + '\n' +
    'قانون ۹: تیتر حداکثر ۸ کلمه باشد. بلندتر ننویسید.' + '\n\n' +
    'نمونه تیتر خوب: ✴️ پر کردن خلأ قانونی نفوذ در دستور کار مجلس' + '\n' +
    'نمونه تیتر خوب: ✴️ بنزین گران نخواهد شد' + '\n' +
    'نمونه تیتر خوب: ✴️ پیشنهاد انحلال ۹۵ شورا' + '\n' +
    'نمونه تیتر بد: ❌ بررسی طرح مقابله با نفوذ' + '\n' +
    'نمونه تیتر بد: ❌ نشست کمیسیون امنیت ملی' + '\n\n' +
    'فرمت: {\"news\":[{\"title\":\"✴️ تیتر\",\"body\":\"🔸 جمله اول.\\n\\n🔸 جمله دوم.\",\"source_link\":\"لینک\",\"image_url\":\"لینک یا خالی\"}]}';

  for (const model of fallbackModels) {
    console.log('  🟢 تلاش با مدل جایگزین: ' + model);
    const payload = JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 16000,
      response_format: { type: 'json_object' },
    });

    try {
      const response = await Promise.race([
        httpPost(url, payload, {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (process.env.OPENROUTER_API_KEY || ''),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000))
      ]);
      const data = JSON.parse(response);
      if (data.error) {
        console.log('  ⚠️ خطا از ' + model + ': ' + (data.error.message || '').substring(0, 80));
        continue;
      }
      const content = data.choices[0].message.content;
      if (!content || content.trim().length === 0) {
        console.log('  ⚠️ پاسخ خالی از ' + model);
        continue;
      }
      console.log('  ✅ مدل ' + model + ' پاسخ داد');
      return content;
    } catch (e) {
      console.log('  ⚠️ خطا از ' + model + ': ' + e.message);
    }
  }
  return null;
}

async function callOpenRouter(prompt, apiKey) {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const systemMsg = 'شما یک سردبیر حرفه‌ای خبر تلگرام هستید. فقط JSON خروجی بدهید.' + '\n' +
    'قانون ۱: فقط JSON خام. هیچ متن دیگری.' + '\n' +
    'قانون ۲: تیتر باید خبر اصلی را کوتاه و گویا بگوید. حداکثر ۸ کلمه.' + '\n' +
    'قانون ۳: تیتر نباید فقط «بررسی» یا «نشست» یا «بازدید» باشد. باید نتیجه یا تصمیم اصلی را بگوید.' + '\n' +
    'قانون ۴: تیتر نباید اسم شخص داشته باشد.' + '\n' +
    'قانون ۵: اگر خبر مربوط به کمیسیون است، اسم دقیق کمیسیون را در تیتر بنویسید (مثلاً «کمیسیون صنایع و معادن» نه فقط «کمیسیون»).' + '\n' +
    'قانون ۶: متن با 🔸 شروع شود. خط اول: نام شخص + سمتش + فعل.' + '\n' +
    'قانون ۷: مجلس شورای اسلامی = مجلس' + '\n' +
    'قانون ۸: فقط فارسی بنویسید.' + '\n' +
    'قانون ۹: فقط از فعل «گفت» استفاده کنید. اظهار داشت، خاطرنشان کرد، تصریح کرد ممنوع!' + '\n' +
    'قانون ۱۰: تیتر حداکثر ۸ کلمه باشد.' + '\n\n' +
    'نمونه تیتر خوب: ✴️ تشکر نایب‌رئیس مجلس از تلاش نیروهای مرزی کرمانشاه' + '\n' +
    'نمونه تیتر خوب: ✴️ تصویب طرح پتروشیمی اردبیل در کمیسیون صنایع و معادن' + '\n' +
    'نمونه تیتر خوب: ✴️ بنزین گران نخواهد شد' + '\n' +
    'نمونه تیتر خوب: ✴️ پیشنهاد انحلال ۹۵ شورا' + '\n' +
    'نمونه تیتر بد: ❌ بررسی طرح مقابله با نفوذ' + '\n' +
    'نمونه تیتر بد: ❌ نشست کمیسیون امنیت ملی' + '\n\n' +
    'فرمت: {"news":[{"title":"✴️ تیتر","body":"🔸 جمله اول.\n\n🔸 جمله دوم.","source_link":"لینک","image_url":"لینک یا خالی"]}';

  for (let modelIndex = 0; modelIndex < AI_MODELS.length; modelIndex++) {
    const model = AI_MODELS[modelIndex];
    console.log("  🤖 تلاش با مدل: " + model);
    const payload = JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 16000,
      response_format: { type: "json_object" },
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await Promise.race([
          httpPost(url, payload, {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000))
        ]);
        const data = JSON.parse(response);
        if (data.error) {
          const errMsg = data.error.message || JSON.stringify(data.error);
          console.log("  ⚠️ خطا از " + model + ": " + errMsg);
          // اگه خطای Rate Limit باشه، بقیه مدل‌ها رو هم امتحان نکن (همگی سهمیه مشترک دارن)
          if (errMsg.includes("Rate limit") || errMsg.includes("rate_limit") || data.error.code === 429) {
            console.log("  ⛔ Rate Limit! بقیه مدل‌ها رو رد کن.");
            return { status: 'rate_limited' };
          }
          // اگه خطای overloaded باشه، فقط برای این مدل broken هست
          if (errMsg.includes("overloaded") || errMsg.includes("Service temporarily") || errMsg.includes("503")) {
            console.log("  🔄 مدل overloaded - از مدل بعدی امتحان کن.");
            break; // فقط break کن، برو مدل بعدی
          }
          break;
        }
        const content = data.choices[0].message.content;
        if (!content || content.trim().length === 0) {
          console.log("  ⚠️ پاسخ خالی از " + model);
          break;
        }
        console.log("  ✅ مدل " + model + " پاسخ داد");
        return { status: 'success', content: content, model: model };
      } catch (e) {
        console.log("  ⚠️ خطا: " + e.message);
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  console.log("  ❌ همه مدل‌های OpenRouter ناموفق بودند.");
  return { status: 'all_failed' };
}

// ==========================================
// پرامپت
// ==========================================
function buildPrompt(recentMessages, recentTitlesPrompt) {
  let p = [];

  p.push("شما سردبیر اخبار تلگرامی هستید. اخبار خام زیر را به خلاصه‌های حرفه‌ای تبدیل کنید.");
  p.push("");
  p.push("=== قوانین کلی ===");
  p.push("- مجلس شورای اسلامی → فقط مجلس");
  p.push("- نام افراد را عیناً از متن کپی کنید. هرگز حدس نزنید.");
  p.push("- سمّت افراد را دقیقاً از متن استخراج کنید");
  p.push("");
  p.push("=== اهمیت اخبار ===");
  p.push("اخبار مهم: تکذیب، موضع‌گیری مقامات ارشد، تصمیمات کلیدی کمیسیون‌ها، انتقاد/حمایت از دولت، استیضاح، بودجه.");
  p.push("اخبار مهم را حتماً منتشر کنید.");
  p.push("");
  p.push("=== قوانین تیتر (خیلی مهم) ===");
  p.push("- حداکثر ۸ کلمه، رویدادمحور، با ✴️ شروع شود");
  p.push("- تیتر باید مفهوم مشخص و خاص خبر را برساند، نه کلی و مبهم");
  p.push("- هرگز نام شخص در تیتر نیاید!");
  p.push("- هرگز تیتر را به صورت نقل قول ننویسید!");
  p.push("- تیتر باید مثل تیتر روزنامه باشد: کوتاه، جذاب، گویا");
  p.push("- از مقایسه‌های نامتعارف و حساسیت‌برانگیز خودداری کنید");
  p.push("- تیتر باید حرفه‌ای و خبری باشد، نه جنجالی یا توهین‌آمیز");
  p.push("- از کلمات کلی و مبهم مثل «بررسی»، «نشست»، «بازدید» خودداری کنید");
  p.push("- تیتر باید جمله یا عبارت کامل باشد، نه فقط یک موضوع");
  p.push("- اگر خبر مربوط به کمیسیون است، اسم دقیق کمیسیون را در تیتر بنویسید (مثلاً «کمیسیون صنایع و معادن» نه فقط «کمیسیون»)");
  p.push("");
  p.push("تیتر درست: ✴️ تشکر نایب‌رئیس مجلس از تلاش نیروهای مرزی کرمانشاه");
  p.push("تیتر درست: ✴️ تصویب طرح پتروشیمی اردبیل در کمیسیون صنایع و معادن");
  p.push("تیتر درست: ✴️ بنزین گران نخواهد شد");
  p.push("تیتر درست: ✴️ پیشنهاد انحلال ۹۵ شورا");
  p.push("تیتر درست: ✴️ پایان جنگ علیه لبنان ضروری است");
  p.push("تیتر درست: ✴️ در آستانه توافق");
  p.push("تیتر درست: ✴️ فضاسازی ترامپ نباید محاسبات کشور را تحت تأثیر قرار دهد");
  p.push("تیتر درست: ✴️ تأکید دیوان محاسبات بر ساماندهی شوراهای عالی");
  p.push("تیتر درست: ✴️ پیشنهاد انحلال یا ادغام ۹۵ شورا");
  p.push("تیتر درست: ✴️ افتتاح ۲۰ پروژه عمرانی در صیدون");
  p.push("تیتر غلط: ❌ بررسی طرح مقابله با نفوذ");
  p.push("تیتر غلط: ❌ نشست کمیسیون امنیت ملی");
  p.push("تیتر غلط: ❌ عراقچی: پایان جنگ علیه لبنان ضروری است");
  p.push("تیتر غلط: ❌ نیکزاد گفت: بنزین گران نمی‌شود");
  p.push("تیتر غلط: ❌ مقایسه پوشک با خون رهبر");
  p.push("تیتر غلط: ❌ انحلال یا ادغام ۹۵ نهاد شورایی توسط دیوان محاسبات (مبهم و کلی)");
  p.push("");
  p.push("=== قوانین متن (خیلی مهم) ===");
  p.push("- ۱ یا ۲ بند کوتاه (بستگی به محتوا دارد)");
  p.push("- هر بند با 🔸 و یک فاصله شروع شود");
  p.push("- خط اول متن: نام + سمّت دقیق + سپس فعل (گفت/نوشت/تاکید کرد) + محتوا");
  p.push("- نام و سمّت باید در همان خط اول پاراگراف اول بیاید، نه پاراگراف جداگانه");
  p.push("- حوزه انتخابیه نیاید (فقط «نماینده مجلس»)");
  p.push("- سمّت تکرار نشود (عضو کمیسیون X مجلس → عضو کمیسیون X)");
  p.push("- نکته اصلی خبر را با جزئیات بیان کنید (اعداد، شروط، ارقام مهم)");
  p.push("- حداکثر طول هر پاراگراف متن: ۲ جمله کوتاه");
  p.push("");
  p.push("متن درست:");
  p.push("🔸 فداحسین مالکی عضو کمیسیون امنیت ملی مجلس در مصاحبه با خبرگزاری دانشجو گفت ایران و عمان بر مسیر پیشنهادی ایران تمرکز کرده‌اند.");
  p.push("");
  p.push("متن غلط:");
  p.push("🔸 فداحسین مالکی عضو کمیسیون امنیت ملی مجلس");
  p.push("🔸 در دیدار با نائب رئیس مجلس...");  
  p.push("");
  p.push("=== قوانین ذکر منبع (خیلی مهم) ===");
  p.push("- فقط وقتی منبع ذکر کنید که متن اصلی صریحاً نوشته «در گفتگو با خبرنگار X» یا «در مصاحبه با خبرگزاری X»");
  p.push("- اگر رسانه فقط خبر را گزارش کرده (بازدید، نشست، افتتاح، گزارش) بدون مصاحبه صریح → اصلاً اسم رسانه نیاورید");
  p.push("- مطلقاً ساختگی ننویسید! هرگز عباراتی مثل «در خبر ایرنا گفت»، «در تابناک گفت»، «در سایت سنتی نیوز گفت» نسازید — این‌ها دروغ محض هستند");
  p.push("- خانه ملت (ICANA) همیشه اختصاصی نیست! فقط وقتی منبع بیاورید که نوشته «گفتگو با خبرنگار خانه ملت»");
  p.push("- تشخیص: اگر متن شامل «گزارش»، «بازدید»، «نشست»، «افتتاح» باشد بدون کلمه «مصاحبه» یا «گفتگو» → منبع نیاورید");
  p.push("");
  p.push("=== جلوگیری از تکرار ===");
  p.push("- عناوین اخیر فقط برای تشخیص تکراری هستند.");
  p.push("");
  p.push("=== فرمت خروجی ===");
  p.push('فقط JSON Object. هیچ متن خارج از JSON تولید نکنید.');
  p.push('{"news":[{"title":"✴️ تیتر","body":"🔸 جمله اول.\n\n🔸 جمله دوم.","source_link":"لینک","image_url":"لینک یا خالی"]}');
  p.push("");
  p.push("=== نمونه‌های مطلوب ===");
  p.push("");
  p.push("نمونه ۱ (مصاحبه اختصاصی):");
  p.push("تیتر: ✴️ در آستانه توافق");
  p.push("🔸 فداحسین مالکی عضو کمیسیون امنیت ملی مجلس در مصاحبه با خبرگزاری دانشجو گفت ایران و عمان بر مسیر پیشنهادی ایران تمرکز کرده‌اند.");
  p.push("");
  p.push("🔸 مالکی گفته در صورت تحقق توافق، کنترل تنگه هرمز کماکان در اختیار ایران خواهد بود.");
  p.push("");
  p.push("نمونه ۲ (مصاحبه اختصاصی خانه ملت):");
  p.push("تیتر: ✴️ به احترام اربعین سکوت کرده‌ایم");
  p.push("🔸 علاءالدین بروجردی عضو کمیسیون امنیت ملی مجلس در گفتگو با خبرنگار خانه ملت درباره حمله عربستان به مقاومت عراق گفته ما به احترام ایام اربعین سکوت کرده‌ایم اما پاسخ سخت در راه است.");
  p.push("");
  p.push("نمونه ۳ (بدون مصاحبه - فقط گزارش):");
  p.push("تیتر: ✴️ بنزین گران نخواهد شد");
  p.push("🔸 علی نیکزاد نایب‌رئیس مجلس گفت افزایش قیمت بنزین منتفی است و جابه‌جایی سهمیه انجام می‌شود.");
  p.push("");
  p.push("نمونه ۴ (گزارش خانه ملت بدون مصاحبه):");
  p.push("تیتر: ✴️ افتتاح ۲۰ پروژه عمرانی در صیدون");
  p.push("🔸 فرشاد ابراهیم‌پور نماینده مجلس ۲۰ پروژه عمرانی با اعتبار ۱۱۵ میلیارد تومان در صیدون افتتاح کرد.");
  p.push("");
  p.push("نمونه ۵ (گزارش بدون ذکر منبع رسانه):");
  p.push("تیتر: ✴️ تأکید دیوان محاسبات بر ساماندهی شوراهای عالی");
  p.push("🔸 دیوان محاسبات کل کشور در گزارش خود اعلام کرد ۲۹۱ نهاد شورایی شناسایی شده و ۹۵ مورد برای انحلال یا ادغام تعیین شده است.");
  p.push("");
  p.push("========================");
  p.push("اخبار خام");
  p.push("========================");
  p.push(recentMessages);
  if (recentTitlesPrompt) p.push(recentTitlesPrompt);
  return p.join("\n");
}
// ==========================================
// ارسال به تلگرام
// ==========================================
async function sendToTelegram(message, imageUrl, botToken, chatId) {
  const baseUrl = "https://api.telegram.org/bot" + botToken + "/";

  if (imageUrl && imageUrl.startsWith("http") && imageUrl.length > 20) {
    try {
      const imageBuffer = await httpGetBuffer(imageUrl);
      if (imageBuffer && imageBuffer.length > 1000) {
        const boundary = "----FormBoundary" + Date.now();
        const parts = [];
        parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + chatId + "\r\n"));
        parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n" + message + "\r\n"));
        parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"parse_mode\"\r\n\r\nHTML\r\n"));
        parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"photo.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"));
        parts.push(imageBuffer);
        parts.push(Buffer.from("\r\n--" + boundary + "--\r\n"));
        const fullBody = Buffer.concat(parts);
        const response = await httpPostMultipart(baseUrl + "sendPhoto", boundary, fullBody);
        const result = JSON.parse(response);
        if (result.ok) return result;
        console.log("  ⚠️ عکس ارسال نشد:", result.description || "unknown");
      }
    } catch (err) {
      console.log("  ⚠️ خطا در عکس:", err.message);
    }
  }

  const payload = JSON.stringify({
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  const response = await httpPost(baseUrl + "sendMessage", payload, {
    "Content-Type": "application/json",
  });
  return JSON.parse(response);
}

// ==========================================
// پارس JSON ایمن
// ==========================================
// ==========================================
// JSON parser (improved)
// ==========================================
// نرمال‌سازی فرمت خروجی مدل‌ها
function normalizeNewsItem(item) {
  // تبدیل text به body
  if (item.text && !item.body) {
    item.body = item.text;
    delete item.text;
  }
  // تبدیل headline به title
  if (item.headline && !item.title) {
    item.title = item.headline;
    delete item.headline;
  }
  // تبدیل content به body
  if (item.content && !item.body) {
    item.body = item.content;
    delete item.content;
  }
  return item;
}

function safeParseJson(rawText) {
  if (!rawText || rawText.trim().length === 0) return [];
  var raw = rawText;

  // Step 1: Strip thinking text. The model often writes analysis before JSON.
  // Find the ACTUAL JSON start: first {"news" or first { before "news"
  var t = raw;
  // Clean invalid Unicode characters (replacement chars, control chars)
  t = t.replace(/\uFFFD/g, "");
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "");
  t = t.replace(/```json/gi, "").replace(/```/g, "");

  // Find where the real JSON object starts
  var newsPattern = t.indexOf("\"news\"");
  if (newsPattern === -1) newsPattern = t.indexOf("news");
  if (newsPattern !== -1) {
    // Find the { that opens the object containing "news"
    var jsonStart = t.lastIndexOf("{", newsPattern);
    if (jsonStart !== -1 && jsonStart < newsPattern) {
      // Strip everything before this {
      t = t.substring(jsonStart);
    }
  }

  // Step 2: Now parse the JSON using bracket counting
  var opens = [];
  var closes = [];
  var inStr = false;
  var esc = false;
  for (var i = 0; i < t.length; i++) {
    var ch = t.charAt(i);
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === "\"") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") opens.push(i);
    if (ch === "}") closes.push(i);
  }

  // Try from the first { (should be the root object now)
  if (opens.length > 0) {
    var rootOpen = opens[0];
    var rootClose = -1;
    for (var j = 0; j < closes.length; j++) {
      if (closes[j] > rootOpen) {
        // Check if this closes the root by counting
        var depth = 0;
        var inS = false;
        var es = false;
        for (var k = rootOpen; k <= closes[j]; k++) {
          var c2 = t.charAt(k);
          if (es) { es = false; continue; }
          if (c2 === "\\") { es = true; continue; }
          if (c2 === "\"") { inS = !inS; continue; }
          if (inS) continue;
          if (c2 === "{") depth++;
          if (c2 === "}") depth--;
        }
        if (depth === 0) { rootClose = closes[j]; break; }
      }
    }
    if (rootClose !== -1) {
      var candidate = t.substring(rootOpen, rootClose + 1);
      try {
        var obj = JSON.parse(candidate);
        if (obj && Array.isArray(obj.news)) {
          console.log("  \u2705 JSON OK (" + obj.news.length + " news, " + candidate.length + " chars)");
          return obj.news.map(normalizeNewsItem);
        }
      } catch (e) {
        // Try cleaning control chars
        var cleaned = candidate.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");
        try {
          var obj2 = JSON.parse(cleaned);
          if (obj2 && Array.isArray(obj2.news)) {
            console.log("  \u2705 JSON OK (cleaned, " + obj2.news.length + " news)");
            return obj2.news.map(normalizeNewsItem);
          }
        } catch (e2) {}
      }
    }
  }

  // Fallback: try each { from the end
  for (var m = opens.length - 1; m >= 0; m--) {
    var o2 = opens[m];
    var mc = -1;
    for (var n = 0; n < closes.length; n++) {
      if (closes[n] > o2) { mc = closes[n]; break; }
    }
    if (mc === -1) continue;
    try {
      var obj3 = JSON.parse(t.substring(o2, mc + 1));
      if (obj3 && Array.isArray(obj3.news)) {
        console.log("  \u2705 JSON from fallback (pos " + o2 + ")");
        return obj3.news.map(normalizeNewsItem);
      }
      if (Array.isArray(obj3)) return obj3.map(normalizeNewsItem);
    } catch (e) {}
  }

  console.log("  \u274c JSON parse failed (" + raw.length + " chars)");
  console.log("  First 300:", raw.substring(0, 300));
  console.log("  Last 300:", raw.substring(Math.max(0, raw.length - 300)));
  return [];
}// ==========================================
// اصلاح خودکار تیتر
// ==========================================
function fixTitle(title, body) {
  if (!title || !body) return title;
  
  // حذف نام شخص از انتهای تیتر (اگر با «:» یا «گفت» تمام شده)
  title = title.replace(/([\u0600-\u06FF]+\s+[\u0600-\u06FF]+)\s*:\s*$/, '').trim();
  title = title.replace(/([\u0600-\u06FF]+\s+[\u0600-\u06FF]+)\s+گفت\s*$/, '').trim();
  
  // اگر تیتر فقط «بررسی» یا «نشست» یا «بازدید» باشد → از متن نتیجه بگیر
  const vaguePatterns = /^(بررسی|نشست|بازدید|پیگیری|توضیح|پرداختن به|اشاره به|談話)/;
  if (vaguePatterns.test(title.replace('✴️', '').trim())) {
    // سعی کن از متن، نتیجه یا تصمیم اصلی رو پیدا کنی
    const resultPatterns = [
      /(?:گفت|نوشت|تاکید کرد|اعلام کرد|هشدار داد|پیشنهاد کرد|تکذیب کرد|رد کرد|تأیید کرد)\s*(.{20,80})/,
      /(?:ممنوعیت|لغو|افزایش|کاهش|تغییر|اصلاح|تصویب|رد|انحلال|ادغام|آغاز|پایان|افتتاح|تکمیل)\s+(.{10,60})/,
    ];
    for (const pat of resultPatterns) {
      const m = body.match(pat);
      if (m) {
        // تیتر جدید بساز
        let newTitle = m[0];
        if (newTitle.length > 60) newTitle = newTitle.substring(0, 57) + '...';
        title = '✴️ ' + newTitle;
        break;
      }
    }
  }
  
  // اگر تیتر هنوز خیلی کلی است (فقط یک کلمه یا موضوع)
  const words = title.replace('✴️', '').trim().split(/\s+/);
  if (words.length <= 2 && !title.includes('گران') && !title.includes('منتفی')) {
    // سعی کن از متن، فعل اصلی رو پیدا کنی
    const verbMatch = body.match(/(گفت|نوشت|تاکید کرد|اعلام کرد|هشدار داد|پیشنهاد کرد|تکذیب کرد|افتتاح کرد|آغاز شد|تکمیل شد)/);
    if (verbMatch) {
      const context = body.substring(0, 100);
      const actionMatch = context.match(/([^،.]+)\s+(گفت|نوشت|تاکید کرد|اعلام کرد|هشدار داد|پیشنهاد کرد|تکذیب کرد|افتتاح کرد)/);
      if (actionMatch && actionMatch[1].length > 5) {
        let newTitle = actionMatch[1].trim();
        if (newTitle.length > 50) newTitle = newTitle.substring(0, 47) + '...';
        title = '✴️ ' + newTitle;
      }
    }
  }
  
  return title;
}

// ==========================================
// تابع اصلی
// ==========================================
async function main() {
  try {
    const config = loadConfig();
    const SOURCE_CHANNEL_ID = config.SOURCE_CHANNEL_ID || "news_parliament";
    const OPENROUTER_API_KEY = config.OPENROUTER_API_KEY || "";
    const BOT_TOKEN = config.BOT_TOKEN || "";
    const DESTINATION_CHAT_ID = config.DESTINATION_CHAT_ID || "";

    if (!OPENROUTER_API_KEY) { console.log("❌ OPENROUTER_API_KEY تنظیم نشده."); return; }
    if (!BOT_TOKEN || !DESTINATION_CHAT_ID) { console.log("❌ BOT_TOKEN یا DESTINATION_CHAT_ID تنظیم نشده."); return; }

    console.log("📡 خواندن اخبار از کانال و RSS...");
    const [messages, rssNews] = await Promise.all([
      fetchTelegramMessages(SOURCE_CHANNEL_ID),
      fetchRSSNews()
    ]);
    console.log("✅ " + messages.length + " پیام تلگرام + " + rssNews.length + " خبر RSS.");

    const state = loadState();
    const lastProcessed = state.LAST_PROCESSED_SNIPPET || "";
    let recentTitles = state.RECENT_TITLES || [];

    let newMessages = [];
    let foundLast = false;

    if (lastProcessed) {
      for (let i = 0; i < messages.length; i++) {
        const cleanMsg = messages[i].text.trim();
        if (foundLast) {
          newMessages.push(messages[i]);
        } else if (cleanMsg.indexOf(lastProcessed) !== -1 || lastProcessed.indexOf(cleanMsg.substring(0, 30)) !== -1) {
          foundLast = true;
        }
      }
    }

    if (!foundLast || newMessages.length === 0) {
      newMessages = messages.slice(-3);
    } else if (newMessages.length > 2) {
      newMessages = newMessages.slice(0, 5);
    }

    if (newMessages.length === 0) { console.log("📭 پیام جدیدی نیست."); return; }
    console.log("📝 " + newMessages.length + " خبر جدید.");

    // خواندن متن کامل
    console.log("📖 خواندن متن کامل خبرها...");
    const qualityMessages = [];
    for (let i = 0; i < newMessages.length; i++) {
      const msg = newMessages[i];
      if (msg.newsLink) {
        console.log("  🔗 " + msg.newsLink.substring(0, 60) + "...");
        const fullText = await fetchArticleText(msg.newsLink);
        if (fullText && fullText.length > 100) {
          msg.fullText = fullText;
          qualityMessages.push(msg);
          console.log("  ✅ متن کامل (" + fullText.length + " کاراکتر)");
        } else {
          console.log("  ⛔ رد شد: متن کامل پیدا نشد");
        }
      } else {
        qualityMessages.push(msg);
      }
    }
    newMessages = qualityMessages;
    console.log("📊 " + newMessages.length + " خبر با کیفیت.");

    // ساخت متن خام
    let recentMessages = "";
    for (let i = 0; i < newMessages.length; i++) {
      recentMessages += "\n\n===== NEWS " + (i + 1) + " =====\n";
      if (newMessages[i].imageUrl) recentMessages += "[تصویر: " + newMessages[i].imageUrl + "]\n";
      if (newMessages[i].newsLink) recentMessages += "[لینک منبع: " + newMessages[i].newsLink + "]\n";
      const content = newMessages[i].fullText || newMessages[i].text;
      recentMessages += content.length > 2000 ? content.substring(0, 2000) + "..." : content;
    }

    // اخبار RSS (با خواندن متن کامل از وب‌سایت)
    // اولویت با ICANA (خبرگزاری رسمی مجلس) است
    const sortedRss = rssNews.sort((a, b) => {
      if (a.source === 'ICANA' && b.source !== 'ICANA') return -1;
      if (a.source !== 'ICANA' && b.source === 'ICANA') return 1;
      return 0;
    });
    let rssIndex = 0;
    const MAX_RSS = 2; // حداکثر ۶ خبر RSS (۲ تا ICANA + ۴ تا بقیه)
    for (const rss of sortedRss) {
      if (rss.description && rss.description.length > 50 && rssIndex < MAX_RSS) {
        // اگر لینک دارد، متن کامل را از وب‌سایت بخوان
        let fullText = rss.description;
        if (rss.link && rss.link.startsWith('http')) {
          console.log("  🔗 RSS " + rss.source + ": " + rss.link.substring(0, 60) + "...");
          try {
            const fetched = await fetchArticleText(rss.link);
            if (fetched && fetched.length > rss.description.length) {
              fullText = fetched;
              console.log("  ✅ متن کامل RSS (" + fetched.length + " کاراکتر)");
            } else {
              console.log("  ⚠️ متن کامل RSS پیدا نشد، از description استفاده شد");
            }
          } catch (e) {
            console.log("  ⚠️ خطا در خواندن RSS:", e.message);
          }
        }
        recentMessages += "\n\n===== NEWS RSS " + (rssIndex + 1) + " =====\n";
        recentMessages += "[لینک منبع: " + rss.link + "]\n";
        recentMessages += "[منبع: " + rss.source + "]\n";
        recentMessages += fullText.length > 2000 ? fullText.substring(0, 2000) + "..." : fullText;
        rssIndex++;
      }
    }
    console.log("📰 " + rssIndex + " خبر RSS اضافه شد.");

    // اخبار منتشر شده
    let publishedNews = cleanOldPublished(state.PUBLISHED_NEWS || []);
    let publishedTitlesPrompt = "";
    if (publishedNews.length > 0) {
      publishedTitlesPrompt = "\n\n=== اخبار منتشر شده در ساعت اخیر (تکرار نکنید) ===\n";
      for (const pub of publishedNews) {
        publishedTitlesPrompt += "- " + pub.title.replace(/<[^>]*>/gm, "").replace("✴️ ", "") + "\n";
      }
    }

    const recentTitlesPrompt = recentTitles.length > 0
      ? "\nعناوین اخیر (تکرار نکن): " + recentTitles.join(" | ")
      : "";

    const prompt = buildPrompt(recentMessages, recentTitlesPrompt + publishedTitlesPrompt);

    console.log("🤖 ارسال به هوش مصنوعی...");
    const startTime = Date.now();
    
    // همیشه Nemotron رو اول امتحان کن
    // اگه rate limit باشه، فوری برمی‌گرده و MiniMax امتحان میشه
    // اگه overloaded باشه، چند ثانیه صبر می‌کنه
    let aiText = null;
    let usedModel = '';
    
    console.log("  🥇 تلاش با Nemotron...");
    console.log("  🔑 OPENROUTER_API_KEY: " + (OPENROUTER_API_KEY ? 'تنظیم شده (' + OPENROUTER_API_KEY.substring(0, 8) + '...)' : '❌ تنظیم نشده'));
    console.log("  🔑 NARA_ROUTER_API_KEY: " + ((process.env.NARA_ROUTER_API_KEY || '') ? 'تنظیم شده' : '❌ تنظیم نشده'));
    console.log("  🔑 GROQ_API_KEY: " + ((process.env.GROQ_API_KEY || '') ? 'تنظیم شده' : '❌ تنظیم نشده'));
    const result = await callOpenRouter(prompt, OPENROUTER_API_KEY);
    if (result.status === 'success') {
      aiText = result.content;
      usedModel = result.model || 'Nemotron';
    } else if (result.status === 'rate_limited') {
      console.log("  ⛔ Nemotron rate limited! مدل‌های جایگزین امتحان می‌شه.");
    } else {
      console.log("  🔄 Nemotron ناموفق. مدل‌های جایگزین امتحان می‌شه.");
    }
    
    // اگه Nemotron کار نکرد، NaraRouter رو امتحان کن (رایگان و پایدار)
    if (!aiText) {
      console.log('  🟣 تلاش با NaraRouter...');
      aiText = await callNaraRouter(prompt);
      if (aiText) {
        usedModel = 'NaraRouter';
        console.log('  ✅ NaraRouter موفق بود!');
      } else {
        console.log('  ❌ NaraRouter ناموفق بود.');
      }
    }
    // اگه NaraRouter هم کار نکرد، Groq رو امتحان کن (سهمیه جداگانه)
    if (!aiText) {
      console.log('  🟡 تلاش با Groq...');
      aiText = await callGroq(prompt);
      if (aiText) {
        usedModel = 'Groq';
        console.log('  ✅ Groq موفق بود!');
      } else {
        console.log('  ❌ Groq ناموفق بود.');
      }
    }
    // اگه NaraRouter هم کار نکرد و OpenRouter rate limit نبود، مدل‌های جایگزین رو امتحان کن
    // اگه OpenRouter rate limit بود، دیگه سراغش نرو (همگی سهمیه مشترک دارن)
    if (!aiText && result.status !== 'rate_limited') {
      console.log('  🟢 تلاش با مدل‌های جایگزین رایگان...');
      aiText = await callFallbackModels(prompt);
      if (aiText) {
        usedModel = 'Fallback';
      }
    }

    // اگه MiniMax هم کار نکرد، از Gemini استفاده کن
    if (!aiText) {
      // اول تلاش با Proxy (Apps Script)
      if (config.GEMINI_PROXY_URL) {
        console.log("  🥈 تلاش با Gemini Proxy...");
        aiText = await callGeminiProxy(prompt, config.GEMINI_PROXY_URL);
        if (aiText) {
          usedModel = 'Gemini (Proxy)';
        }
      }
      // اگه Proxy کار نکرد، مستقیم امتحان کن
      if (!aiText) {
        console.log("  🥉 تلاش با Gemini مستقیم...");
        aiText = await callGemini(prompt, config.GEMINI_API_KEY || "");
        if (aiText) {
          usedModel = 'Gemini (Direct)';
        }
      }
    }
    console.log("⏱️ پاسخ در " + ((Date.now() - startTime) / 1000).toFixed(1) + " ثانیه.");

    if (!aiText || aiText.trim().length === 0) { console.log("❌ پاسخ خالی."); return; }
    console.log("📝 پاسخ (" + aiText.length + " کاراکتر)");

    const newsArray = safeParseJson(aiText);
    if (newsArray === null) { console.log("❌ خطا در پارس JSON"); return; }
    if (newsArray.length === 0) { console.log("📭 خبری تولید نشد."); return; }

    // اعتبارسنجی کیفیت
    const qualityReport = {
      timestamp: new Date().toISOString(),
      model: usedModel || AI_MODELS[0],
      items: [],
      avgScore: 0
    };
    let totalScore = 0;
    for (const item of newsArray) {
      const origText = (item.source_link || '');
      const validation = validateNewsItem(item, origText);
      qualityReport.items.push({
        title: (item.title || '').substring(0, 80),
        score: validation.score,
        issues: validation.issues
      });
      totalScore += validation.score;
    }
    qualityReport.avgScore = Math.round(totalScore / newsArray.length);
    console.log('📊 نمره کیفیت: ' + qualityReport.avgScore + '/100');
    if (qualityReport.avgScore < 60) {
      console.log('⚠️ کیفیت پایین! مسائل:');
      for (const item of qualityReport.items) {
        if (item.issues.length > 0) console.log('  - ' + item.title + ': ' + item.issues.join(', '));
      }
    }

    // بازیابی عکس و لینک منبع - اولویت: OG تصویر مقاله > عکس تلگرام
    for (let i = 0; i < newsArray.length; i++) {
      const item = newsArray[i];
      // پیدا کردن newMessage مربوطه بر اساس source_link
      let originalMsg = null;
      if (item.source_link) {
        for (const m of newMessages) {
          if (m.newsLink && m.newsLink.split('?')[0].split('#')[0] === item.source_link.split('?')[0].split('#')[0]) {
            originalMsg = m;
            break;
          }
        }
      }
      // اگر پیدا نشد، از RSS استفاده کن
      if (!originalMsg) {
        for (const m of newMessages) {
          if (m.newsLink && item.source_link && m.newsLink === item.source_link) {
            originalMsg = m;
            break;
          }
        }
      }
      // اگر source_link از مدل نیومد، از لینک تلگرام یا RSS استفاده کن
      if (!item.source_link || item.source_link.length < 10) {
        // ۱. از تلگرام
        if (originalMsg && originalMsg.newsLink) {
          item.source_link = originalMsg.newsLink;
          console.log('  🔗 لینک منبع از تلگرام:', item.source_link.substring(0, 60));
        }
        // ۲. از RSS: جستجو در recentMessages بر اساس متن خلاصه
        if (!item.source_link || item.source_link.length < 10) {
          const bodyWords = (item.body || '').replace(/[🔸✴️]/g, '').trim().split(/\s+/).filter(w => w.length > 4);
          if (bodyWords.length >= 1) {
            const lines = recentMessages.split('\n');
            let bestLink = '';
            let bestScore = 0;
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line.includes('[لینک منبع:') && line.includes('http')) {
                const urlMatch = line.match(/https?:\/\/[^\s\]]+/);
                if (urlMatch) {
                  // متن خبر اصلی رو از چند خط بعدی بگیر
                  const nearbyContent = lines.slice(Math.max(0, i-2), i+5).join(' ');
                  // تعداد کلمات مشترک رو بشمر
                  let score = 0;
                  for (const word of bodyWords.slice(0, 8)) {
                    if (nearbyContent.includes(word)) score++;
                  }
                  if (score > bestScore) {
                    bestScore = score;
                    bestLink = urlMatch[0];
                  }
                }
              }
            }
            if (bestLink && bestScore >= 2) {
              item.source_link = bestLink;
              console.log('  🔗 لینک منبع از RSS (امتیاز ' + bestScore + '):', item.source_link.substring(0, 60));
            }
          }
        }
      }
      let hasValidImage = false;
      
      // ۱. اول همیشه OG تصویر مقاله رو بگیر (قابل اعتمادترین)
      if (item.source_link && item.source_link.startsWith("http")) {
        console.log("  🔍 دریافت عکس OG از مقاله:", item.source_link.substring(0, 60));
        const ogImage = await fetchOgImage(item.source_link);
        // فیلتر عکس‌های پیش‌فرض صحن مجلس و عکس‌های غیرمرتبط
        const isDefaultImg = ogImage && (
          ogImage.includes('default') || ogImage.includes('placeholder') ||
          ogImage.includes('logo') || ogImage.includes('banner') ||
          ogImage.includes('site-logo') || ogImage.includes('header')
        );
        if (ogImage && ogImage.startsWith("http") && ogImage.length > 20 && !ogImage.includes("telesco.pe") && !isDefaultImg) {
          item.image_url = ogImage;
          hasValidImage = true;
          console.log("  📷 عکس OG مقاله پیدا شد:", ogImage.substring(0, 60));
        } else {
          console.log("  ⛔ عکس OG پیدا نشد");
        }
      }
      
      // ۲. اگر OG پیدا نشد، از عکس AI استفاده کن (فقط اگر معتبر باشد)
      if (!hasValidImage && item.image_url && item.image_url.startsWith("http") && !item.image_url.includes("telesco.pe") && item.image_url.length > 20) {
        hasValidImage = true;
        console.log("  📷 عکس از AI:", item.image_url.substring(0, 60));
      }
      
      // ۳. اگر هنوز عکس نداریم، از تلگرام استفاده کن (فقط CDN)
      if (!hasValidImage && originalMsg && originalMsg.imageUrl) {
        const tgImg = originalMsg.imageUrl;
        // فیلتر عکس‌های پیش‌فرض صحن مجلس
        const isParliamentDefault = tgImg.includes('parliament') || tgImg.includes('majlis') ||
          tgImg.includes('default') || tgImg.includes('placeholder');
        if (tgImg.startsWith("http") && (tgImg.includes("cdn") || tgImg.includes("t.me")) && !isParliamentDefault) {
          item.image_url = tgImg;
          hasValidImage = true;
          console.log("  📷 عکس از تلگرام (CDN):", tgImg.substring(0, 60));
        } else {
          console.log("  ⛔ عکس تلگرام رد شد (cdn نیست):", tgImg.substring(0, 60));
          item.image_url = "";
        }
      }
      
      // ۴. اگر اصلاً عکسی نیست
      if (!hasValidImage) {
        item.image_url = "";
        console.log("  ⛔ عکسی پیدا نشد");
      }
    }
    // بررسی تکرار
    const uniqueNews = [];
    for (const item of newsArray) {
      if (!item.title || !item.body) continue;
      if (isDuplicate(item, publishedNews)) {
        console.log("  ⛔ تکرار:", (item.title || "").replace("✴️ ", ""));
        continue;
      }
      uniqueNews.push(item);
    }

    // نمایش وضعیت عکس و لینک هر خبر
    for (const item of uniqueNews) {
      const hasImage = item.image_url && item.image_url.startsWith('http') && item.image_url.length > 20;
      const hasLink = item.source_link && item.source_link.startsWith('http') && item.source_link.length > 10;
      console.log('  📰 ' + (item.title || '').substring(0, 40) + ': عکس=' + (hasImage ? '✅' : '❌') + ' | لینک=' + (hasLink ? '✅' : '❌'));
    }
    if (uniqueNews.length === 0) {
      console.log("📭 همه تکراری بودند.");
      state.PUBLISHED_NEWS = publishedNews;
      state.RECENT_TITLES = recentTitles;
      const lastMsg = newMessages[newMessages.length - 1];
      state.LAST_PROCESSED_SNIPPET = lastMsg.text.trim().substring(0, 50);
      saveState(state);
      return;
    }
    console.log("✅ " + uniqueNews.length + " خبر غیرتکراری.");

    // ارسال
    console.log("📤 ارسال " + uniqueNews.length + " خبر...");
    for (let i = 0; i < uniqueNews.length; i++) {
      const item = uniqueNews[i];
      if (!item.title || !item.body) continue;

      // اصلاح فاصله بین بند‌ها: اگر 🔸 بدون \n\n قبلش اومده، اضافه کن
      item.body = item.body.replace(/([^\n])\s*(🔸)/g, '$1\n\n$2');
      // اگر چند 🔸 پشت هم اومده، فقط یکی باشه
      item.body = item.body.replace(/(🔸[^\n]*?)\n*🔸/g, '$1\n\n🔸');


      // حذف «مصاحبه» اشتباه اگر خبر فقط گزارش باشد
      // اگر متن شامل «گزارش»، «بازدید»، «نشست»، «افتتاح» باشد بدون کلمه «مصاحبه» یا «گفتگو» صریح
      const hasInterview = /مصاحبه|گفتگو/.test(item.body);
      const hasReport = /گزارش|بازدید|نشست|افتتاح|بهره‌برداری/.test(item.body);
      if (hasReport && !hasInterview) {
        item.body = item.body.replace(/در مصاحبه با [^،,]+ /g, '');
        item.body = item.body.replace(/در گفتگو با [^،,]+ /g, '');
      }
      // الگوی جعل رایج مدل‌های ضعیف: «عضو X در خبر ایرنا گفت» / «قالیباف در تابناک گفت»
      // رسانه‌ای که فقط خبر را منتشر کرده، منبع نقل‌قول نیست → عبارت رسانه حذف و فعل نگه داشته می‌شود
      // (توجه: «در گفتگو با خبرنگار X» دست نمی‌خورد چون ممکن است مصاحبه واقعی باشد)
      item.body = item.body.replace(/در (خبر|سایت|پایگاه|روزنامه|خبرگزاری)\s+[^،,\.\n]{2,30}?\s+(گفت|نوشت|تاکید کرد|اظهار کرد)(?=\s|،|\.|$)/g, '$2');
      item.body = item.body.replace(/در (ایرنا|خانه ملت|تابناک|دنیای اقتصاد|باشگاه خبرنگاران جوان|سنتی نیوز|یجس|خبر جوان)\s+(گفت|نوشت|تاکید کرد|اظهار کرد)(?=\s|،|\.|$)/g, '$2');
      // حذف حوزه انتخابیه: نماینده مردم X، Y و Z در مجلس → نماینده مجلس
      item.body = item.body.replace(/نماینده مردم [^،,]+ در مجلس/g, 'نماینده مجلس');
      // حذف تکرار مجلس: عضو کمیسیون X مجلس → عضو کمیسیون X
      item.body = item.body.replace(/مجلس مجلس/g, ' مجلس');
      item.body = item.body.replace(/مجلس\s+مجلس/g, 'مجلس');
      // اصلاح غلط املایی رایج
      item.body = item.body.replace(/صفطولانی/g, 'صف طولانی');
      item.body = item.body.replace(/قالباب/g, 'قالیباف');
      item.body = item.body.replace(/اظهار داشت/g, 'گفت');
      item.body = item.body.replace(/اظهار کرد/g, 'گفت');
      item.body = item.body.replace(/خاطرنشان کرد/g, 'گفت');
      item.body = item.body.replace(/تصریح کرد/g, 'گفت');
      item.body = item.body.replace(/وی افزود/g, 'او همچنین گفت');
      item.body = item.body.replace(/وی گفت/g, function(match) { return match; });
      item.body = item.body.replace(/مجلس شورای اسلامی/g, 'مجلس');
      item.title = item.title.replace(/مجلس شورای اسلامی/g, 'مجلس');
      // حفظ فاصله بین بند‌ها (\n\n) و حذف فاصله‌های اضافی
      item.body = item.body.replace(/([^\n])\n([^\n])/g, '$1\n$2');
      item.body = item.body.replace(/ {2,}/g, ' ').trim();
      
      // اصلاح خودکار تیتر
      item.title = fixTitle(item.title, item.body);

      // پاکسازی کاراکترهای انگلیسی ناخواسته از انتهای متن
      item.body = item.body.replace(/\s*[A-Za-z]{3,}\s*$/g, '').trim();
      item.title = item.title.replace(/\s*[A-Za-z]{3,}\s*$/g, '').trim();
      
      // تعیین عکس قبل از لاگ
      const imageUrl = item.image_url && item.image_url.startsWith("http") && item.image_url.length > 20 ? item.image_url : null;
      
      // لاگ وضعیت خبر
      console.log('  📰 [' + (usedModel || '?') + '] ' + (item.title || '').substring(0, 50) + ' | عکس=' + (imageUrl ? '✅' : '❌') + ' | لینک=' + (item.source_link && item.source_link.length > 5 ? '✅' : '❌') + ' | طول متن=' + (item.body || '').length);
      
      // دروازه کیفیت: اگر متن خیلی کوتاه بود، ارسال نکن
      const bodyText = (item.body || '').split(String.fromCharCode(10)).join('').trim();
      if (bodyText.length < 80) {
        console.log('  ⛔ رد شد: متن خیلی کوتاه (' + bodyText.length + ' کاراکتر)');
        continue;
      }
      
      let finalMessage = "<b>" + item.title + "</b>\n\n" + item.body + "\n\n🇮🇷 این خانه #ازما ست\n🔰 @azmaa_net";
      if (item.source_link && item.source_link.length > 5) {
        finalMessage += '\n\n🔗 <a href="' + item.source_link + '">منبع خبر</a>';
      }
      // نمایش مدل هوش مصنوعی سازنده خلاصه (جهت ردیابی کیفیت) — همیشه اجباری
      finalMessage += '\n\u200F🤖 مدل: ' + (usedModel || 'نامشخص');
      const result = await sendToTelegram(finalMessage, imageUrl, BOT_TOKEN, DESTINATION_CHAT_ID);

      if (result.ok) {
        console.log("  ✅ " + item.title.replace("✴️ ", ""));
        recentTitles.push(item.title.replace(/<[^>]*>/gm, "").replace("✴️ ", ""));
        publishedNews.push({
          title: item.title.replace(/<[^>]*>/gm, ""),
          source_link: item.source_link || "",
          timestamp: Date.now()
        });
        // ذخیره در دیتابیس برای بازبینی خودکار
        saveNewsToState(state, item, '', usedModel);
      } else {
        console.log("  ❌ خطا:", result.description || JSON.stringify(result));
      }
    }

    if (recentTitles.length > 15) recentTitles = recentTitles.slice(-15);
    if (publishedNews.length > 100) publishedNews = publishedNews.slice(-100);

    const lastMsg = newMessages[newMessages.length - 1];
    state.RECENT_TITLES = recentTitles;
    state.PUBLISHED_NEWS = publishedNews;
    state.LAST_PROCESSED_SNIPPET = lastMsg.text.trim().substring(0, 50);
    saveState(state);

    // ذخیره گزارش کیفیت
    if (typeof qualityReport !== 'undefined' && qualityReport.items.length > 0) {
      saveQualityReport(qualityReport);
    }

    // بازبینی خودکار کیفیت بعد از انتشار
    console.log('\n🔍 === بازبینی خودکار بعد از انتشار ===');
    const autoReviewResult = await autoReviewPublishedNews(state, uniqueNews, newsArray.map(n => n.source_link || ''));
    
    // بازخوانی بعد از انتشار
    const reviewReport = await reviewPublishedNews(DESTINATION_CHAT_ID, recentTitles);
    if (reviewReport) {
      saveReviewReport(reviewReport);
    }
    
    // گزارش روزانه (هر ۲ ساعت)
    if (shouldSendReport(state)) {
      const dailyReport = generateDailyReport(state);
      if (dailyReport) {
        const dailyMsg = formatDailyReport(dailyReport, state);
        try {
          await httpPost(
            'https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage',
            JSON.stringify({ chat_id: DESTINATION_CHAT_ID, text: dailyMsg, parse_mode: 'HTML', disable_web_page_preview: true }),
            { 'Content-Type': 'application/json' }
          );
          console.log('📊 گزارش روزانه ارسال شد');
        } catch (e) {
          console.log('⚠️ خطا در ارسال گزارش روزانه:', e.message);
        }
      }
    }

    // ارسال گزارش به تلگرام (با رعایت فاصله زمانی)
    if (shouldSendReport(state)) {
      await sendQualityReportToTelegram(qualityReport, reviewReport, newsArray.length, BOT_TOKEN, DESTINATION_CHAT_ID);
      state.LAST_REPORT_TIME = Date.now();
      saveState(state);
      console.log('📊 گزارش ارسال شد (' + getTehranTimeStr() + ' به وقت تهران)');
    } else {
      console.log('📊 ارسال گزارش رد شد (فاصله زمانی رعایت نشده)');
    }

    console.log("🎉 تمام شد!");
  } catch (error) {
    console.log("❌ خطا:", error.message);
  }
}

// ==========================================
// حلقه خودکار (هر ۱۵ دقیقه)
// ==========================================
const INTERVAL_MINUTES = 15;

async function runOnce() {
  const time = getTehranTimeStr();
  const period = isTehranNight() ? '🌙 شب' : '☀️ روز';
  console.log('\n🕐 [' + time + ' به وقت تهران] شروع اجرا... (' + period + ')');
  await main();
  console.log('⏰ اجرای بعدی: ' + INTERVAL_MINUTES + ' دقیقه دیگر');
}

runOnce().then(() => {
  // اگر روی GitHub Actions هستیم، فقط یک بار اجرا بشه و تموم بشه
  if (process.env.GITHUB_ACTIONS) {
    console.log('✅ اجرا روی GitHub Actions تموم شد.');
    process.exit(0);
  } else {
    // حالت محلی: هر ۱۵ دقیقه اجرا بشه
    setInterval(() => { runOnce(); }, INTERVAL_MINUTES * 60 * 1000);
  }
});
