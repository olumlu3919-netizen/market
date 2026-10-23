// index.js
const config = require('./config'); // env dosyasını yükler, ilk sırada kalmalı
const { MongoClient } = require('mongodb');
const apiStarter = require('./api');
const { initTelegramBot, isChatMember, getTelegramStatus } = require('./telegramBot');
const startWhatsAppBot = require('./whatsappBot');
const startCronScheduler = require('./cronScheduler');
const { createProductService } = require('./productService');
const { createCommandHandler } = require('./commandHandler');
const { createAdminAuth } = require('./AdminAuth');

async function main() {
    const client = new MongoClient(config.mongo.url);
    await client.connect();
    console.log(`✅ MongoDB bağlandı | DB: ${config.mongo.dbName} | Ortam: ${config.env}`);

    const db = client.db(config.mongo.dbName);
    const service = createProductService(db);
    await service.init();

    const admin = createAdminAuth(db);
    await admin.init();

    const handleCommand = createCommandHandler(service);

    apiStarter(service, {
        isMember: isChatMember,
        admin,
        getStatus: () => ({
            telegram: getTelegramStatus(),
            whatsapp: { enabled: config.whatsapp.enabled, state: config.whatsapp.enabled ? startWhatsAppBot.getStatus() : 'kapalı' },
        }),
    });
    initTelegramBot(service, handleCommand);

    if (config.whatsapp.enabled) {
        startWhatsAppBot(handleCommand);
    } else {
        console.log('ℹ️ WhatsApp botu bu ortamda kapalı (WHATSAPP_ENABLED=false)');
    }

    startCronScheduler(service);

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