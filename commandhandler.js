// commandHandler.js
// Metin komutları (WhatsApp'ın tamamı, Telegram'ın yedek komutları).
// createCommandHandler(service) -> handleCommand(text, user, where) => cevap metni | null
const { regWork } = require('./parser');

const HELP = [
    '🤖 *MarketBot Komutları*',
    '',
    '📌 *SKT Ekleme*',
    '• `!ekle Pınar Süt 1 L 15.08.2026`',
    '• `!ekle Pınar Süt 1 L 10g` (g=gün, h=hafta, a=ay, y=yıl sonra)',
    '',
    '📌 *Listeleme / Arama*',
    '• `!liste` → önümüzdeki 14 gün',
    '• `!liste 30` → önümüzdeki 30 gün',
    '• `!ara süt` → ürün, fiyat ve SKT bilgisi',
    '',
    '📌 *Düşme*',
    '• `!dus Pınar Süt 1 L` → ürünün tüm kayıtları',
    '• `!dus Pınar Süt 1 L 2` → en yakın SKT\'den 2 adet',
    '• Sonuna neden ekle: `!dus Pınar Süt 1 L 2 iade` (iade / zayi / sat)',
    '',
    '📌 *Sadece Telegram*',
    '• `/menu` → butonlu menü',
    '• Barkod fotoğrafı gönder veya barkod numarasını yaz',
].join('\n');

function fmtPrice(n) {
    return `${Number(n).toFixed(2).replace('.', ',')} ₺`;
}

function statusEmoji(day) {
    if (day <= 0) return '💀';
    if (day <= 3) return '🔴';
    if (day <= 15) return '🟠';
    return '🟢';
}

