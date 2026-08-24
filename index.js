const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ==========================================
// بخش تنظیمات
// ==========================================
const CONFIG_FILE = path.join(__dirname, "config.json");
const STATE_FILE = path.join(__dirname, "state.json");

function loadConfig() {
  // اول از متغیرهای محیطی (GitHub Actions)
  const envConfig = {};
  if (process.env.OPENROUTER_API_KEY) envConfig.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (process.env.BOT_TOKEN) envConfig.BOT_TOKEN = process.env.BOT_TOKEN;
  if (process.env.DESTINATION_CHAT_ID) envConfig.DESTINATION_CHAT_ID = process.env.DESTINATION_CHAT_ID;
  if (process.env.SOURCE_CHANNEL_ID) envConfig.SOURCE_CHANNEL_ID = process.env.SOURCE_CHANNEL_ID;
  
  // بعد از فایل config.json (محلی)
  let fileConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
  
  // ترکیب: متغیرهای محیطی اولویت دارند
  return { ...fileConfig, ...envConfig };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
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
// جلوگیری از تکرار خبر
// ==========================================
const DUPLICATE_WINDOW_MS = 60 * 60 * 1000; // ۱ ساعت

// پاکسازی اخبار قدیمی‌تر از ۱ ساعت
function cleanOldPublished(publishedNews) {
  const now = Date.now();
  return publishedNews.filter(item => (now - item.timestamp) < DUPLICATE_WINDOW_MS);
}

// استخراج نام دامنه از لینک
function extractDomain(url) {
  try {
    const m = url.match(/https?:\/\/([^/]+)/);
    return m ? m[1].replace(/^www\./, '') : '';
  } catch (e) {
    return '';
  }
}

// بررسی تکرار بودن خبر
function isDuplicate(newsItem, publishedNews) {
  const now = Date.now();
  
  for (const pub of publishedNews) {
    // بررسی ۱: لینک منبع یکسان
    if (newsItem.source_link && pub.source_link && 
        newsItem.source_link === pub.source_link) {
      return true;
    }
    
    // بررسی ۲: لینک منبع بدون query string و hash
    if (newsItem.source_link && pub.source_link) {
      try {
        const cleanA = newsItem.source_link.split('?')[0].split('#')[0].replace(/\/$/, '');
        const cleanB = pub.source_link.split('?')[0].split('#')[0].replace(/\/$/, '');
        if (cleanA && cleanB && cleanA === cleanB) return true;
      } catch (e) {}
    }
    
    // بررسی ۳: عنوان بسیار مشابه (بیش از ۶۰٪ کلمات مشترک)
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
// ابزار HTTP (با پشتیبانی از ریدایرکت)
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

      // استخراج لینک خبر اصلی (غیر از t.me)
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

      // استخراج عکس از background-image
      const bgMatch = block.match(/background-image:url\(['"]?([^'")\s]+)['"]?\)/);
      let imgUrl = bgMatch ? bgMatch[1].replace(/&amp;/g, "&") : "";

      // اگر background-image نبود، از تگ img استفاده کن
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
// استخراج عکس اصلی خبر از وب‌سایت منبع
// ==========================================
async function fetchOgImage(url) {
  try {
    const html = await httpGet(url);

    // Method 1: og:image
    const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    if (ogMatch) return ogMatch[1];

    // Method 2: twitter:image
    const twitterMatch = html.match(/<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"/i);
    if (twitterMatch) return twitterMatch[1];

    return null;
  } catch (err) {
    return null;
  }
}

// ==========================================
// خواندن متن کامل خبر از وب‌سایت منبع
// ==========================================
async function fetchArticleText(url) {
  try {
    const html = await httpGet(url);

    // روش ۰: JSON-LD (بهترین روش - متن کامل در structured data)
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

    // روش ۱: articleBody (استاندارد Schema.org) - با regex انعطاف‌پذیرتر
    let m = html.match(/itemprop=["']articleBody["'][^>]*>([\s\S]*?)(?:<\/div>|<\/section>)/i);
    if (m) {
      const text = m[1].replace(/<[^>]*>/gm, " ").replace(/\s+/g, " ").trim();
      if (text.length > 50) return text;
    }

    // روش ۱ب: articleBody بدون بسته شدن div
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

    // روش ۳: class های رایج محتوا
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

    // روش ۴: description متا تگ (به عنوان آخرین تلاش)
    m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (m) return m[1].trim();

    return null;
  } catch (err) {
    return null;
  }
}

// ==========================================
// OpenRouter API
// ==========================================
async function callOpenRouter(prompt, apiKey) {
  const url = "https://openrouter.ai/api/v1/chat/completions";

  const payload = JSON.stringify({
    model: "poolside/laguna-s-2.1:free",
    messages: [
      {
        role: "system",
        content: "You are a Persian news editor. CRITICAL RULES: 1) Copy person names and titles EXACTLY from the source text. Never guess or invent names. 2) In Persian text, ALWAYS write مجلس (not مجلس شورای اسلامی). Only use مجلس شورای اسلامی at the very first mention, then just مجلس. Return ONLY valid JSON, no markdown."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    temperature: 0.3,
    max_tokens: 4000,
  });

  const response = await Promise.race([
    httpPost(url, payload, {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout: OpenRouter پاسخ نداد (120 ثانیه)")), 120000))
  ]);

  const data = JSON.parse(response);
  if (data.error) {
    throw new Error("OpenRouter API Error: " + JSON.stringify(data.error));
  }
  return data.choices[0].message.content;
}

// ==========================================
// پرامپت بهبود یافته
// ==========================================
function buildPrompt(recentMessages, recentTitlesPrompt) {
  let p = [];
  
  p.push("شما سردبیر اخبار تلگرامی هستید. اخبار خام زیر را به خلاصه‌های حرفه‌ای تبدیل کنید.");
  p.push("");
  p.push("⚠️ قوانین مهم که حتماً رعایت کنید:");
  p.push("- مجلس شورای اسلامی → فقط مجلس");
  p.push("- نام افراد را عیناً از متن کپی کنید");
  p.push("");
  
  // قوانین تیتر
  p.push("=== قوانین تیتر ===");
  p.push("- کوتاه، جذاب، رویدادمحور باشد");
  p.push("- با ✴️ شروع شود");
  p.push("- بدون نقل قول (قالیباف: ... ننویسید)");
  p.push("- بدون نام شخص در تیتر");
  p.push("تیتر خوب: ✴️ بنزین گران نخواهد شد");
  p.push("تیتر خوب: ✴️ در آستانه توافق");
  p.push("تیتر خوب: ✴️ ممنوعیت واردات لوازم خانگی در آستانه لغو");
  p.push("تیتر بد: ❌ نیکزاد گفت: بنزین گران نمی‌شود");
  p.push("");
  
  // قوانین متن
  p.push("=== قوانین متن ===");
  p.push("- ۱ یا ۲ بند کوتاه (بستگی به محتوا دارد)");
  p.push("- هر بند با 🔸 و یک فاصله شروع شود");
  p.push("  مثال:\n🔸 نکته اول خبر\n\n🔸 نکته دوم خبر");
  p.push("- حتماً نام + سمّت دقیق شخص در خط اول متن باشد");
  p.push("");
  p.push("⚠️⚠️⚠️ قانون طلایی: نام شخص را عیناً از متن کپی کنید. هرگز حدس نزنید. ⚠️⚠️⚠️");
  p.push("اگر در متن خام نوشته «احمد بخشایش اردستانی»، دقیقاً همان را بنویسید.");
  p.push("اگر نوشته «علی نیکزاد»، دقیقاً همان را بنویسید.");
  p.push("ننویسید «فداحسین مالکی» وقتی اسم واقعی بخشایش است.");
  p.push("ننویسید «سخنگوی دولت» یا «وزیر» وقتی نماینده مجلس است.");
  p.push("نام و سمّت باید عیناً از متن خام کپی شود، نه از حافظه یا حدس.");
  p.push("");
  p.push("- در خبرها فقط بنویسيد مجلس نه مجلس شوراي اسلامي");
  p.push("- فقط در اولين باري كه مجلس ذكر مي‌شود بنويسيد مجلس شوراي اسلامي و بعدش فقط مجلس");
  p.push("  مثال: روح‌الله موسوي عضو كميسيون مجلس گفت... (نه مجلس شوراي اسلامي)");
  p.push("");
  p.push("- نکته اصلی خبر را با جزئیات بیان کنید (اعداد، شروط، ارقام مهم)");
  p.push("  مثال: اگر خبر درباره لغو ممنوعیت واردات است، بنویسید چه شرطی دارد و چه ارقامی مطرح است");
  p.push("");
  p.push("- بدون عبارات خشک خبری: اظهار کرد، وی افزود، خاطرنشان کرد، تصریح کرد");
  p.push("- فقط از این فعل‌ها استفاده کنید: گفت، نوشته، گفته، تاکید کرد، اعلام کرد، هشدار داد");
  p.push("- بدون «وی»؛ همیشه از نام خانوادگی شخص استفاده کنید");
  p.push("");
  
  // قوانین ذکر منبع
  p.push("=== قوانین ذکر منبع ===");
  p.push("- اگر در متن خام نوشته «فلانی در مصاحبه با خبرگزاری X گفت» یا «خبرنگار X گفتگو کرد»:");
  p.push("  → منبع را در متن بیاورید. مثال: فداحسین مالکی عضو کمیسیون امنیت ملی مجلس در مصاحبه با خبرگزاری دانشجو گفت که...");
  p.push("- اگر رسانه صرفاً خبر را نقل قول کرده و مصاحبه انجام نداده (مثلاً فقط نوشته «فلانی گفت»):");
  p.push("  → اسم رسانه را در متن نیاورید. فقط بگویید: فلانی عضو فلان جا گفت که...");
  p.push("- قاعده ساده: اگر کلمه «مصاحبه» یا «خبرنگار» در متن خام آمده، منبع را بیاورید. وگرنه نیاورید.");
  p.push("");
  
  // جلوگیری از تکرار
  p.push("=== جلوگیری از تکرار ===");
  p.push("- عناوین اخیر در انتهای ورودی فقط برای تشخیص اخبار تکراری هستند");
  p.push("- اگر خبر جدید محتوایاً تکراری با یک خبر اخیر است، آن را تولید نکنید");
  p.push("");
  
  // فرمت خروجی
  p.push("=== فرمت خروجی ===");
  p.push("فقط یک JSON Object معتبر برگردانید. هیچ متن خارج از JSON تولید نکنید.");
  p.push('خروجی: {"news":[{"title":"✴️ تیتر","body":"🔸 بند اول\n\n🔸 بند دوم","source_link":"لینک منبع","image_url":"لینک تصویر یا خالی"}]}');
  p.push("");
  
  // نمونه‌ها
  p.push("=== نمونه‌های مطلوب ===");
  p.push("");  p.push("نمونه ۱:");
  p.push('تیتر: ✴️ در آستانه توافق');
  p.push('بدن:');
  p.push('🔸 فداحسین مالکی عضو کمیسیون امنیت ملی و سیاست خارجی مجلس در مصاحبه با خبرگزاری دانشجو گفت که در حال حاضر ایران و عمان بر روی مسیر پیشنهادی ایران تمرکز کرده‌اند و مذاکرات در این زمینه در آستانه نهایی‌شدن قرار دارد.');
  p.push("");
  p.push('🔸 مالکی گفته که اگر این توافق تحقق پیدا کند، کنترل تنگه هرمز کماکان در اختیار ایران خواهد بود.');
  p.push("");
  
  p.push("نمونه ۲:");
  p.push('تیتر: ✴️ بنزین گران نخواهد شد');
  p.push('بدن:');
  p.push('🔸 علی نیکزاد نایب‌رئیس مجلس در پاسخ به تذکری درباره افزایش قیمت بنزین گفت که روز گذشته جلسه‌ای با پورمحمدی، رئیس سازمان برنامه و بودجه، داشتیم.');
  p.push("");
  p.push('🔸 طبق توضیحات رئیس سازمان برنامه و بودجه، افزایش قیمت بنزین منتفی است و جابه‌جایی سهمیه انجام خواهد شد.');
  p.push("");
  
  p.push("نمونه ۳ (بدون ذکر منبع چون مصاحبه نیست): ");
  p.push('تیتر: ✴️ ترتیبات ایرانی؛ تنها راه عبور از تنگه هرمز');
  p.push('بدن:');
  p.push('🔸 حسن قشقاوی سخنگوی کمیسیون امنیت ملی و سیاست خارجی مجلس در صفحه شخصی خود نوشته که در رسانه‌ها از تشدید تنش سخن می‌گویند، در حالیکه از طریق کانال‌های موجود، خواهان مذاکره هستند.');
  p.push("");
  p.push('🔸 آن‌ها نمی‌توانند جمهوری اسلامی ایران را فریب دهند. ترتیبات ایرانی برای عبور از تنگه هرمز تنها گزینه روی میز است.');
  p.push("");
  
  p.push("نمونه ۴ (محتوای کوتاه - ۱ بند): ");
  p.push('تیتر: ✴️ ممنوعیت واردات لوازم خانگی در آستانه لغو');
  p.push('بدن:');
  p.push('🔸 حاکم ممکان، عضو کمیسیون اقتصادی در مصاحبه با ایسنا گفت که اگر مشخص شود واردات قطعات از مسیرهای غیررسمی انجام نمی‌شود، احتمال لغو ممنوعیت واردات چهار قلم لوازم خانگی تا سقف ۵۰۰ تا ۶۰۰ میلیون دلار وجود دارد.');
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

  // تلاش برای ارسال با عکس
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

  // ارسال متن
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
// تابع اصلی
// ==========================================
async function main() {
  try {
    const config = loadConfig();

    const SOURCE_CHANNEL_ID = config.SOURCE_CHANNEL_ID || "news_parliament";
    const OPENROUTER_API_KEY = config.OPENROUTER_API_KEY || "";
    const BOT_TOKEN = config.BOT_TOKEN || "";
    const DESTINATION_CHAT_ID = config.DESTINATION_CHAT_ID || "";

    if (!OPENROUTER_API_KEY) {
      console.log("❌ OPENROUTER_API_KEY تنظیم نشده.");
      return;
    }
    if (!BOT_TOKEN || !DESTINATION_CHAT_ID) {
      console.log("❌ BOT_TOKEN یا DESTINATION_CHAT_ID تنظیم نشده.");
      return;
    }

    console.log("📡 خواندن اخبار از کانال...");
    const messages = await fetchTelegramMessages(SOURCE_CHANNEL_ID);
    console.log("✅ " + messages.length + " پیام پیدا شد.");

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
      newMessages = messages.slice(-5); // حداکثر ۵ خبر
    } else if (newMessages.length > 5) {
      newMessages = newMessages.slice(0, 5);
    }

    if (newMessages.length === 0) {
      console.log("📭 پیام جدیدی نیست.");
      return;
    }

    console.log("📝 " + newMessages.length + " خبر جدید.");

    // خواندن متن کامل خبر از وب‌سایت منبع
    console.log("📖 خواندن متن کامل خبرها...");
    for (let i = 0; i < newMessages.length; i++) {
      const msg = newMessages[i];
      if (msg.newsLink) {
        console.log("  🔗 " + msg.newsLink.substring(0, 60) + "...");
        const fullText = await fetchArticleText(msg.newsLink);
        if (fullText && fullText.length > 50) {
          msg.fullText = fullText;
          console.log("  ✅ متن کامل پیدا شد (" + fullText.length + " کاراکتر)");
        } else {
          console.log("  ⚠️ متن کامل پیدا نشد، از تیتر استفاده می‌شود");
        }
      }
    }

    // ساخت متن خام
    let recentMessages = "";
    for (let i = 0; i < newMessages.length; i++) {
      recentMessages += "\n\n===== NEWS " + (i + 1) + " =====\n";
      if (newMessages[i].imageUrl) {
        recentMessages += "[تصویر: " + newMessages[i].imageUrl + "]\n";
      }
      if (newMessages[i].newsLink) {
        recentMessages += "[لینک منبع: " + newMessages[i].newsLink + "]\n";
      }
      // اگر متن کامل هست، آن را بفرست (حداکثر ۲۰۰۰ کاراکتر). وگرنه تیتر را بفرست.
      const content = newMessages[i].fullText || newMessages[i].text;
      recentMessages += content.length > 2000 ? content.substring(0, 2000) + "..." : content;
    }

    // اخبار منتشر شده در ۱ ساعت اخیر (برای جلوگیری از تکرار)
    let publishedNews = cleanOldPublished(state.PUBLISHED_NEWS || []);
    let publishedTitlesPrompt = "";
    if (publishedNews.length > 0) {
      publishedTitlesPrompt = "\n\n=== اخبار منتشر شده در ساعت اخیر (تکرار نکنید) ===\n";
      for (const pub of publishedNews) {
        publishedTitlesPrompt += "- " + pub.title.replace(/<[^>]*>/gm, "").replace("✴️ ", "") + "\n";
      }
    }
    
    const recentTitlesPrompt =
      recentTitles.length > 0
        ? "\nعناوین اخیر (تکرار نکن): " + recentTitles.join(" | ")
        : "";

    const prompt = buildPrompt(recentMessages, recentTitlesPrompt + publishedTitlesPrompt);

    console.log("🤖 ارسال به هوش مصنوعی...");
    const startTime = Date.now();
    const aiText = await callOpenRouter(prompt, OPENROUTER_API_KEY);
    console.log("⏱️ پاسخ در " + ((Date.now() - startTime) / 1000).toFixed(1) + " ثانیه دریافت شد.");

    // پارس JSON
    let newsArray = [];
    try {
      let cleaned = aiText.replace(/```json/gi, "").replace(/```/g, "").trim();
      // جایگزینی newline های داخل رشته‌های JSON با \n واقعی
      // ابتدا \r را حذف کن
      cleaned = cleaned.replace(/\r/g, '');
      // newline های بین خطوط JSON را با فاصله جایگزین کن
      // ولی newline های داخل "..." را با \n جایگزین کن
      let result = '';
      let inString = false;
      for (let ci = 0; ci < cleaned.length; ci++) {
        const ch = cleaned[ci];
        if (ch === '"' && (ci === 0 || cleaned[ci-1] !== '\\')) {
          inString = !inString;
          result += ch;
        } else if (inString && ch === '\n') {
          result += '\\n';
        } else if (inString && ch === '\t') {
          result += '\\t';
        } else {
          result += ch;
        }
      }
      cleaned = result;
      const firstOpenArray = cleaned.indexOf("[");
      const firstOpenObject = cleaned.indexOf("{");

      let parsedObj;
      if (firstOpenArray !== -1 && (firstOpenObject === -1 || firstOpenArray < firstOpenObject)) {
        let jsonStr = cleaned.substring(firstOpenArray);
        // بستن آرایه ناقص
        if (!jsonStr.endsWith(']')) {
          // آخرین آبجکت ناتمام را حذف کن
          const lastComplete = jsonStr.lastIndexOf('},');
          if (lastComplete > 0) {
            jsonStr = jsonStr.substring(0, lastComplete + 1) + ']';
          } else {
            jsonStr += ']';
          }
        }
        parsedObj = JSON.parse(jsonStr);
      } else if (firstOpenObject !== -1) {
        let jsonStr = cleaned.substring(firstOpenObject);
        if (!jsonStr.endsWith('}')) {
          const lastComplete = jsonStr.lastIndexOf('},');
          if (lastComplete > 0) {
            jsonStr = jsonStr.substring(0, lastComplete + 1) + '}';
          } else {
            jsonStr += '}';
          }
        }
        parsedObj = JSON.parse(jsonStr);
      } else {
        parsedObj = JSON.parse(cleaned);
      }

      if (Array.isArray(parsedObj)) {
        newsArray = parsedObj;
      } else if (parsedObj && Array.isArray(parsedObj.news)) {
        newsArray = parsedObj.news;
      }
    } catch (e) {
      console.log("❌ خطا در پارس JSON:", e.message);
      console.log("متن:", aiText.substring(0, 300));
      return;
    }

    if (newsArray.length === 0) {
      console.log("📭 خبری تولید نشد.");
      return;
    }

    // بازیابی عکس اصلی از منبع
    for (let i = 0; i < newsArray.length; i++) {
      const item = newsArray[i];
      const originalMsg = newMessages[i];

      // اول عکس از وب‌سایت منبع
      if (!item.image_url || !item.image_url.startsWith("http") || item.image_url.includes("telesco.pe")) {
        if (item.source_link && item.source_link.startsWith("http")) {
          console.log("  🔍 دریافت عکس از:", item.source_link.substring(0, 50));
          const ogImage = await fetchOgImage(item.source_link);
          if (ogImage && ogImage.startsWith("http")) {
            item.image_url = ogImage;
            console.log("  📷 عکس اصلی پیدا شد");
          }
        }
      }

      // اگر هنوز عکس نیست، از تلگرام بگیر
      if ((!item.image_url || !item.image_url.startsWith("http")) && originalMsg && originalMsg.imageUrl) {
        item.image_url = originalMsg.imageUrl;
        console.log("  📷 عکس از تلگرام استفاده شد");
      }
    }

    // ========== بررسی تکرار قبل از ارسال ==========
    const uniqueNews = [];
    for (const item of newsArray) {
      if (!item.title || !item.body) continue;
      if (isDuplicate(item, publishedNews)) {
        console.log("  ⛔ تکرار رد شد: " + (item.title || '').replace("✴️ ", ""));
        continue;
      }
      uniqueNews.push(item);
    }
    
    if (uniqueNews.length === 0) {
      console.log("📭 همه اخبار تکراری بودند.");
      state.PUBLISHED_NEWS = publishedNews;
      state.RECENT_TITLES = recentTitles;
      const lastMsg = newMessages[newMessages.length - 1];
      state.LAST_PROCESSED_SNIPPET = lastMsg.text.trim().substring(0, 50);
      saveState(state);
      return;
    }
    console.log("✅ " + uniqueNews.length + " خبر غیرتکراری از " + newsArray.length + " خبر.");

    // ارسال به تلگرام
    console.log("📤 ارسال " + uniqueNews.length + " خبر...");
    for (let i = 0; i < uniqueNews.length; i++) {
      const item = uniqueNews[i];
      if (!item.title || !item.body) continue;

      let finalMessage = "<b>" + item.title + "</b>\n\n" + item.body + "\n\n🇮🇷 این خانه #ازما ست\n🔰 @azmaa_net";

      if (item.source_link && item.source_link.length > 5) {
        finalMessage += '\n\n🔗 <a href="' + item.source_link + '">منبع خبر</a>';
      }

      const imageUrl = item.image_url && item.image_url.startsWith("http") && item.image_url.length > 20 ? item.image_url : null;

      const result = await sendToTelegram(finalMessage, imageUrl, BOT_TOKEN, DESTINATION_CHAT_ID);

      if (result.ok) {
        console.log("  ✅ " + item.title.replace("✴️ ", ""));
        recentTitles.push(item.title.replace(/<[^>]*>/gm, "").replace("✴️ ", ""));
        // ذخیره خبر منتشر شده برای جلوگیری از تکرار
        publishedNews.push({
          title: item.title.replace(/<[^>]*>/gm, ""),
          source_link: item.source_link || "",
          timestamp: Date.now()
        });
      } else {
        console.log("  ❌ خطا:", result.description || JSON.stringify(result));
      }
    }

    // ذخیره تنظیمات
    if (recentTitles.length > 15) {
      recentTitles = recentTitles.slice(-15);
    }
    if (publishedNews.length > 100) {
      publishedNews = publishedNews.slice(-100);
    }

    const lastMsg = newMessages[newMessages.length - 1];
    state.RECENT_TITLES = recentTitles;
    state.PUBLISHED_NEWS = publishedNews;
    state.LAST_PROCESSED_SNIPPET = lastMsg.text.trim().substring(0, 50);
    saveState(state);

    console.log("🎉 تمام شد!");
  } catch (error) {
    console.log("❌ خطا:", error.message);
  }
}

// ==========================================// حلقه خودکار (هر ۱۵ دقیقه)
// ==========================================
const INTERVAL_MINUTES = 15;

async function runOnce() {
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  console.log('\n🕐 [' + time + '] شروع اجرا...');
  await main();
  console.log('⏰ اجرای بعدی: ' + INTERVAL_MINUTES + ' دقیقه دیگر');
}

// اجرای اولیه فوراً
runOnce().then(() => {
  // حلقه خودکار
  setInterval(() => {
    runOnce();
  }, INTERVAL_MINUTES * 60 * 1000);
});
