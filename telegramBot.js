// telegramBot.js
// Butonlu arayüz: barkod/ad ile ürün kartı -> [SKT Ekle] [Düş] [Fiyat] [Ad] düğmeleri.
// Callback verisi: "<komut>:<ref>[:<arg>]"  (ref = barkod veya ürün _id'si, 64 bayt sınırına uyar)
// node-telegram-bot-api 1.x: { TelegramBot } olarak dışa aktarır. 2.x tamamen farklı bir kütüphanedir, uyumlu değil.
const telegramModule = require('node-telegram-bot-api');
const TelegramBot = telegramModule.TelegramBot || telegramModule.default;
if (typeof TelegramBot !== 'function') {
    throw new Error('node-telegram-bot-api 1.x gerekli. Çalıştır: npm install node-telegram-bot-api@^1.2.0');
}
const axios = require('axios');
const config = require('./config');
const { readBarcodeFromBuffer, isValidBarcode } = require('./barcodeScanner');
const { parseExpiryInput, parsePrice } = require('./parser');
const { remainingDays, relativeKey } = require('./productService');
const { fmtPrice, statusEmoji } = require('./commandHandler');

let bot = null;
let service = null;
let handleCommand = null;

// Bekleyen yazılı girişler: "chatId:userId" -> { type, ref?, barcode?, expires }
const pending = new Map();
const PENDING_TTL = 5 * 60 * 1000;
const REASON_TR = { satildi: 'satıldı', iade: 'iade', zayi: 'zayi' };

// ---------- Küçük yardımcılar ----------
const esc = (s) => String(s ?? '').replace(/([_*`\[])/g, '\\$1');
const displayName = (from) =>
    [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'Bilinmiyor';

function getPending(key) {
    const p = pending.get(key);
    if (!p) return null;
    if (p.expires < Date.now()) { pending.delete(key); return null; }
    return p;
}

// Telegram tek mesajda en fazla 4096 karakter kabul eder
function splitMessage(text, max = 3800) {
    const chunks = [];
    let current = '';
    for (const part of text.split('\n\n')) {
        if (current && (current + '\n\n' + part).length > max) {
            chunks.push(current);
            current = part;
        } else {
            current = current ? current + '\n\n' + part : part;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

// Düz mesaj (uzunsa parçalar). Dev ortamında başına etiket koyar.
async function send(chatId, message) {
    if (!bot) return console.error('Telegram botu henüz başlatılmadı.');
    const text = config.isProd ? message : `🧪 *[DEV]*\n${message}`;
    for (const chunk of splitMessage(text)) {
        try {
            await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Markdown hatası, düz metin deneniyor:', error.message);
            try { await bot.sendMessage(chatId, chunk); } catch (e) { console.error('Mesaj gönderilemedi:', e.message); }
        }
    }
}

// Cron ve diğer modüller için: varsayılan ana gruba gider
async function sendNotification(message, chatId = config.telegram.chatId) {
    await send(chatId, message);
}

// Butonlu mesaj gönder ya da (messageId verilirse) mevcut mesajı güncelle. Başarıyı true/false döner.
async function render(chatId, text, keyboard, messageId) {
    const markup = { inline_keyboard: keyboard || [] };
    const call = (t, extra) => (messageId
        ? bot.editMessageText(t, { chat_id: chatId, message_id: messageId, reply_markup: markup, ...extra })
        : bot.sendMessage(chatId, t, { reply_markup: markup, ...extra }));
    try {
        await call(text, { parse_mode: 'Markdown' });
        return true;
    } catch (e) {
        if (/message is not modified/i.test(e.message)) return true;
        console.error('render hatası, düz metin deneniyor:', e.message);
        try {
            await call(text.replace(/[*_`\\]/g, ''));
            return true;
        } catch (e2) {
            if (/message is not modified/i.test(e2.message)) return true;
            console.error('render başarısız:', e2.message);
            return false;
        }
    }
}

