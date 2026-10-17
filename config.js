const path = require('path');

const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';
require('dotenv').config({ path: path.join(__dirname, `.env.${env}`) });

const required = [
  'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'MONGO_URL',
  'DB_NAME', 'API_BASE_URL', 'PUBLIC_URL'
];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Eksik ortam değişkenleri (.env.${env}): ${missing.join(', ')}`);
  process.exit(1);
}

module.exports = Object.freeze({
  env,
  isProd: env === 'production',
  port: Number(process.env.PORT) || 3000,
  publicUrl: process.env.PUBLIC_URL.replace(/\/+$/, ''),
  apiBaseUrl: process.env.API_BASE_URL,
  telegram: {
    token: process.env.TELEGRAM_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  mongo: {
    url: process.env.MONGO_URL,
    dbName: process.env.DB_NAME,
  },
  whatsapp: {
    enabled: process.env.WHATSAPP_ENABLED === 'true',
    groupId: process.env.WHATSAPP_GROUP_ID,
    authDir: `auth_info_baileys_${env}`,
  },
  geminiKey: process.env.GEMINI_API_KEY,
});