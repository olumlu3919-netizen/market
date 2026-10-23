// whatsappBot.js
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const config = require('./config');

let reconnectTimer = null;
let waState = 'bağlanıyor';

async function startWhatsAppBot(handleCommand) {
    // Oturum klasörü ortama göre ayrı: auth_info_baileys_development / _production
    const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.authDir);
    const sock = makeWASocket({ auth: state });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('📱 WhatsApp QR kodunu telefondan okutun:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            waState = 'açık';
            console.log(`✅ WhatsApp bağlantısı açık (${config.env})`);
        }

        if (connection === 'close') {
            waState = 'koptu';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`Oturum kapatıldı. ${config.whatsapp.authDir} klasörünü silip QR'ı tekrar okutun.`);
                return;
            }
            console.log('WhatsApp bağlantısı koptu, 5 sn sonra tekrar denenecek...');
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => startWhatsAppBot(handleCommand), 5000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const m of messages) {
            try {
                if (!m.message) continue;

                // Sadece tanımlı grup. Grup ID yoksa hiçbir mesaj işlenmez.
                const jid = m.key.remoteJid;
                if (!config.whatsapp.groupId || jid !== config.whatsapp.groupId) continue;

                const text =
                    m.message.conversation ||
                    m.message.extendedTextMessage?.text ||
                    m.message.imageMessage?.caption ||
                    '';
                if (!text.startsWith('!')) continue;

                const user = m.pushName || 'Bilinmiyor';
                const reply = await handleCommand(text, user, 'whatsapp');

                // Cevap Telegram'a değil, mesajın geldiği WhatsApp grubuna gider
                if (reply) await sock.sendMessage(jid, { text: reply }, { quoted: m });
            } catch (error) {
                console.error('WhatsApp mesaj işleme hatası:', error);
            }
        }
    });
}

module.exports = startWhatsAppBot;
module.exports.getStatus = () => waState;