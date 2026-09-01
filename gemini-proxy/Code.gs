/**
 * Gemini API Proxy
 * این اسکریپت به عنوان واسط بین ربات تلگرام و Gemini API عمل می‌کنه.
 * کلید Gemini در Script Properties ذخیره شده و هرگز در کد یا URL نمایش داده نمی‌شه.
 */

// ==========================================
// درخواست GET - تست سلامت
// ==========================================
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    message: "Gemini Proxy is running",
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// درخواست اصلی - خلاصه‌سازی اخبار
// ==========================================
function doPost(e) {
  try {
    // خواندن درخواست
    const requestData = JSON.parse(e.postData.contents);
    const prompt = requestData.prompt;
    const model = requestData.model || "gemini-2.5-flash";
    
    if (!prompt) {
      return createResponse(400, { error: "prompt is required" });
    }
    
    // خواندن کلید Gemini از Script Properties
    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty("GEMINI_API_KEY");
    
    if (!apiKey) {
      return createResponse(500, { error: "GEMINI_API_KEY not set in Script Properties" });
    }
    
    // فراخوانی Gemini API
    const result = callGeminiAPI(prompt, model, apiKey);
    return createResponse(result.status, result.data);
    
  } catch (err) {
    return createResponse(500, { error: err.message });
  }
}

// ==========================================
// فراخوانی Gemini API
// ==========================================
function callGeminiAPI(prompt, model, apiKey) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey;
  
  const systemMsg = 'You are a senior Persian-language news editor. You write concise Telegram news items. CRITICAL RULES: 1) ONLY output raw JSON. ZERO text before or after. 2) NEVER write analysis, thinking, or reasoning. 3) NEVER explain your work. 4) Copy names EXACTLY from source. 5) Use مجلس not مجلس شورای اسلامی. 6) Start titles with ✴, body paragraphs with 🔸. 7) Body should be 1-2 short paragraphs. 8) Titles MUST be event-focused, NOT quote-style. NEVER start title with a person name followed by colon. 9) Avoid sensational, absurd, or offensive comparisons in titles. Titles should be professional and journalistic. Just output { "news": [...] }';
  
  const payload = {
    contents: [{
      role: "user",
      parts: [{ text: systemMsg + "\n\n" + prompt }]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 16000,
      responseMimeType: "application/json"
    }
  };
  
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  try {
    const response = UrlFetchApp.fetch(url, options);
    const statusCode = response.getResponseCode();
    const responseText = response.getContentText();
    
    if (statusCode === 200) {
      const data = JSON.parse(responseText);
      if (data.candidates && data.candidates[0] && data.candidates[0].content) {
        const content = data.candidates[0].content.parts[0].text;
        return { status: 200, data: { content: content } };
      } else {
        return { status: 500, data: { error: "No content in response", raw: responseText.substring(0, 500) } };
      }
    } else {
      return { status: statusCode, data: { error: "Gemini API error", details: responseText.substring(0, 500) } };
    }
  } catch (err) {
    return { status: 500, data: { error: "Failed to call Gemini API", details: err.message } };
  }
}

// ==========================================
// ساخت پاسخ
// ==========================================
function createResponse(statusCode, data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
