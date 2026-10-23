// parser.js
// Komut metnini ve tarih/fiyat girişlerini ayrıştırır. Tüm "bugün" hesapları İstanbul saatine göredir.

const CATEGORIES = {
    milk: 4,
    snack: 7,
    delicatessen: 3,
    drinks: 14,
    legumes: 30,
    cleaning: 60,
    std: 7,
};

const TURKISH_CATEGORIES = {
    'süt': 'milk', 'sut': 'milk', 'laktozsuz sut': 'milk', 'laktozsuz süt': 'milk',
    'yoğurt': 'milk', 'yogurt': 'milk', 'ayran': 'milk', 'kefir': 'milk',
    'şarküteri': 'delicatessen', 'sarkuteri': 'delicatessen', 'peynir': 'delicatessen',
    'pey': 'delicatessen', 'peyniri': 'delicatessen', 'kaşar': 'delicatessen',
    'kasar': 'delicatessen', 'zeytin': 'delicatessen', 'sucuk': 'delicatessen',
    'kangal': 'delicatessen', 'sosis': 'delicatessen', 'salam': 'delicatessen',
    'tereyağı': 'delicatessen', 'tereyagi': 'delicatessen', 'tereyag': 'delicatessen',
    'tereyağ': 'delicatessen', 'kahvaltılık': 'delicatessen', 'kahvaltilik': 'delicatessen',
    'atıştırmalık': 'snack', 'atistirmalik': 'snack', 'aburcubur': 'snack',
    'bisküvi': 'snack', 'çikolata': 'snack', 'cikolata': 'snack', 'kruvasan': 'snack',
    'çik': 'snack', 'cips': 'snack', 'kraker': 'snack', 'içecek': 'drinks',
    'icecek': 'drinks', 'su': 'drinks', 'kola': 'drinks', 'madensuyu': 'drinks',
    'meyvesuyu': 'drinks', 'bakliyat': 'legumes', 'kuru': 'legumes',
    'kurutulmuş': 'legumes', 'kurutulmus': 'legumes', 'makarna': 'legumes',
    'un': 'legumes', 'şeker': 'legumes', 'seker': 'legumes', 'yağ': 'legumes',
    'yag': 'legumes', 'temizlik': 'cleaning', 'camasir': 'cleaning',
    'çamaşır': 'cleaning', 'kozmetik': 'cleaning', 'deterjan': 'cleaning',
    'sabun': 'cleaning', 'şampuan': 'cleaning', 'sampuan': 'cleaning',
    'standart': 'std', 'std': 'std', 'normal': 'std',
};

function istanbulToday() {
    const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' })
        .format(new Date()).split('-').map(Number);
    return { y, m, d };
}

// Ürün adındaki kelimelerden kategori ve hatırlatma gününü tahmin eder
function guessCategory(name) {
    const words = String(name || '').toLocaleLowerCase('tr-TR').split(/\s+/).filter(Boolean);
    for (const w of words) {
        const cat = TURKISH_CATEGORIES[w];
        if (cat) return { category: cat, reminderDay: CATEGORIES[cat] };
    }
    return { category: 'std', reminderDay: CATEGORIES.std };
}

function ExpirationDateCalculater(dateData) {
    if (!dateData) return null;
    const t = istanbulToday();
    let date = new Date(Date.UTC(t.y, t.m - 1, t.d));

    if (dateData.type === 'relative') {
        const n = dateData.num;
        if (dateData.unit === 'g') date.setUTCDate(date.getUTCDate() + n);
        else if (dateData.unit === 'h') date.setUTCDate(date.getUTCDate() + n * 7);
        else if (dateData.unit === 'a') date.setUTCMonth(date.getUTCMonth() + n);
        else if (dateData.unit === 'y') date.setUTCFullYear(date.getUTCFullYear() + n);
    } else if (dateData.type === 'exact') {
        date = new Date(Date.UTC(dateData.year, dateData.month - 1, dateData.day));
    }

    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return {
        dbTimestamp: date.getTime(),
        dbDate: `${yyyy}-${mm}-${dd}`,
        viewDate: `${dd}/${mm}/${yyyy}`,
    };
}

