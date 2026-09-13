#!/usr/bin/env node
// تست کلید Groq API
// نحوه استفاده: GROQ_API_KEY=YOUR_KEY node test-groq-key.js

const https = require('https');

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

if (!GROQ_API_KEY) {
  console.log('❌ GROQ_API_KEY تنظیم نشده!');
  console.log('نحوه اجرا: GROQ_API_KEY=YOUR_KEY node test-groq-key.js');
  process.exit(1);
}

console.log('🔑 کلید Groq: ' + GROQ_API_KEY.substring(0, 12) + '...');
console.log('');

const models = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
  'moonshotai/kimi-k2-instruct',
];

async function testModel(model) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: 'بگو سلام' }],
      temperature: 0.1,
      max_tokens: 50,
    });

    const req = https.request({
      hostname: 'api.groq.com',
      port: 443,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_API_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (d.error) {
            resolve({ model, status: '❌', msg: d.error.message || JSON.stringify(d.error) });
          } else if (d.choices && d.choices[0] && d.choices[0].message) {
            resolve({ model, status: '✅', msg: d.choices[0].message.content.substring(0, 50) });
          } else {
            resolve({ model, status: '⚠️', msg: body.substring(0, 100) });
          }
        } catch (e) {
          resolve({ model, status: '⚠️', msg: body.substring(0, 100) });
        }
      });
    });

    req.on('error', (e) => resolve({ model, status: '❌', msg: e.message }));
    req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('تست مدل‌های Groq:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  for (const model of models) {
    const r = await testModel(model);
    console.log(r.status + ' ' + model + ': ' + r.msg);
  }
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('اگر همه ❌ بودن، کلید API معتبر نیست.');
  console.log('اگر بعضی ✅ بودن، اون مدل‌ها کار می‌کنن.');
}

run().catch(e => console.error(e));
