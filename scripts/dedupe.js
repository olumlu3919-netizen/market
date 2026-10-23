// scripts/dedupe.js
// Aynı ürünün farklı yazımlarla açılmış kopyalarını TEK kayda birleştirir.
// Mevcut `products` koleksiyonu üzerinde çalışır.
//
//   node scripts/dedupe.js                 -> dry-run: sadece rapor
//   node scripts/dedupe.js --apply         -> yedek alır, birleştirir
//   node scripts/dedupe.js --apply --rename-> ayrıca TÜM ürün adlarını standart biçime çevirir
//
// Hangi DB'de çalışacağı config.js'ten gelir (dev: market_dev, prod: market).
// --apply öncesi koleksiyonun tamamı `products_backup_<tarih>` adıyla kopyalanır.
const { MongoClient } = require('mongodb');
const config = require('../config');
const { buildNameKey, formatName, similarity } = require('../nameUtils');
const { normalizeList } = require('../productService');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const RENAME = argv.includes('--rename');
const FUZZY = 0.85;

function mostCommon(values) {
    const counts = new Map();
    for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

async function main() {
    const client = new MongoClient(config.mongo.url);
    await client.connect();
    const col = client.db(config.mongo.dbName).collection('products');

    console.log(`DB: ${config.mongo.dbName} | ${APPLY ? 'MOD: YAZMA' : 'MOD: DRY-RUN (hiçbir şey değişmeyecek)'}${RENAME ? ' | --rename' : ''}\n`);

    const docs = await col.find({}).toArray();
    const groups = new Map();
    for (const d of docs) {
        if (!d.productName) continue;
        const key = buildNameKey(d.productName);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
    }

    const plans = [];   // birleştirilecek gruplar
    const skipped = []; // farklı barkodlu aynı adlı gruplar: elle bakılmalı
    for (const [nameKey, members] of groups) {
        if (members.length < 2) continue;
        const barcodes = [...new Set(members.map((m) => m.barcode).filter(Boolean))];
        if (barcodes.length > 1) { skipped.push({ nameKey, members, barcodes }); continue; }
        plans.push({ nameKey, members });
    }

    console.log(`Toplam kayıt: ${docs.length} | Birleşecek grup: ${plans.length} | Elle bakılacak: ${skipped.length}\n`);

    for (const { members } of plans) {
        console.log(`  "${formatName(members[0].productName)}" <= ${members.map((m) => `"${m.productName}"`).join(', ')}`);
    }
    if (skipped.length) {
        console.log('\n--- AYNI AD, FARKLI BARKOD (birleştirilmez, elle kontrol et) ---');
        for (const s of skipped) console.log(`  ${s.members.map((m) => `"${m.productName}" [${m.barcode || 'barkodsuz'}]`).join('  |  ')}`);
    }

    // Birleşmeyen ama benzeyen adlar (otomatik dokunulmaz)
    const keys = [...groups.keys()];
    const fuzzy = [];
    for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
            const s = similarity(keys[i], keys[j]);
            if (s >= FUZZY) fuzzy.push({ a: groups.get(keys[i])[0].productName, b: groups.get(keys[j])[0].productName, s });
        }
    }
    if (fuzzy.length) {
        console.log(`\n--- BENZER AMA BİRLEŞTİRİLMEYEN (${fuzzy.length} çift, ilk 40) ---`);
        fuzzy.sort((x, y) => y.s - x.s).slice(0, 40).forEach((f) => console.log(`  ${(f.s * 100).toFixed(0)}%  "${f.a}"  ~  "${f.b}"`));
    }

    if (!APPLY) {
        console.log('\nDry-run bitti. Rapor uygunsa --apply ile tekrar çalıştır.');
        return client.close();
    }

    // Yedek
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const backupName = `products_backup_${stamp}`;
    if (docs.length) await client.db(config.mongo.dbName).collection(backupName).insertMany(docs);
    console.log(`\n💾 Yedek alındı: ${backupName} (${docs.length} kayıt)`);

    // Birleştir
    for (const { nameKey, members } of plans) {
        members.sort((a, b) => (b.productInfo?.length || 0) - (a.productInfo?.length || 0));
        const main = members[0];
        const reminders = members.map((m) => m.productReminder).filter((n) => Number.isFinite(n));
        const priced = members.filter((m) => m.price != null)
            .sort((a, b) => new Date(b.priceUpdatedAt || 0) - new Date(a.priceUpdatedAt || 0))[0];

        await col.updateOne({ _id: main._id }, {
            $set: {
                productName: formatName(main.productName),
                nameKey,
                barcode: members.map((m) => m.barcode).find(Boolean) || undefined,
                brand: mostCommon(members.map((m) => m.brand)) || main.brand || '',
                productCategory: mostCommon(members.map((m) => m.productCategory)) || 'std',
                productReminder: reminders.length ? Math.min(...reminders) : 7,
                price: priced ? priced.price : null,
                productInfo: normalizeList(members.flatMap((m) => (Array.isArray(m.productInfo) ? m.productInfo : m.productInfo ? [m.productInfo] : []))),
                aliases: [...new Set(members.map((m) => m.productName.trim()))],
                updatedAt: new Date(),
            },
        });
        const others = members.slice(1).map((m) => m._id);
        if (others.length) await col.deleteMany({ _id: { $in: others } });
    }
    // barcode: undefined $set ile alan yazmaz, ama güvence için boş alanları temizle
    await col.updateMany({ barcode: null }, { $unset: { barcode: '' } });
    console.log(`✅ ${plans.length} grup birleştirildi.`);

    if (RENAME) {
        const all = await col.find({}).toArray();
        const ops = [];
        for (const d of all) {
            const standard = formatName(d.productName || '');
            if (standard && standard !== d.productName) {
                ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { productName: standard, nameKey: buildNameKey(standard) } } } });
            }
        }
        if (ops.length) await col.bulkWrite(ops);
        console.log(`✅ ${ops.length} ürün adı standart biçime çevrildi.`);
    }

    await client.close();
}

main().catch((err) => {
    console.error('Hata:', err);
    process.exit(1);
});