// "5g" "2h" "3a" "1y" veya 15.08.2026 / 15.08 / 08.2026
// Döner: null (tarih değil) | { error } | { data }
function parseDateToken(token) {
    const rel = token.match(/^(\d+)([ghay])$/);
    if (rel) return { data: { type: 'relative', num: parseInt(rel[1], 10), unit: rel[2] } };

    const parts = token.split(/[.\-\/]/);
    if (parts.length < 2 || parts.length > 3 || !parts.every((x) => /^\d+$/.test(x))) return null;

    const t = istanbulToday();
    let day, month, year;
    if (parts.length === 3) {
        [day, month, year] = parts.map(Number);
    } else {
        const second = parseInt(parts[1], 10);
        if (second > 12 || parts[1].length === 4) {
            day = 1; month = parseInt(parts[0], 10); year = second;
        } else {
            day = parseInt(parts[0], 10); month = second; year = t.y;
        }
    }
    if (year < 100) year += 2000;

    const check = new Date(Date.UTC(year, month - 1, day));
    if (month < 1 || month > 12 || check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) {
        return { error: '⚠️ Geçersiz tarih. Örn: 15.08.2026' };
    }
    if (year * 10000 + month * 100 + day < t.y * 10000 + t.m * 100 + t.d) {
        return { error: '⚠️ Tarih geçmişte kalmış. Lütfen ileri bir tarih girin.' };
    }
    return { data: { type: 'exact', day, month, year } };
}

function regWork(p) {
    if (!p || !p.startsWith('!')) return null;
    p = p.toLocaleLowerCase('tr-TR');
    const words = p.trim().split(/\s+/);
    const command = words[0];
    const args = words.slice(1);

    let productName = null;
    let dateData = null;

    if (args.length > 0) {
        const parsed = parseDateToken(args[args.length - 1]);
        if (parsed?.error) return { error: parsed.error };
        if (parsed?.data) {
            dateData = parsed.data;
            productName = args.slice(0, -1).join(' ');
        } else {
            productName = args.join(' ');
        }
    }

    const { category, reminderDay } = guessCategory(productName);
    const brand = productName ? productName.split(/\s+/)[0] : null;

    return {
        command,
        args,
        productName,
        category,
        reminderDay,
        brand,
        expirationInfo: ExpirationDateCalculater(dateData),
    };
}

// Butonlu akışta kullanıcı "15.08.2026", "10g" veya "15.08.2026 6" (tarih + adet) yazar
function parseExpiryInput(text) {
    const tokens = String(text).trim().split(/\s+/).filter(Boolean);
    let quantity = 1;
    if (tokens.length === 2 && /^\d{1,4}$/.test(tokens[1])) quantity = parseInt(tokens.pop(), 10);
    if (tokens.length !== 1 || quantity < 1) {
        return { error: '⚠️ Tarihi anlayamadım. Örn: 15.08.2026, 10g, 2a ya da adetle: 15.08.2026 6' };
    }
    const r = regWork('!t ' + tokens[0]);
    if (r?.error) return { error: r.error };
    if (!r?.expirationInfo) {
        return { error: '⚠️ Tarihi anlayamadım. Örn: 15.08.2026, 10g, 2a ya da adetle: 15.08.2026 6' };
    }
    return { dateKey: r.expirationInfo.dbDate, viewDate: r.expirationInfo.viewDate, quantity };
}

// "42,50" | "42.5" | "1.250,50" -> sayı
function parsePrice(text) {
    let s = String(text).replace(/[^\d,.]/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return null;
    return Math.round(n * 100) / 100;
}

module.exports = { regWork, ExpirationDateCalculater, guessCategory, parseExpiryInput, parsePrice };