// nameUtils.js
// Ürün adı standardı: "Marka Ürün Gramaj"  ->  "Pınar Süt 1 L"
// buildNameKey: aynı ürünün farklı yazımlarını aynı anahtara indirger (eşleştirme için)
// formatName: kullanıcıya gösterilecek standart ad

const TR = 'tr-TR';

// 1 lt / 1l / 1 litre -> "1 L" | 500 gr / 500g -> "500 g" | 1 kilo -> "1 kg" | 200 ML -> "200 ml"
function normalizeUnits(str) {
    const num = '(\\d+(?:[.,]\\d+)?)';
    const end = '(?![a-zA-ZçğıöşüÇĞİÖŞÜ])';
    const dot = (n) => n.replace(',', '.');
    return String(str)
        .replace(new RegExp(`${num}\\s*(?:mililitre|ml)${end}`, 'gi'), (_, n) => `${dot(n)} ml`)
        .replace(new RegExp(`${num}\\s*(?:litre|lt|l)${end}`, 'gi'), (_, n) => `${dot(n)} L`)
        .replace(new RegExp(`${num}\\s*(?:kilogram|kilo|kg)${end}`, 'gi'), (_, n) => `${dot(n)} kg`)
        .replace(new RegExp(`${num}\\s*(?:gram|gr|g)${end}`, 'gi'), (_, n) => `${dot(n)} g`);
}

function foldTurkish(s) {
    return s
        .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
        .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');
}

function buildNameKey(name) {
    let s = normalizeUnits(name).toLocaleLowerCase(TR);
    s = foldTurkish(s);
    s = s.replace(/[^a-z0-9. ]/g, ' ');              // noktalama, tire, parantez
    s = s.replace(/(?<!\d)\.|\.(?!\d)/g, ' ');        // sayı dışındaki noktalar
    s = s.replace(/(\d)\s+(l|ml|kg|g)\b/g, '$1$2');   // "1 l" -> "1l"
    return s.split(/\s+/).filter(Boolean).sort().join(' ');  // kelime sırası fark etmesin
}

const UNIT_CANON = { l: 'L', ml: 'ml', kg: 'kg', g: 'g' };

function formatName(name) {
    const tokens = normalizeUnits(name).replace(/[()\[\]]/g, ' ').trim().split(/\s+/).filter(Boolean);
    return tokens.map((tok, i) => {
        const lower = tok.toLocaleLowerCase(TR);
        const prevIsNumber = i > 0 && /^\d+(\.\d+)?$/.test(tokens[i - 1]);
        if (prevIsNumber && UNIT_CANON[lower]) return UNIT_CANON[lower];
        if (/^\d/.test(tok)) return tok;
        return lower.charAt(0).toLocaleUpperCase(TR) + lower.slice(1);
    }).join(' ');
}

// Dice katsayısı (0-1): iki anahtarın benzerliği
function similarity(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = (s) => {
        const m = new Map();
        for (let i = 0; i < s.length - 1; i++) {
            const g = s.slice(i, i + 2);
            m.set(g, (m.get(g) || 0) + 1);
        }
        return m;
    };
    const A = grams(a);
    const B = grams(b);
    let overlap = 0;
    for (const [g, c] of A) overlap += Math.min(c, B.get(g) || 0);
    return (2 * overlap) / (a.length - 1 + b.length - 1);
}

module.exports = { normalizeUnits, buildNameKey, formatName, similarity };