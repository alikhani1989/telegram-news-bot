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
const DUPLICATE_WINDOW_MS = 60 * 60 * 1000;

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
    const html = await httpGet(url);
    const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    if (ogMatch) return ogMatch[1];
    const twitterMatch = html.match(/<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"/i);
    if (twitterMatch) return twitterMatch[1];
    return null;
  } catch (err) {
    return null;
  }
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
// Groq API
// ==========================================
async function callGroq(prompt) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
  if (!GROQ_API_KEY) return null;
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const payload = JSON.stringify({
    model: "llama-3.1-8b-instant",
    messages: [
      { role: "system", content: "You are a Persian news editor. CRITICAL: 1) Copy person names EXACTLY from source. 2) Use مجلس not مجلس شورای اسلامی. OUTPUT ONLY VALID JSON, no explanation." },
      { role: "user", content: prompt }
    ],
    temperature: 0.1,
    max_tokens: 4000,
  });
  const response = await Promise.race([
    httpPost(url, payload, { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_API_KEY }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 240000))
  ]);
  const data = JSON.parse(response);
  if (data.error) throw new Error("Groq Error: " + JSON.stringify(data.error));
  const content = data.choices[0].message.content;
  if (!content || content.trim().length === 0) throw new Error("Groq پاسخ خالی");
  return content;
}

// ==========================================
// OpenRouter API
// ==========================================
const AI_MODELS = [
  // اولویت اول: poolside (کار می‌کنه)
  'poolside/laguna-s-2.1:free',
  // اولویت دوم: مدل‌های NVIDIA (اگر poolside خطا داد)
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
  // اولویت سوم: مدل‌های دیگر
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m3:free',
];

