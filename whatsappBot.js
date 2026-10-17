const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const axios = require('axios');
const { sendNotification } = require('./telegramBot');
const { regWork } = require('./parser');
const { response } = require('express');



let WHATSAPP_GROUP_ID = process.env.DEV_GROUP_ID;
const MODE = process.env.MODE;
const API_BASE_URL = process.env.API_BASE_URL;


if (MODE === 'dev') {
    WHATSAPP_GROUP_ID = process.env.DEV_GROUP_ID;
} else {
    WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;
}



async function startWhatsappBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: state,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('✅ Bağlantı başarılı! Artık mesajları alabilirsiniz.');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Bağlantı koptu, tekrar deneniyor...');
                startWhatsappBot();
            } else {
                console.log('Oturum kapatıldı. auth_info_baileys klasörünü silip tekrar kodu alın.');
            }
        }

    });


    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        if (!m || !m.message) return;

        if (WHATSAPP_GROUP_ID && m.key.remoteJid !== WHATSAPP_GROUP_ID) return;

        const text = m.message?.conversation || 
                    m.message?.extendedTextMessage?.text || 
                    m.message?.imageMessage?.caption ||
                    "";

        if (!text || !text.startsWith('!')) return;

        const user = messages.pushName

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
                where: 'whatsapp'
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
                await sendNotification(chatId, "❌ SKT listesi çekilirken sunucu hatası oluştu.");
            }
        };

        if (command === '!dus' || command === '!düs') {
            if (args.length === 0) {
                return await sendNotification("⚠️ Lütfen ürün adını ve miktar/durum belirtin.\nÖrn: `!dus Pınar Süt bitti` veya `!dus Pınar Süt 1`");
            };

            try {

                const response = await axios.post(`${API_BASE_URL}/dus`,
                    {
                        productName:productName,
                        piece:'bitti'
                    }
                );

                if(response.data.success){
                    if(response.data.type==='MULTIPLE_MATCH'){
                        let matchMsg = `📱 *WhatsApp İsteği (Marka Eşleşti):*\n'${response.data.brandName}' markasına ait ürünler:\n\n`;
                        response.data.products.forEach((pName, index) => {
                            matchMsg += `${index + 1}. \`${pName}\`\n`;
                        });
                        matchMsg += `\n❓ Hangisi düşülecek? Lütfen tam ürün adını girin.`;
                        return await sendNotification(matchMsg);
                    }

                    await sendNotification(`📱 *WhatsApp Üzerinden Ürün Düşüldü!*\n📦 İşlem: ${response.data.message}`);
                };

            } catch (error) {
                if (error.response && error.response.status === 404) {
                    return await sendNotification(`📱 *WhatsApp İsteği Uyarısı:* *${productName}* isimli ürün bulunamadı.`);
                }
                console.error("WhatsApp Düş API Hatası:", error.response?.data || error.message);
                await sendNotification(`❌ WhatsApp üzerinden gelen \`${text}\` düşüm isteği işlenirken API hatası oluştu.`);
            };

        };

    })
}

module.exports = startWhatsappBot;