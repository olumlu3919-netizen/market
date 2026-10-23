// scripts/migrate.js
// Eski `products` koleksiyonunu `catalog` + `batches` yapısına taşır.
// Eski koleksiyona DOKUNMAZ, sadece okur.
//
// Kullanım:
//   node scripts/migrate.js                          -> dry-run (hiçbir şey yazmaz, rapor basar)
//   node scripts/migrate.js --apply                  -> yazar
//   node scripts/migrate.js --source-db=market       -> eski veriyi başka bir DB'den oku (örn. dev'de canlı kopyayla deneme)
//   node scripts/migrate.js --apply --force          -> hedef doluysa da yaz (dikkat)
//
// Hangi DB'ye yazacağı config.js'ten gelir (dev: market_dev, prod: market).
const { MongoClient } = require('mongodb');
const config = require('../config');
const { getCollections, ensureIndexes } = require('../db');
const { buildNameKey, formatName, similarity } = require('../nameUtils');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const FORCE = argv.includes('--force');
const sourceDbName = (argv.find((a) => a.startsWith('--source-db=')) || '').split('=')[1] || config.mongo.dbName;
const FUZZY_THRESHOLD = 0.85;

function dayStartUTC(dateKey) {
    return new Date(`${dateKey}T00:00:00.000Z`);
}