function createCommandHandler(service) {
    async function add(parsed, user, where) {
        const { productName, category, reminderDay, expirationInfo } = parsed;
        if (!productName || !expirationInfo) {
            return '⚠️ Lütfen geçerli ürün adı ve tarih girin.\nÖrn: `!ekle Pınar Süt 1 L 15.08.2026` veya `!ekle Pınar Süt 1 L 10g`';
        }
        const { product } = await service.ensureProduct({
            name: productName, category, reminderDays: reminderDay, user, source: where,
        });
        const res = await service.addExpiry(String(product._id), expirationInfo.dbDate, 1, user);
        if (res.merged) {
            return `🔁 *${product.productName}* için *${expirationInfo.viewDate}* zaten vardı, adet *${res.total}* oldu.`;
        }
        return `✅ *${product.productName}* eklendi.\n⏳ SKT: *${expirationInfo.viewDate}*`;
    }

    async function list(args) {
        const parsedLimit = parseInt(args[0], 10);
        const days = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 14;
        const records = await service.listExpiring(days);
        if (records.length === 0) return `📋 Önümüzdeki *${days}* gün içinde SKT'si dolacak ürün bulunmuyor.`;

        const MAX = 40;
        let msg = `📋 *Önümüzdeki ${days} Günün SKT Listesi:*\n\n`;
        for (const item of records.slice(0, MAX)) {
            const when = item.remainingDay < 0 ? '*SÜRESİ GEÇTİ*' : `Kalan: *${item.remainingDay} gün*`;
            msg += `${statusEmoji(item.remainingDay)} *${item.productName}* (${item.quantity} adet)\n⏳ ${item.viewDate} • ${when}\n\n`;
        }
        if (records.length > MAX) msg += `… ve *${records.length - MAX}* kayıt daha. Daha dar aralık deneyin: \`!liste 7\``;
        return msg;
    }

    async function find(query) {
        if (!query) return '⚠️ Ne arayayım?\nÖrn: `!ara süt`';
        const results = await service.search(query, 8);
        if (results.length === 0) return `🔎 *${query}* için ürün bulunamadı.`;
        let msg = `🔎 *"${query}" için ${results.length} sonuç:*\n\n`;
        for (const p of results) {
            const entries = service.normalize(p.productInfo);
            const next = entries[0] ? `SKT: ${entries[0].viewDate}` : 'rafta kayıt yok';
            const price = p.price != null ? ` • 💰 ${fmtPrice(p.price)}` : '';
            msg += `📦 *${p.productName}*${price}\n   ${next}\n\n`;
        }
        return msg;
    }

    async function remove(args, user) {
        if (args.length === 0) return '⚠️ Lütfen ürün adını yazın.\nÖrn: `!dus Pınar Süt 1 L`';

        // Son kelime düşme nedeniyse ayır: "pınar süt 2 iade"
        const REASON_WORDS = { iade: 'iade', zayi: 'zayi', bozuk: 'zayi', skt: 'zayi', sat: 'satildi', satildi: 'satildi', 'satıldı': 'satildi' };
        const REASON_TR = { iade: 'iade', zayi: 'zayi', satildi: 'satıldı' };
        let reason;
        if (args.length > 1 && REASON_WORDS[args[args.length - 1]]) {
            reason = REASON_WORDS[args[args.length - 1]];
            args = args.slice(0, -1);
        }
        const why = reason ? ` (${REASON_TR[reason]})` : '';

        // Son kelime adetse ayır: "pınar süt 2"; "bitti/hepsi" ise tümü
        const WHOLE = ['bitti', 'hepsi', 'tümü', 'all', 'ok', 'tamam'];
        let quantity = null;
        let nameArgs = args;
        const last = args[args.length - 1];
        if (args.length > 1 && /^\d{1,4}$/.test(last)) {
            quantity = parseInt(last, 10);
            nameArgs = args.slice(0, -1);
        } else if (args.length > 1 && WHOLE.includes(last)) {
            nameArgs = args.slice(0, -1);
        }
        const query = nameArgs.join(' ');

        const matches = await service.search(query, 6);
        if (matches.length === 0) return `⚠️ *${query}* isimli ürün bulunamadı.`;
        if (matches.length > 1) {
            let msg = `❓ '${query}' ile birden fazla ürün eşleşti:\n\n`;
            matches.forEach((p, i) => { msg += `${i + 1}. \`${p.productName}\`\n`; });
            return msg + '\nHangisi düşülecek? Lütfen tam ürün adını yazın.';
        }

        const ref = String(matches[0]._id);
        if (quantity) {
            const res = await service.removeEarliest(ref, quantity, user, reason);
            if (res.removed === 0) return `⚠️ *${res.product.productName}* için düşülecek kayıt yok.`;
            const left = res.product.productInfo.reduce((s, e) => s + e.quantity, 0);
            const short = res.shortBy > 0 ? `\n⚠️ Stokta sadece ${res.removed} adet vardı.` : '';
            return `📦 *${res.product.productName}*: ${res.removed} adet düşüldü${why}. Kalan: *${left}*${short}`;
        }
        const res = await service.removeExpiry(ref, { all: true, reason }, user);
        return `🗑️ *${res.product.productName}* için tüm SKT kayıtları temizlendi (${res.removed} adet)${why}.`;
    }

    return async function handleCommand(text, user, where) {
        const parsed = regWork(text);
        if (!parsed) return null;
        if (parsed.error) return parsed.error;

        try {
            switch (parsed.command) {
                case '!yardım':
                case '!yardim':
                case '!help':
                    return HELP;
                case '!ekle':
                    return await add(parsed, user, where);
                case '!liste':
                case '!stk':
                    return await list(parsed.args);
                case '!ara':
                    return await find(parsed.args.join(' '));
                case '!dus':
                case '!düs':
                case '!düş':
                    return await remove(parsed.args, user);
                default:
                    return null;
            }
        } catch (error) {
            console.error(`Komut hatası (${parsed.command}):`, error);
            return '❌ İşlem sırasında bir hata oluştu.';
        }
    };
}

module.exports = { createCommandHandler, fmtPrice, statusEmoji };