// index.js
const config = require('./config'); // env dosyasını yükler, ilk sırada kalmalı
const { MongoClient } = require('mongodb');
const apiStarter = require('./api');
const { initTelegramBot } = require('./telegramBot');
const startWhatsAppBot = require('./whatsappBot');
const startCronScheduler = require('./cronScheduler');

async function main() {
    const client = new MongoClient(config.mongo.url);
    await client.connect();
    console.log(`✅ MongoDB bağlandı | DB: ${config.mongo.dbName} | Ortam: ${config.env}`);

    const db = client.db(config.mongo.dbName);
    apiStarter(db.collection('products'));

    initTelegramBot();

    if (config.whatsapp.enabled) {
        startWhatsAppBot();
    } else {
        console.log('ℹ️ WhatsApp botu bu ortamda kapalı (WHATSAPP_ENABLED=false)');
    }

    startCronScheduler();

    const shutdown = async () => {
        console.log('Kapatılıyor...');
        await client.close().catch(() => { });
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    console.error('Başlatma hatası:', error);
    process.exit(1);
});