// Kullanıcıdan yazılı giriş iste. force_reply + mention: grupta gizlilik modunda bile cevap bota ulaşır.
async function ask(chatId, from, type, data, text) {
    pending.set(`${chatId}:${from.id}`, { type, ...data, expires: Date.now() + PENDING_TTL });
    const name = displayName(from).replace(/[\[\]_*`]/g, '');
    const opts = { reply_markup: { force_reply: true, selective: true } };
    try {
        await bot.sendMessage(chatId, `[${name}](tg://user?id=${from.id}) ${text}\n_(vazgeçmek için "iptal" yaz)_`, { parse_mode: 'Markdown', ...opts });
    } catch (e) {
        await bot.sendMessage(chatId, text, opts).catch((err) => console.error(err.message));
    }
}

// ---------- Kartlar ----------
function cardText(p) {
    const list = service.normalize(p.productInfo);
    let t = `📦 *${esc(p.productName)}*\n`;
    t += `🏷️ ${esc(p.brand || '-')}`;
    if (p.barcode) t += `  •  🔢 \`${p.barcode}\``;
    t += '\n';
    t += p.price != null ? `💰 ${fmtPrice(p.price)}\n` : '💰 _Fiyat girilmemiş_\n';

    if (list.length === 0) {
        t += '\n📅 _Rafta kayıtlı SKT yok_';
    } else {
        t += '\n📅 *Raftaki SKT\'ler:*\n';
        for (const e of list) {
            const r = remainingDays(e.expirationDate);
            const when = r < 0 ? 'SÜRESİ GEÇTİ' : r === 0 ? 'bugün bitiyor' : `${r} gün`;
            t += `${statusEmoji(r)} ${e.viewDate} • ${e.quantity} adet • ${when}\n`;
        }
    }
    if (!p.barcode) t += '\n⚠️ _Barkodu yok. "🔗 Barkod bağla" ile eşleyebilirsin._';
    if (p.approval?.status === 'pending') t += '\n🕒 _Yeni ürün: yönetici onayı bekliyor_';
    return t;
}

function cardKeyboard(p) {
    const ref = String(p._id);
    const rows = [
        [{ text: '➕ SKT Ekle', callback_data: `a:${ref}` }, { text: '➖ Düş', callback_data: `d:${ref}` }],
        [{ text: '💰 Fiyat', callback_data: `p:${ref}` }, { text: '✏️ Ad', callback_data: `n:${ref}` }],
    ];
    const last = [{ text: '🔄 Yenile', callback_data: `c:${ref}` }];
    if (!p.barcode) last.unshift({ text: '🔗 Barkod bağla', callback_data: `bb:${ref}` });
    rows.push(last);
    return rows;
}

async function showProduct(chatId, ref, messageId) {
    const p = await service.findByRef(ref);
    if (!p) return render(chatId, '❌ Ürün bulunamadı.', [], messageId);
    return render(chatId, cardText(p), cardKeyboard(p), messageId);
}

async function showAddMenu(chatId, ref, messageId) {
    const p = await service.findByRef(ref);
    if (!p) return render(chatId, '❌ Ürün bulunamadı.', [], messageId);
    return render(chatId, `➕ *${esc(p.productName)}*\nSKT seç ya da tarihi yaz:`, [
        [
            { text: '+3 gün', callback_data: `q:${ref}:3g` },
            { text: '+7 gün', callback_data: `q:${ref}:7g` },
            { text: '+14 gün', callback_data: `q:${ref}:14g` },
            { text: '+1 ay', callback_data: `q:${ref}:1a` },
        ],
        [{ text: '⌨️ Tarih / adet yaz', callback_data: `at:${ref}` }],
        [{ text: '⬅️ Geri', callback_data: `c:${ref}` }],
    ], messageId);
}

async function showDeleteMenu(chatId, ref, messageId) {
    const p = await service.findByRef(ref);
    if (!p) return render(chatId, '❌ Ürün bulunamadı.', [], messageId);
    const list = service.normalize(p.productInfo);
    if (list.length === 0) {
        return render(chatId, `📦 *${esc(p.productName)}*\nDüşülecek SKT kaydı yok.`, [[{ text: '⬅️ Geri', callback_data: `c:${ref}` }]], messageId);
    }
    const rows = list.map((e) => [{
        text: `${statusEmoji(remainingDays(e.expirationDate))} ${e.viewDate} • ${e.quantity} adet`,
        callback_data: `x:${ref}:${e.expirationDate}`,
    }]);
    rows.push([{ text: '🗑 Hepsini düş', callback_data: `xz:${ref}` }, { text: '⬅️ Geri', callback_data: `c:${ref}` }]);
    return render(chatId, `➖ *${esc(p.productName)}*\nHangi SKT düşülsün?`, rows, messageId);
}

// Arama sonucu: 1 ürün -> doğrudan; birden fazla -> buton listesi. mode: 'c' kart | 'd' düş menüsü
async function searchAndChoose(chatId, query, mode) {
    const results = await service.search(query, 8);
    if (results.length === 0) return send(chatId, `🔎 *${esc(query)}* için ürün bulunamadı.`);
    if (results.length === 1) {
        const ref = String(results[0]._id);
        return mode === 'd' ? showDeleteMenu(chatId, ref) : showProduct(chatId, ref);
    }
    const rows = results.map((p) => [{ text: p.productName, callback_data: `${mode}:${p._id}` }]);
    return render(chatId, `🔎 *${esc(query)}* için ${results.length} sonuç. Birini seç:`, rows);
}

// Barkod okununca: yerelde varsa kart, yoksa Open Food Facts önerisi, yoksa elle giriş
async function handleBarcode(chatId, barcode) {
    const res = await service.lookup(barcode);

    if (res.source === 'local') return showProduct(chatId, String(res.product._id));

    if (res.source === 'openfoodfacts' && res.product.name) {
        const p = res.product;
        return render(chatId,
            `🌐 *Open Food Facts'te bulundu*\n\n📦 ${esc(p.name)}\n🏷️ ${esc(p.brand || '-')}\n🔢 \`${barcode}\`\n\nKaydedeyim mi?`,
            [
                [{ text: '✅ Kaydet', callback_data: `b:${barcode}` }],
                [{ text: '✏️ Adı kendim yazayım', callback_data: `m:${barcode}` }],
                [{ text: '🔗 Eski ürüne bağla', callback_data: `l:${barcode}` }],
            ]);
    }

    return render(chatId,
        `❌ *Barkod bulunamadı*\n🔢 \`${barcode}\`\n\nBu ürünü ilk kez kaydedebilirsin; sonraki okutmada hazır gelir.`,
        [
            [{ text: '✍️ Ürünü ben gireyim', callback_data: `m:${barcode}` }],
            [{ text: '🔗 Eski ürüne bağla', callback_data: `l:${barcode}` }],
        ]);
}

// Elle yazılan/okunan barkod: kontrol hanesi tutmasa da aranır (bazı iç barkodlar standart dışıdır), sadece uyarılır
async function onBarcodeInput(chatId, code) {
    if (!isValidBarcode(code)) {
        await send(chatId, 'ℹ️ Bu barkodun kontrol hanesi tutmuyor (yanlış yazılmış olabilir). Yine de arıyorum...');
    }
    return handleBarcode(chatId, code);
}

// Mini App'ten (API üzerinden) çağrılır. Mesaj gerçekten gittiyse true döner.
async function sendProductCard(chatId, barcode) {
    try {
        return await handleBarcode(chatId, barcode);
    } catch (e) {
        console.error('Kart gönderilemedi:', e.message);
        return false;
    }
}

async function bindBarcode(chatId, ref, barcode) {
    if (!/^\d{6,14}$/.test(barcode)) return send(chatId, '⚠️ Barkod 6-14 haneli rakamlardan oluşmalı.');
    if (!isValidBarcode(barcode)) await send(chatId, 'ℹ️ Kontrol hanesi tutmuyor, yine de bağlıyorum.');
    const res = await service.attachBarcode(ref, barcode);
    if (res.error === 'DUPLICATE') {
        return send(chatId, `⚠️ Bu barkod zaten *${esc(res.existing.productName)}* ürününe bağlı.`);
    }
    if (res.error) return send(chatId, '❌ Ürün bulunamadı.');
    await send(chatId, '🔗 Barkod bağlandı.');
    return showProduct(chatId, ref);
}

// ---------- Menü ve kamera ----------
async function showMenu(chatId) {
    return render(chatId, '🛒 *MarketBot*\nNe yapmak istersin?', [
        [{ text: '📷 Barkod Tara', callback_data: 'menu:scan' }, { text: '🔎 Ürün Ara', callback_data: 'menu:search' }],
        [{ text: '📋 Yaklaşan SKT', callback_data: 'menu:list' }, { text: '❓ Yardım', callback_data: 'menu:help' }],
    ]);
}

async function sendCameraButton(chatId, chatType) {
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const botUsername = (await bot.getMe()).username;
    // Grupta web_app butonu çalışmaz; BotFather'daki Mini App kısa adı "scanner" olmalı
    const keyboard = isGroup
        ? [[{ text: '📸 Kamerayı Aç', url: `https://t.me/${botUsername}/scanner` }]]
        : [[{ text: '📸 Kamerayla Tara', web_app: { url: `${config.publicUrl}/kamera` } }]];
    return render(chatId, '📷 Barkod okutmak için butona bas.\n_Fotoğraf göndererek veya barkod numarasını yazarak da arayabilirsin._', keyboard);
}

// ---------- Bekleyen yazılı girişler ----------
async function handlePending(chatId, pend, text, user) {
    if (/^(iptal|vazgeç|vazgec)$/i.test(text.trim())) return send(chatId, '👍 İptal edildi.');

    switch (pend.type) {
        case 'addDate': {
            const parsed = parseExpiryInput(text);
            if (parsed.error) return send(chatId, parsed.error);
            const res = await service.addExpiry(pend.ref, parsed.dateKey, parsed.quantity, user);
            if (!res) return send(chatId, '❌ Ürün bulunamadı.');
            await send(chatId, res.merged
                ? `🔁 ${parsed.viewDate} zaten vardı, adet *${res.total}* oldu.`
                : `✅ ${parsed.viewDate} • ${parsed.quantity} adet eklendi.`);
            return showProduct(chatId, pend.ref);
        }
        case 'price': {
            const price = parsePrice(text);
            if (price === null) return send(chatId, '⚠️ Fiyatı anlayamadım. Örn: 42,50');
            await service.updateProduct(pend.ref, { price }, user);
            await send(chatId, `💰 Fiyat ${fmtPrice(price)} olarak kaydedildi.`);
            return showProduct(chatId, pend.ref);
        }
        case 'rename': {
            const res = await service.updateProduct(pend.ref, { name: text }, user);
            if (!res) return send(chatId, '❌ Ürün bulunamadı.');
            if (res.conflict) {
                return send(chatId, `⚠️ Bu adla başka bir ürün zaten var: *${esc(res.conflict.productName)}*. Aynı ürünse \`scripts/dedupe.js\` ile birleştirilebilir.`);
            }
            await send(chatId, '✏️ Ad güncellendi (standart biçime çevrildi).');
            return showProduct(chatId, pend.ref);
        }
        case 'newName': {
            const { product, linked } = await service.ensureProduct({ barcode: pend.barcode, name: text, user, source: 'manual' });
            if (linked) await send(chatId, '🔗 Aynı adlı eski ürün bulundu, barkod ona bağlandı.');
            return showAddMenu(chatId, String(product._id));
        }
        case 'linkSearch': {
            const results = (await service.search(text, 8)).filter((p) => !p.barcode);
            if (results.length === 0) return send(chatId, '🔎 Barkodsuz eşleşen ürün bulunamadı. Başka bir ad dene ya da "✍️ Ürünü ben gireyim" kullan.');
            const rows = results.map((p) => [{ text: p.productName, callback_data: `k:${p._id}:${pend.barcode}` }]);
            return render(chatId, '🔗 Bu barkod hangi ürüne ait?', rows);
        }
        case 'bindBarcode':
            return bindBarcode(chatId, pend.ref, text.trim());
        case 'search':
            return searchAndChoose(chatId, text, 'c');
        default:
            return null;
    }
}

// Mini App yetkisi: kullanıcı ana market grubunun üyesi mi?
async function isChatMember(userId) {
    if (!bot) return false;
    const member = await bot.getChatMember(config.telegram.chatId, userId);
    return ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
}

// ---------- Başlatma ----------
function initTelegramBot(productService, commandHandler) {
    service = productService;
    handleCommand = commandHandler;
    bot = new TelegramBot(config.telegram.token, { polling: true });

    bot.on('polling_error', (error) => console.error('⚠️ Telegram Polling Hatası:', error.code, error.message));

    bot.setMyCommands([
        { command: 'menu', description: 'Ana menü' },
        { command: 'kamera', description: 'Kamerayla barkod tara' },
        { command: 'liste', description: 'Yaklaşan SKT listesi' },
        { command: 'ara', description: 'Ürün ara' },
        { command: 'yardim', description: 'Komut listesi' },
    ]).catch((e) => console.error('Komutlar kaydedilemedi:', e.message));

    // ----- Metin mesajları -----
    bot.on('message', async (msg) => {
        try {
            if (!msg.text) return;
            const chatId = msg.chat.id;
            const from = msg.from || {};
            const user = displayName(from);

            // "/liste 7" -> "!liste 7" (BotFather komutları ve ! komutları aynı yoldan geçer)
            const text = msg.text.trim().replace(/^\/([A-Za-zçğıöşüÇĞİÖŞ]+)(@\w+)?/, (_, c) => `!${c.toLowerCase()}`);

            const key = `${chatId}:${from.id}`;
            const pend = getPending(key);
            if (pend) {
                pending.delete(key);
                if (!text.startsWith('!')) return await handlePending(chatId, pend, text, user);
                // yeni bir komut yazıldı: bekleyen işlem düşer
            }

            if (!text.startsWith('!')) {
                // Özel sohbette düz barkod numarası yazmak yeterli
                if (msg.chat.type === 'private' && /^\d{8,14}$/.test(text)) return await onBarcodeInput(chatId, text);
                return;
            }

            const [cmd, ...rest] = text.split(/\s+/);
            const arg = rest.join(' ').trim();

            switch (cmd.toLowerCase()) {
                case '!start':
                case '!menu':
                    return await showMenu(chatId);
                case '!kamera':
                    return await sendCameraButton(chatId, msg.chat.type);
                case '!ara':
                    if (/^\d{8,14}$/.test(arg)) return await onBarcodeInput(chatId, arg);
                    return arg
                        ? await searchAndChoose(chatId, arg, 'c')
                        : await ask(chatId, from, 'search', {}, '🔎 Aranacak ürün adını yaz:');
                case '!barkod':
                case '!b':
                    if (!/^\d{8,14}$/.test(arg)) return await send(chatId, '⚠️ Örn: `!barkod 8690504008513`');
                    return await onBarcodeInput(chatId, arg);
                case '!dus':
                case '!düs':
                case '!düş':
                    // Sonunda adet/bitti yoksa buton akışı; varsa metin komutu
                    if (arg && !/\s(\d+|bitti|hepsi|tümü|all)$/i.test(` ${arg}`)) {
                        return await searchAndChoose(chatId, arg, 'd');
                    }
                    break;
                default:
                    break;
            }

            const reply = await handleCommand(text, user, 'telegram');
            if (reply) await send(chatId, reply);
        } catch (error) {
            console.error('Telegram mesaj işleme hatası:', error);
        }
    });

    // ----- Fotoğraf: barkod oku -----
    bot.on('photo', async (msg) => {
        const chatId = msg.chat.id;
        const from = msg.from || {};
        try {
            const key = `${chatId}:${from.id}`;
            const pend = getPending(key);
            const wait = await bot.sendMessage(chatId, '🔎 Barkod taranıyor...');

            const fileLink = await bot.getFileLink(msg.photo[msg.photo.length - 1].file_id);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const barcode = await readBarcodeFromBuffer(Buffer.from(response.data));
            bot.deleteMessage(chatId, wait.message_id).catch(() => { });

            if (!barcode) {
                return await send(chatId, '⚠️ Barkod okunamadı. Barkodu yakından, düz ve net çekmeyi dene (yatay çekim daha iyi) ya da numarayı yaz.');
            }
            if (pend?.type === 'bindBarcode') {
                pending.delete(key);
                return await bindBarcode(chatId, pend.ref, barcode);
            }
            await handleBarcode(chatId, barcode);
        } catch (err) {
            console.error('Fotoğraf işleme hatası:', err);
            await send(chatId, '❌ Fotoğraf işlenirken hata oluştu.');
        }
    });

    // ----- Buton tıklamaları -----
    bot.on('callback_query', async (query) => {
        const chatId = query.message?.chat.id;
        const messageId = query.message?.message_id;
        if (!chatId) return;
        const from = query.from;
        const user = displayName(from);
        const [cmd, ref, arg, arg2] = String(query.data || '').split(':');
        let toast;

        try {
            switch (cmd) {
                case 'c':
                    await showProduct(chatId, ref, messageId);
                    break;
                case 'a':
                    await showAddMenu(chatId, ref, messageId);
                    break;
                case 'q': { // hızlı tarih: q:<ref>:7g
                    const m = String(arg).match(/^(\d+)([ghay])$/);
                    if (!m) break;
                    const res = await service.addExpiry(ref, relativeKey(parseInt(m[1], 10), m[2]), 1, user);
                    toast = res?.merged ? `🔁 Aynı tarih vardı, adet ${res.total}` : '✅ SKT eklendi';
                    await showProduct(chatId, ref, messageId);
                    break;
                }
                case 'at':
                    await ask(chatId, from, 'addDate', { ref }, '📅 Tarihi yaz (örn: 15.08.2026, 10g, 2a). Adet için sonuna ekle: `15.08.2026 6`');
                    break;
                case 'd':
                    await showDeleteMenu(chatId, ref, messageId);
                    break;
                case 'x': { // belirli SKT: önce düşme nedeni sorulur
                    const p = await service.findByRef(ref);
                    const entry = p && service.normalize(p.productInfo).find((e) => e.expirationDate === arg);
                    if (!entry) { toast = 'Kayıt bulunamadı'; await showDeleteMenu(chatId, ref, messageId); break; }
                    const n = entry.quantity;
                    const rows = n > 1
                        ? [
                            [{ text: '✅ Satıldı −1', callback_data: `r:${ref}:${arg}:s1` }, { text: '✅ Hepsi satıldı', callback_data: `r:${ref}:${arg}:sa` }],
                            [{ text: '↩️ İade −1', callback_data: `r:${ref}:${arg}:i1` }, { text: '↩️ Hepsi iade', callback_data: `r:${ref}:${arg}:ia` }],
                            [{ text: '🗑 Zayi −1', callback_data: `r:${ref}:${arg}:z1` }, { text: '🗑 Hepsi zayi', callback_data: `r:${ref}:${arg}:za` }],
                        ]
                        : [[
                            { text: '✅ Satıldı', callback_data: `r:${ref}:${arg}:sa` },
                            { text: '↩️ İade', callback_data: `r:${ref}:${arg}:ia` },
                            { text: '🗑 Zayi', callback_data: `r:${ref}:${arg}:za` },
                        ]];
                    rows.push([{ text: '⬅️ Geri', callback_data: `d:${ref}` }]);
                    await render(chatId, `➖ *${esc(p.productName)}*\n${entry.viewDate} • *${n}* adet\nNeden düşülüyor?`, rows, messageId);
                    break;
                }
                case 'r': { // r:<ref>:<tarih>:<neden><adet>  neden: s/i/z, adet: 1 veya a (hepsi)
                    const reason = { s: 'satildi', i: 'iade', z: 'zayi' }[String(arg2)[0]];
                    if (!reason) break;
                    const quantity = String(arg2)[1] === '1' ? 1 : undefined;
                    const res = await service.removeExpiry(ref, { key: arg, quantity, reason }, user);
                    toast = res?.removed ? `✅ ${res.removed} adet düşüldü (${REASON_TR[reason]})` : 'Kayıt bulunamadı';
                    const left = res?.product ? service.normalize(res.product.productInfo).length : 0;
                    if (left) await showDeleteMenu(chatId, ref, messageId);
                    else await showProduct(chatId, ref, messageId);
                    break;
                }
                case 'xz':
                    await render(chatId, 'Tüm kayıtlar düşülsün mü? Neden?', [
                        [
                            { text: '✅ Satıldı', callback_data: `ra:${ref}:s` },
                            { text: '↩️ İade', callback_data: `ra:${ref}:i` },
                            { text: '🗑 Zayi', callback_data: `ra:${ref}:z` },
                        ],
                        [{ text: '⬅️ Geri', callback_data: `d:${ref}` }],
                    ], messageId);
                    break;
                case 'ra': { // ra:<ref>:<neden>  tüm kayıtları düşer
                    const reason = { s: 'satildi', i: 'iade', z: 'zayi' }[arg];
                    if (!reason) break;
                    const res = await service.removeExpiry(ref, { all: true, reason }, user);
                    toast = `🗑 ${res?.removed || 0} adet düşüldü (${REASON_TR[reason]})`;
                    await showProduct(chatId, ref, messageId);
                    break;
                }
                case 'p':
                    await ask(chatId, from, 'price', { ref }, '💰 Fiyatı yaz (örn: 42,50):');
                    break;
                case 'n':
                    await ask(chatId, from, 'rename', { ref }, '✏️ Yeni adı yaz (Marka Ürün Gramaj, örn: Pınar Süt 1 L):');
                    break;
                case 'bb':
                    await ask(chatId, from, 'bindBarcode', { ref }, '🔢 Barkod numarasını yaz ya da barkod fotoğrafı gönder:');
                    break;
                case 'b': { // Open Food Facts'ten kaydet
                    const res = await service.lookup(ref);
                    if (res.source === 'local') { await showProduct(chatId, String(res.product._id), messageId); break; }
                    if (res.source !== 'openfoodfacts' || !res.product.name) {
                        await ask(chatId, from, 'newName', { barcode: ref }, '✍️ Ürün adını yaz (örn: Pınar Süt 1 L):');
                        break;
                    }
                    const p = res.product;
                    const { product, linked } = await service.ensureProduct({
                        barcode: ref, name: p.name, brand: p.brand, source: 'openfoodfacts', user,
                    });
                    toast = linked ? '🔗 Eski ürüne bağlandı' : '✅ Kaydedildi';
                    await showAddMenu(chatId, String(product._id), messageId);
                    break;
                }
                case 'm':
                    await ask(chatId, from, 'newName', { barcode: ref }, '✍️ Ürün adını yaz (örn: Pınar Süt 1 L):');
                    break;
                case 'l':
                    await ask(chatId, from, 'linkSearch', { barcode: ref }, '🔗 Bağlanacak eski ürünün adını yaz:');
                    break;
                case 'k': { // k:<ref>:<barcode>
                    const res = await service.attachBarcode(ref, arg);
                    if (res.error === 'DUPLICATE') { toast = 'Bu barkod başka üründe'; break; }
                    toast = '🔗 Bağlandı';
                    await showProduct(chatId, ref, messageId);
                    break;
                }
                case 'menu':
                    if (ref === 'scan') await sendCameraButton(chatId, query.message.chat.type);
                    else if (ref === 'search') await ask(chatId, from, 'search', {}, '🔎 Aranacak ürün adını yaz:');
                    else if (ref === 'list') await send(chatId, await handleCommand('!liste', user, 'telegram'));
                    else if (ref === 'help') await send(chatId, await handleCommand('!yardim', user, 'telegram'));
                    break;
                default:
                    break;
            }
        } catch (error) {
            console.error('Buton işleme hatası:', error);
            toast = '❌ Hata oluştu';
        } finally {
            bot.answerCallbackQuery(query.id, toast ? { text: toast } : {}).catch(() => { });
        }
    });

    console.log(`✅ Telegram botu başlatıldı (${config.env})`);
}

function getTelegramStatus() {
    return Boolean(bot) && typeof bot.isPolling === 'function' ? bot.isPolling() : false;
}

module.exports = { initTelegramBot, sendNotification, sendProductCard, isChatMember, getTelegramStatus };