async function callOpenRouter(prompt, apiKey) {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const systemMsg = "You are a senior Persian-language news editor. You write concise Telegram news items. CRITICAL RULES: 1) ONLY output raw JSON. ZERO text before or after. 2) NEVER write analysis, thinking, or reasoning. 3) NEVER explain your work. 4) Copy names EXACTLY from source. 5) Use مجلس not مجلس شورای اسلامی. 6) Start titles with ✴, body paragraphs with 🔸. 7) Body should be 1-2 short paragraphs. Just output { \"news\": [...] }";

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
      max_tokens: 12000,
      response_format: { type: "json_object" },
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await Promise.race([
          httpPost(url, payload, {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 180000))
        ]);
        const data = JSON.parse(response);
        if (data.error) {
          console.log("  ⚠️ خطا از " + model + ": " + (data.error.message || JSON.stringify(data.error)));
          break;
        }
        const content = data.choices[0].message.content;
        if (!content || content.trim().length === 0) {
          console.log("  ⚠️ پاسخ خالی از " + model);
          break;
        }
        console.log("  ✅ مدل " + model + " پاسخ داد");
        return content;
      } catch (e) {
        console.log("  ⚠️ خطا: " + e.message);
        if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  throw new Error("همه مدل‌ها ناموفق بودند.");
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
  p.push("=== قوانین تیتر ===");
  p.push("- کوتاه، رویدادمحور، با ✴️ شروع شود");
  p.push("- بدون نقل قول و بدون نام شخص");
  p.push("- تیتر باید مفهوم درست خبر را برساند");
  p.push("");
  p.push("=== قوانین متن ===");
  p.push("- ۱ یا ۲ بند کوتاه (بستگی به محتوا دارد)");
  p.push("- هر بند با 🔸 و یک فاصله شروع شود");
  p.push("- خط اول: نام + سمّت دقیق شخص");
  p.push("- حوزه انتخابیه نیاید (فقط «نماینده مجلس»)");
  p.push("- سمّت تکرار نشود (عضو کمیسیون X مجلس → عضو کمیسیون X)");
  p.push("- نکته اصلی خبر را با جزئیات بیان کنید (اعداد، شروط، ارقام مهم)");
  p.push("");
  p.push("=== قوانین ذکر منبع ===");
  p.push("- فقط وقتی «مصاحبه» یا «گفتگو» بیاید که متن اصلی دقیقاً همین را نوشته باشد.");
  p.push("- اگر رسانه فقط خبر را نقل کرده (گزارش، بازدید، نشست)، منبع نیاورید.");
  p.push("");
  p.push("=== جلوگیری از تکرار ===");
  p.push("- عناوین اخیر فقط برای تشخیص تکراری هستند.");
  p.push("");
  p.push("=== فرمت خروجی ===");
  p.push('فقط JSON Object. هیچ متن خارج از JSON تولید نکنید.');
  p.push('{"news":[{"title":"✴️ تیتر","body":"🔸 جمله اول.\\n\\n🔸 جمله دوم.","source_link":"لینک","image_url":"لینک یا خالی"]}');
  p.push("");
  p.push("=== نمونه ===");
  p.push("");
  p.push("تیتر: ✴️ در آستانه توافق");
  p.push("🔸 فداحسین مالکی عضو کمیسیون امنیت ملی مجلس در مصاحبه با خبرگزاری دانشجو گفت ایران و عمان بر مسیر پیشنهادی ایران تمرکز کرده‌اند.");
  p.push("");
  p.push("🔸 مالکی گفته در صورت تحقق توافق، کنترل تنگه هرمز کماکان در اختیار ایران خواهد بود.");
  p.push("");
  p.push("تیتر: ✴️ بنزین گران نخواهد شد");
  p.push("🔸 علی نیکزاد نایب‌رئیس مجلس گفت افزایش قیمت بنزین منتفی است و جابه‌جایی سهمیه انجام می‌شود.");
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
function safeParseJson(rawText) {
  if (!rawText || rawText.trim().length === 0) return [];
  var raw = rawText;

  // Step 1: Strip thinking text. The model often writes analysis before JSON.
  // Find the ACTUAL JSON start: first {"news" or first { before "news"
  var t = raw;
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
          return obj.news;
        }
      } catch (e) {
        // Try cleaning control chars
        var cleaned = candidate.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");
        try {
          var obj2 = JSON.parse(cleaned);
          if (obj2 && Array.isArray(obj2.news)) {
            console.log("  \u2705 JSON OK (cleaned, " + obj2.news.length + " news)");
            return obj2.news;
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
        return obj3.news;
      }
      if (Array.isArray(obj3)) return obj3;
    } catch (e) {}
  }

  console.log("  \u274c JSON parse failed (" + raw.length + " chars)");
  console.log("  First 300:", raw.substring(0, 300));
  console.log("  Last 300:", raw.substring(Math.max(0, raw.length - 300)));
  return [];
}