function toDateKey(info) {
    if (info?.expirationDate && /^\d{4}-\d{2}-\d{2}$/.test(info.expirationDate)) return info.expirationDate;
    if (info?.timestamp) {
        const d = new Date(info.timestamp);
        if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
    return null;
}

function mostCommon(values) {
    const counts = new Map();
    for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

async function main() {
    const client = new MongoClient(config.mongo.url);
    await client.connect();

    const sourceDb = client.db(sourceDbName);
    const targetDb = client.db(config.mongo.dbName);
    const legacy = getCollections(sourceDb).legacyProducts;
    const target = getCollections(targetDb);

    console.log(`Kaynak: ${sourceDbName}.products  ->  Hedef: ${config.mongo.dbName}.(catalog, batches)`);
    console.log(APPLY ? 'MOD: YAZMA (--apply)' : 'MOD: DRY-RUN (hiçbir şey yazılmayacak)');

    const docs = await legacy.find({}).toArray();
    console.log(`Eski kayıt sayısı: ${docs.length}\n`);

    // 1) nameKey'e göre grupla
    const groups = new Map();
    for (const doc of docs) {
        if (!doc.productName) continue;
        const key = buildNameKey(doc.productName);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(doc);
    }

    const todayKey = new Date().toISOString().slice(0, 10);
    const catalogDocs = [];
    const batchDocs = [];
    let duplicateBatches = 0;
    let expiredBatches = 0;

    for (const [nameKey, members] of groups) {
        // En çok partisi olan kayıt "ana" kayıt olur
        members.sort((a, b) => (b.productInfo?.length || 0) - (a.productInfo?.length || 0));
        const main = members[0];

        const name = formatName(main.productName);
        const aliases = [...new Set(members.map((m) => m.productName.trim()))];
        const reminders = members.map((m) => m.productReminder).filter((n) => Number.isFinite(n));

        const catalogId = new (require('mongodb').ObjectId)();
        catalogDocs.push({
            _id: catalogId,
            name,
            nameKey,
            brand: mostCommon(members.map((m) => m.brand)) || name.split(' ')[0],
            category: mostCommon(members.map((m) => m.productCategory)) || 'std',
            reminderDays: reminders.length ? Math.min(...reminders) : 7, // birleşenlerde en erken uyarı
            barcode: null,
            price: null,
            priceHistory: [],
            aliases,
            aliasKeys: [...new Set(aliases.map(buildNameKey))],
            source: 'migration',
            createdAt: main.addDate || new Date(),
            updatedAt: new Date(),
        });

        // Partiler: aynı ürün + aynı tarih tek kayıt
        const seen = new Set();
        for (const m of members) {
            const infos = Array.isArray(m.productInfo) ? m.productInfo : (m.productInfo ? [m.productInfo] : []);
            for (const info of infos) {
                const expiryKey = toDateKey(info);
                if (!expiryKey) continue;
                if (seen.has(expiryKey)) { duplicateBatches++; continue; }
                seen.add(expiryKey);

                const expired = expiryKey < todayKey;
                if (expired) expiredBatches++;

                batchDocs.push({
                    productId: catalogId,
                    expiryDate: dayStartUTC(expiryKey),
                    expiryKey,
                    quantity: 1,
                    // Eski sistem süresi geçenleri zaten göstermiyordu; aktif bırakıp bildirim yağdırmayalım
                    status: expired ? 'removed' : 'active',
                    addedBy: m.addedBy || 'migration',
                    addedAt: m.addDate || new Date(),
                    source: 'migration',
                    ...(expired && { removedAt: new Date(), removedBy: 'migration', removeReason: 'migration-expired' }),
                });
            }
        }
    }

    // 2) Rapor
    const merged = [...groups.values()].filter((g) => g.length > 1);
    console.log('--- ÖZET ---');
    console.log(`Eski kayıt            : ${docs.length}`);
    console.log(`Yeni katalog ürünü    : ${catalogDocs.length}`);
    console.log(`Birleştirilen grup    : ${merged.length} (${merged.reduce((s, g) => s + g.length, 0)} kayıt -> ${merged.length})`);
    console.log(`Oluşan parti          : ${batchDocs.length} (aktif: ${batchDocs.filter((b) => b.status === 'active').length}, süresi geçmiş: ${expiredBatches})`);
    console.log(`Tekrar eden tarih     : ${duplicateBatches} (aynı ürün + aynı tarih tek kayda indirildi)\n`);

    if (merged.length) {
        console.log('--- OTOMATİK BİRLEŞTİRİLENLER ---');
        for (const g of merged) {
            console.log(`  "${formatName(g[0].productName)}" <= ${g.map((m) => `"${m.productName}"`).join(', ')}`);
        }
        console.log();
    }

    // Birleşmeyen ama benzeyen çiftler: otomatik birleştirilmez, sadece listelenir
    const keys = [...groups.keys()];
    const fuzzy = [];
    for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
            const s = similarity(keys[i], keys[j]);
            if (s >= FUZZY_THRESHOLD) fuzzy.push({ a: groups.get(keys[i])[0].productName, b: groups.get(keys[j])[0].productName, s });
        }
    }
    if (fuzzy.length) {
        console.log(`--- BENZER AMA BİRLEŞTİRİLMEYEN (elle kontrol et, ${fuzzy.length} çift) ---`);
        fuzzy.sort((x, y) => y.s - x.s).slice(0, 50).forEach((f) => console.log(`  ${(f.s * 100).toFixed(0)}%  "${f.a}"  ~  "${f.b}"`));
        console.log();
    }

    if (!APPLY) {
        console.log('Dry-run bitti. Rapor uygunsa --apply ile tekrar çalıştır.');
        await client.close();
        return;
    }

    // 3) Yaz
    const existing = await target.catalog.countDocuments();
    if (existing > 0 && !FORCE) {
        console.error(`❌ Hedefte zaten ${existing} katalog kaydı var. Üstüne yazmamak için durdum (bilerek yapacaksan --force).`);
        await client.close();
        process.exit(1);
    }

    await ensureIndexes(targetDb);
    if (catalogDocs.length) await target.catalog.insertMany(catalogDocs);
    if (batchDocs.length) await target.batches.insertMany(batchDocs);
    console.log(`✅ Yazıldı: ${catalogDocs.length} ürün, ${batchDocs.length} parti.`);
    console.log('Eski `products` koleksiyonuna dokunulmadı.');

    await client.close();
}

main().catch((err) => {
    console.error('Migration hatası:', err);
    process.exit(1);
});