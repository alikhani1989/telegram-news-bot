# Gemini Proxy - Google Apps Script

## مراحل راه‌اندازی:

### قدم ۱: ساخت پروژه
1. برو به: https://script.google.com
2. روی **"New Project"** کلیک کن
3. اسم پروژه رو بذار: `GeminiProxy`

### قدم ۲: کد رو کپی کن
- کد `Code.gs` رو کپی کن و جایگزین کد پیش‌فرض کن

### قدم ۳: ذخیره کلید Gemini
1. از منوی سمت چپ روی **"Project Settings"** (آیکون چرخ‌دنده) کلیک کن
2. بخش **"Script Properties"** رو پیدا کن
3. روی **"Add script property"** کلیک کن:
   - **Property:** `GEMINI_API_KEY`
   - **Value:** کلید Gemini خودت (`AQ.Ab8RN6...`)
4. روی **"Save"** کلیک کن

### قدم ۴: Deploy کن
1. روی **"Deploy"** → **"New deployment"** کلیک کن
2. آیکون چرخ‌دنده رو بزن
3. **Type:** روی **"Web app"** بذار
4. **Description:** `Gemini Proxy`
5. **Execute as:** **Me**
6. **Who has access:** **Anyone** (خیلی مهم!)
7. روی **"Deploy"** کلیک کن
8. **آدرس وب‌اپ** رو کپی کن (با `https://script.google.com/macros/s/...` شروع می‌شه)

### قدم ۵: آدرس وب‌اپ رو به کد گیت‌هاب بده
آدرس رو در فایل `config.json` ذخیره کن:
```json
{
  "GEMINI_PROXY_URL": "آدرس وب‌اپ اینجا"
}
```