// ==========================================// تابع اصلی
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
    } else if (newMessages.length > 3) {
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
    const MAX_RSS = 3; // حداکثر ۶ خبر RSS (۲ تا ICANA + ۴ تا بقیه)
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
    const aiText = await callOpenRouter(prompt, OPENROUTER_API_KEY);
    console.log("⏱️ پاسخ در " + ((Date.now() - startTime) / 1000).toFixed(1) + " ثانیه.");

    if (!aiText || aiText.trim().length === 0) { console.log("❌ پاسخ خالی."); return; }
    console.log("📝 پاسخ (" + aiText.length + " کاراکتر)");

    const newsArray = safeParseJson(aiText);
    if (newsArray === null) { console.log("❌ خطا در پارس JSON"); return; }
    if (newsArray.length === 0) { console.log("📭 خبری تولید نشد."); return; }

    // بازیابی عکس - اولویت: OG تصویر مقاله > عکس تلگرام
    for (let i = 0; i < newsArray.length; i++) {
      const item = newsArray[i];
      const originalMsg = newMessages[i];
      
      // ۱. اگر عکس از AI اومده و معتبره، استفاده کن
      let hasValidImage = item.image_url && item.image_url.startsWith("http") && !item.image_url.includes("telesco.pe") && item.image_url.length > 20;
      
      // ۲. اگر عکس معتبر نیست، از OG تصویر مقاله استفاده کن
      if (!hasValidImage && item.source_link && item.source_link.startsWith("http")) {
        console.log("  🔍 دریافت عکس OG از مقاله:", item.source_link.substring(0, 50));
        const ogImage = await fetchOgImage(item.source_link);
        if (ogImage && ogImage.startsWith("http") && ogImage.length > 20 && !ogImage.includes("telesco.pe")) {
          item.image_url = ogImage;
          hasValidImage = true;
          console.log("  📷 عکس OG مقاله پیدا شد");
        }
      }
      
      // ۳. اگر هنوز عکس نداریم، از تلگرام استفاده کن (فقط اگر cdn باشد)
      if (!hasValidImage && originalMsg && originalMsg.imageUrl) {
        const tgImg = originalMsg.imageUrl;
        // فقط عکس‌های cdn قابل اعتماد هستند (نه عکس کاربر)
        if (tgImg.startsWith("http") && (tgImg.includes("cdn") || tgImg.includes("t.me"))) {
          item.image_url = tgImg;
          hasValidImage = true;
          console.log("  📷 عکس از تلگرام (CDN):", tgImg.substring(0, 50));
        } else {
          console.log("  ⛔ عکس تلگرام رد شد (cdn نیست):", tgImg.substring(0, 50));
          item.image_url = "";
        }
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

      item.body = item.body.replace(/مجلس شورای اسلامی/g, "مجلس");
      item.title = item.title.replace(/مجلس شورای اسلامی/g, "مجلس");
      item.body = item.body.replace(/صفطولانی/g, "صف طولانی");
      // حذف «مصاحبه» اشتباه اگر خبر فقط گزارش بازدید/نشست باشد
      if (item.body.includes('بازدید') && item.body.includes('مصاحبه')) {
        item.body = item.body.replace(/در مصاحبه با [^،,]+ /g, '');
        item.body = item.body.replace(/در گفتگو با [^،,]+ /g, '');
      }
      // حذف حوزه انتخابیه: نماینده مردم X، Y و Z در مجلس → نماینده مجلس
      item.body = item.body.replace(/نماینده مردم [^،,]+ در مجلس/g, 'نماینده مجلس');
      // حذف تکرار مجلس: عضو کمیسیون X مجلس → عضو کمیسیون X
      item.body = item.body.replace(/مجلس مجلس/g, 'مجلس');

      let finalMessage = "<b>" + item.title + "</b>\n\n" + item.body + "\n\n🇮🇷 این خانه #ازما ست\n🔰 @azmaa_net";
      if (item.source_link && item.source_link.length > 5) {
        finalMessage += '\n\n🔗 <a href="' + item.source_link + '">منبع خبر</a>';
      }

      const imageUrl = item.image_url && item.image_url.startsWith("http") && item.image_url.length > 20 ? item.image_url : null;
      const result = await sendToTelegram(finalMessage, imageUrl, BOT_TOKEN, DESTINATION_CHAT_ID);

      if (result.ok) {
        console.log("  ✅ " + item.title.replace("✴️ ", ""));
        recentTitles.push(item.title.replace(/<[^>]*>/gm, "").replace("✴️ ", ""));
        publishedNews.push({
          title: item.title.replace(/<[^>]*>/gm, ""),
          source_link: item.source_link || "",
          timestamp: Date.now()
        });
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
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  console.log('\n🕐 [' + time + '] شروع اجرا...');
  await main();
  console.log('⏰ اجرای بعدی: ' + INTERVAL_MINUTES + ' دقیقه دیگر');
}

runOnce().then(() => {
  setInterval(() => { runOnce(); }, INTERVAL_MINUTES * 60 * 1000);
});
