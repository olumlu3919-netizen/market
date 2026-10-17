const { TelegramBot } = require('node-telegram-bot-api');
const axios = require('axios');
const { regWork } = require('./parser');
const { readBarcodeFromBuffer } = require('./barcodeScanner');
const fetch = require('node-fetch');

let my_chatId = process.env.TELEGRAM_ID;
let DOMAIN_URL = process.env.DOMAIN_URL;
let telegramBotToken = process.env.TELEGRAM_TOKEN;
const MODE = process.env.MODE;
const API_BASE_URL = process.env.API_BASE_URL;
if (MODE === 'dev') {
    DOMAIN_URL = process.env.DOMAIN_URL_DEV;
    my_chatId = process.env.TELEGRAM_DEV_ID;
    telegramBotToken = process.env.TELEGRAM_TOKEN_DEV;
} 




const bot = new TelegramBot(telegramBotToken, { polling: true });

async function sendNotification(message) {

    try {
        console.log(message)
        await bot.sendMessage(my_chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        await bot.sendMessage(my_chatId, error, { parse_mode: 'Markdown' });
        console.error(error);
    }
}


function initTelegramBot() {

    bot.on('polling_error', (error) => {
        console.error('⚠️ Telegram Polling Hatası:', error.code, error.message);
    });

    bot.on('webhook_error', (error) => {
        console.error('⚠️ Telegram Webhook Hatası:', error.code, error.message);
    });

    bot.on('message', async (msg) => {
        const text = msg.text;
        const user = msg.from.first_name + " " + msg.from.last_name
        const webAppData = msg.web_app_data || msg.service?.web_app_data || msg.reply_to_message?.web_app_data;

        if (!text || !text.startsWith('!')) return;

        const {
            command,
            args,
            productName,
            dateData,
            category,
            reminderDay,
            brand,
            expirationInfo
        } = regWork(text);

        bot.onText(/(?:[\/!]?kamera|@\w+_bot)/i, async (msg) => {
            const chatId = msg.chat?.id;
            if (!chatId) return;

            const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

            let rawDomain = DOMAIN_URL || 'https://luminainteractive.site';
            let cleanDomain = String(rawDomain).trim().replace(/[\r\n\t]/g, '').replace(/\/$/, '');

            if (!cleanDomain.startsWith('https://')) {
                cleanDomain = 'https://' + cleanDomain.replace(/^http:\/\//, '');
            }

            const webAppUrl = `${cleanDomain}/kamera`;
            // BotFather'da oluşturduğunuz bot kullanıcı adı (Örn: test_market_bot)
            const botUsername = (await bot.getMe()).username;

            console.log(`[DEBUG] WebApp URL: "${webAppUrl}" | ChatID: ${chatId} | Tip: ${isGroup ? 'GRUP' : 'ÖZEL'}`);

            // Grupta ise Telegram Mini App direct linki kullanır (Çökmez ve doğrudan Telegram içinde açar)
            // Özel sohbette ise doğrudan WebApp butonunu kullanır
            const inlineKeyboard = isGroup
                ? [
                    [
                        {
                            text: "📸 Telegram Kamerasını Aç",
                            url: `https://t.me/${botUsername}/scanner` // BotFather Short Name "kamera" ise
                        }
                    ]
                ]
                : [
                    [
                        {
                            text: "📸 Telegram Kamerasıyla Tara",
                            web_app: { url: webAppUrl }
                        }
                    ]
                ];

            try {
                await bot.sendMessage(chatId, "📷 Telegram içi kamera ile barkod okutmak için aşağıdaki butona basın:", {
                    reply_markup: JSON.stringify({
                        inline_keyboard: inlineKeyboard
                    })
                });
                console.log("✅ Kamera butonu mesajı başarıyla gönderildi!");
            } catch (err) {
                console.error("❌ Kamera Butonu Gönderme Hatası:", err.response?.body || err.message);
            }
        });

        if (command === '!yardım' || command === '!yardim' || command === '!help') {
            try {
                const response = await axios.get(`${API_BASE_URL}/yardim`);

                if (response.data.success) {
                    const helpData = response.data.data;

                    let messageText = `🤖 *${helpData.title}*\n\n_${helpData.description}_\n\n`;

                    helpData.categories.forEach(caty => {
                        messageText += `📌 *${caty.name}*\n`;

                        caty.commands.forEach(c => {
                            messageText += `• \`${c.endpoint}\` -> ${c.description}\n`;
                        });
                        messageText += '\n';
                    });

                    messageText += `💡 _${helpData.hint}_`


                    await sendNotification(messageText)
                }
            } catch (error) {
                console.error("Yardım API Hatası:", error.message);
                await sendNotification(my_chatId, "❌ Yardım menüsü API'den çekilirken bir hata oluştu.");
            }
        };

        if (command === '!ekle') {
            if (!productName || !expirationInfo) {
                return await sendNotification("⚠️ Lütfen geçerli ürün adı ve tarih girin.\nÖrn: `!ekle Pınar Süt 15.08.2026` veya `!ekle Pınar Süt 10g`");
            }

            const payload = {
                productName: productName,
                brand: brand || "",
                productCategory: category || "std",
                productReminder: reminderDay || 7,
                productInfo: [{
                    expirationDate: expirationInfo.dbDate,
                    timestamp: expirationInfo.dbTimestamp,
                    viewDate: expirationInfo.viewDate
                }],
                addedBy: user,
                approver: user,
                where: 'telegram'
            };

            try {

                const response = await axios.post(`${API_BASE_URL}/ekle`, payload);

                if (response.data.success) {

                    return await sendNotification(`✅ *${productName}* ürünü başarıyla eklendi.\n⏳ SKT: *${expirationInfo.viewDate}*`);
                }

            } catch (error) {
                if (error.response && error.response.status === 409) {
                    return await sendNotification(`⚠️ *Zaten Kayıtlı!*\n📦 *${productName}* ürünü için *${expirationInfo.viewDate}* tarihi zaten sistemde var.`);
                }
                console.error("Ekle API Hatası:", error.response?.data || error.message);
                return await sendNotification(`❌ Ürün eklenirken sunucu hatası oluştu.`);
            }
        };

        if (command === '!liste' || command === '!stk') {
            try {
                const limit = args.length > 0 ? parseInt(args[0]) : null;
                const url = (limit && !isNaN(limit)) ? `${API_BASE_URL}/liste?limit=${limit}` : `${API_BASE_URL}/liste`
                const response = await axios.get(url);

                if (response.data.success) {
                    const records = response.data.data;

                    const totalCount = records.length;
                    const slicedData = totalCount > 10 ? records.slice(0, 10) : records;


                    if (!records || records.length === 0) {
                        const emptyMsg = limit
                            ? `📋 Önümüzdeki *${limit}* gün içinde SKT'si dolacak ürün bulunmuyor.`
                            : `📋 Şu anda sistemde listelenecek aktif bir SKT kaydı bulunmuyor.`;
                        return await sendNotification(chatId, emptyMsg);
                    }

                    let messageText = limit
                        ? `📋 *Önümüzdeki ${limit} Günün SKT Listesi:*\n\n`
                        : `📋 *Tüm Aktif SKT Listesi:*\n\n`;
                    records.forEach(item => {
                        let emoji = "🟢";
                        if (item.remainingDay <= 0) emoji = "💀";
                        else if (item.remainingDay <= 3) emoji = "🔴";
                        else if (item.remainingDay <= 15) emoji = "🟠";

                        messageText += `${emoji} *${item.productName}*\n⏳ SKT: ${item.viewDate} (Kalan: *${item.remainingDay} gün*)\n\n`;
                    });

                    await sendNotification(messageText)
                }

            } catch (error) {
                console.error("Liste API Hatası:", error.response?.data || error.message);
                await sendNotification("❌ SKT listesi çekilirken sunucu hatası oluştu.");
            }
        };

        if (webAppData) {
            const barcodeData = msg.web_app_data.data;
            const chatId = msg.chat.id;

            console.log(`📩 WebApp'ten Barkod Geldi [ChatID: ${chatId}]: "${barcodeData}"`);

            // Kullanıcıya arama başlatıldığına dair bilgi mesajı
            const loadingMsg = await bot.sendMessage(chatId, `🔍 **${barcodeData}** barkodu veritabanında sorgulanıyor...`, { parse_mode: 'Markdown' });

            try {
                // Express API servisinize istek atıyoruz (Lokal veya Canlı Domain)
                let rawDomain = DOMAIN_URL || 'http://localhost:3000';
                let cleanDomain = String(rawDomain).trim().replace(/\/$/, '');

                const apiResponse = await fetch(`${cleanDomain}/api/barkod`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        barcode: barcodeData,
                        dateData: new Date().toISOString().split('T')[0] // Örnek tarih
                    })
                });

                const result = await apiResponse.json();

                // Bekliyor mesajını sil
                await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => { });

                if (result.success && result.foundInGlobal) {
                    const { barcode, productName, brand, category } = result.productDetails;

                    // Ürün Bulundu Mesajı
                    const messageText =
                        `✅ **ÜRÜN BULUNDU!**\n\n` +
                        `📦 **Ürün Adı:** ${productName}\n` +
                        `🏷️ **Marka:** ${brand || 'Belirtilmemiş'}\n` +
                        `📂 **Kategori:** ${category || 'Belirtilmemiş'}\n` +
                        `🔢 **Barkod:** \`${barcode}\``;

                    await bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });

                } else {
                    // Ürün Bulunamadı Mesajı
                    const notFoundText =
                        `❌ **ÜRÜN BULUNAMADI**\n\n` +
                        `\`${barcodeData}\` barkodu Open Food Facts veritabanında yer almıyor.\n\n` +
                        `📝 Lütfen bu ürünü sisteme manuel olarak kaydedin.`;

                    await bot.sendMessage(chatId, notFoundText, { parse_mode: 'Markdown' });
                }

            } catch (err) {
                console.error("❌ Barkod Sorgulama Hatası:", err);
                await bot.sendMessage(chatId, "⚠️ Ürün bilgisi sorgulanırken bir sunucu hatası oluştu.");
            }
        }
    });

    bot.on('photo', async (msg) => {

        try {
            await sendNotification("🔎 Görseldeki barkod taranıyor, lütfen bekleyin...");

            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileLink = await bot.getFileLink(fileId);

            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);

            const barcode = await readBarcodeFromBuffer(buffer);

            if (!barcode) {
                return await sendNotification("⚠️ Görselde okunabilir bir barkod bulunamadı. Lütfen net bir fotoğraf gönderin.");
            }

            sendNotification(`Okunan Barkod: ${barcode}`)

        } catch (err) {
            console.log(err)
        }

    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data; // Örn: "add_prod_8690504008513_2026-12-31"

        if (data.startsWith('add_prod_')) {
            const parts = data.split('_');
            const barcode = parts[2];
            const dateData = decodeURIComponent(parts[3]);

            try {
                const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
                const globalData = await response.json();

                if (globalData.status === 1) {
                    const product = globalData.product;
                    const newProduct = {
                        barcode: barcode,
                        productName: product.product_name_tr || product.product_name || "İsimsiz Ürün",
                        brand: product.brands ? product.brands.split(',')[0].trim() : "Genel",
                        category: product.categories ? product.categories.split(',')[0].trim() : "Genel",
                        dateData: dateData !== 'yok' ? dateData : null
                    };

                    await bot.answerCallbackQuery(query.id, { text: "✅ Ürün başarıyla veritabanınıza kaydedildi!" });

                    await bot.editMessageText(
                        `✅ **ÜRÜN VERİTABANINIZA EKLENDİ!**\n\n` +
                        `📦 **Ürün:** ${newProduct.productName}\n` +
                        `🏷️ **Marka:** ${newProduct.brand}\n` +
                        `📂 **Kategori:** ${newProduct.category}\n` +
                        `🔢 **Barkod:** \`${barcode}\`\n\n` +
                        `Artık bu barkod taranınca doğrudan sisteminizden getirilecek.`,
                        {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            parse_mode: 'Markdown'
                        }
                    );
                }
            } catch (err) {
                console.error("Ekleme Hatası:", err);
                await bot.answerCallbackQuery(query.id, { text: "❌ Ekleme başarısız oldu." });
            }
        }
    });

}

module.exports = { initTelegramBot, sendNotification };