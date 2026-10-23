// productService.js
// Ürünle ilgili TÜM işlemler burada. Bot, WhatsApp, cron ve API aynı servisi kullanır.
// Mevcut `products` koleksiyonu üzerinde çalışır; eski kayıtlar bozulmadan okunur.
//
// Ürün belgesi:
//   barcode (opsiyonel), productName (standart ad), nameKey, brand, productCategory, productReminder,
//   price, priceHistory[], productInfo: [{ expirationDate:'YYYY-MM-DD', timestamp, viewDate, quantity }]
const { ObjectId } = require('mongodb');
const { buildNameKey, formatName } = require('./nameUtils');
const { guessCategory } = require('./parser');

const DAY_MS = 86400000;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- Tarih yardımcıları (hep İstanbul saatine göre) ----------
function todayKey() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
}
function keyToUTC(key) {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}
function remainingDays(key) {
    return Math.round((keyToUTC(key) - keyToUTC(todayKey())) / DAY_MS);
}
function viewDate(key) {
    const [y, m, d] = key.split('-');
    return `${d}/${m}/${y}`;
}
// Bugünden itibaren n gün/hafta/ay/yıl sonrası -> 'YYYY-MM-DD'
function relativeKey(num, unit) {
    const date = new Date(keyToUTC(todayKey()));
    if (unit === 'g') date.setUTCDate(date.getUTCDate() + num);
    else if (unit === 'h') date.setUTCDate(date.getUTCDate() + num * 7);
    else if (unit === 'a') date.setUTCMonth(date.getUTCMonth() + num);
    else if (unit === 'y') date.setUTCFullYear(date.getUTCFullYear() + num);
    return date.toISOString().slice(0, 10);
}

// Düşme nedenleri. Belirtilmezse: süresi geçmiş partiler 'zayi', diğerleri 'belirtilmedi' sayılır.
const REASONS = ['satildi', 'zayi', 'iade', 'diger'];
function reasonFor(dateKey, given) {
    if (REASONS.includes(given)) return given;
    return remainingDays(dateKey) < 0 ? 'zayi' : 'belirtilmedi';
}

// ---------- SKT listesi normalizasyonu ----------
function entryKey(info) {
    if (info?.expirationDate && /^\d{4}-\d{2}-\d{2}$/.test(info.expirationDate)) return info.expirationDate;
    if (info?.timestamp) {
        const d = new Date(info.timestamp);
        if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
    return null;
}
function buildEntry(key, quantity) {
    return { expirationDate: key, timestamp: keyToUTC(key), viewDate: viewDate(key), quantity };
}
// Eski kayıtlar (adetsiz, aynı tarihten birden fazla) tek tip hale gelir
function normalizeList(productInfo) {
    const arr = Array.isArray(productInfo) ? productInfo : (productInfo ? [productInfo] : []);
    const byDate = new Map();
    for (const info of arr) {
        const key = entryKey(info);
        if (!key) continue;
        const qty = Number.isFinite(info.quantity) && info.quantity > 0 ? info.quantity : 1;
        byDate.set(key, Math.max(byDate.get(key) || 0, qty)); // aynı tarih tekrarı: büyük olanı al
    }
    return [...byDate.entries()]
        .map(([key, qty]) => buildEntry(key, qty))
        .sort((a, b) => a.timestamp - b.timestamp);
}

// ---------- Open Food Facts ----------
async function fetchOpenFoodFacts(barcode) {
    const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`
        + '?fields=product_name,product_name_tr,brands,quantity';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'MarketBot/1.0' } });
        const data = await res.json();
        if (data.status !== 1 || !data.product) return null;

        const p = data.product;
        const brand = p.brands ? p.brands.split(',')[0].trim() : '';
        let name = String(p.product_name_tr || p.product_name || '').trim();
        if (name && brand && !name.toLocaleLowerCase('tr-TR').includes(brand.toLocaleLowerCase('tr-TR'))) {
            name = `${brand} ${name}`;
        }
        const qty = String(p.quantity || '').trim();
        if (name && qty && !buildNameKey(name).includes(buildNameKey(qty))) name += ` ${qty}`;

        return { barcode, name: name ? formatName(name) : '', brand };
    } catch (err) {
        console.error('Open Food Facts hatası:', err.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function createProductService(db) {
    const products = db.collection('products');
    const logs = db.collection('stock_logs');

    const byRef = (ref) => (/^[a-f0-9]{24}$/i.test(ref) ? { _id: new ObjectId(ref) } : { barcode: String(ref) });
    const log = (type, doc, extra) =>
        logs.insertOne({
            type, productId: doc._id, name: doc.productName, barcode: doc.barcode || null,
            brand: doc.brand || null, category: doc.productCategory || null, price: doc.price ?? null,
            ...extra, at: new Date(),
        })
            .catch((e) => console.error('Log yazılamadı:', e.message));

    async function init() {
        await products.createIndex({ barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } });
        await products.createIndex({ nameKey: 1 });

        // nameKey'i olmayan eski kayıtları tamamla
        const missing = await products.find({ nameKey: { $exists: false }, productName: { $type: 'string' } }).toArray();
        if (missing.length) {
            await products.bulkWrite(missing.map((d) => ({
                updateOne: { filter: { _id: d._id }, update: { $set: { nameKey: buildNameKey(d.productName) } } },
            })));
            console.log(`🔧 ${missing.length} eski ürüne arama anahtarı eklendi`);
        }
    }

    const findByRef = (ref) => products.findOne(byRef(ref));

    // Ad ile arama: önce birebir (standartlaştırılmış), sonra tüm kelimeleri içerenler
    async function search(text, limit = 8) {
        const raw = String(text).trim();
        if (/^\d{6,14}$/.test(raw)) { // barkod numarası yazıldıysa önce barkodla ara
            const byCode = await products.find({ barcode: raw }).limit(limit).toArray();
            if (byCode.length) return byCode;
        }
        const key = buildNameKey(text);
        if (!key) return [];
        const exact = await products.find({ nameKey: key }).limit(limit).toArray();
        if (exact.length) return exact;
        const query = { $and: key.split(' ').map((t) => ({ nameKey: { $regex: escapeRegex(t) } })) };
        return products.find(query).limit(limit).toArray();
    }

    // Barkod: önce kendi veritabanımız, yoksa Open Food Facts
    async function lookup(barcode) {
        const local = await products.findOne({ barcode });
        if (local) return { source: 'local', product: local };
        const remote = await fetchOpenFoodFacts(barcode);
        return remote ? { source: 'openfoodfacts', product: remote } : { source: null, product: null };
    }

    // Ürünü bul ya da oluştur. Aynı ad (standartlaşmış) varsa yenisi açılmaz, mevcut ürün kullanılır.
    // Mevcut ürünün barkodu yoksa ve barkod verildiyse otomatik bağlanır.
    async function ensureProduct({ barcode, name, brand, category, reminderDays, price, source, user, strict, approved }) {
        if (barcode) {
            const byBarcode = await products.findOne({ barcode });
            if (byBarcode) return { product: byBarcode, existed: true };
        }
        if (!name) throw new Error('Ürün adı gerekli');

        const nameKey = buildNameKey(name);
        const clash = await products.findOne({ nameKey });
        if (clash && (!barcode || !clash.barcode)) {
            if (barcode) {
                await products.updateOne({ _id: clash._id }, { $set: { barcode, updatedAt: new Date() } });
                return { product: await products.findOne({ _id: clash._id }), existed: true, linked: true };
            }
            return { product: clash, existed: true };
        }

        // strict: aynı ad başka barkodlu bir üründe varsa yeni kayıt açma, çağırana haber ver
        if (strict && clash && barcode && clash.barcode && clash.barcode !== barcode) {
            return { error: 'NAME_CLASH', existing: clash };
        }

        const standard = formatName(name);
        const guess = guessCategory(standard);
        const doc = {
            ...(barcode && { barcode }),
            productName: standard,
            nameKey,
            brand: brand || standard.split(' ')[0],
            productCategory: category || guess.category,
            productReminder: reminderDays || guess.reminderDay,
            price: price ?? null,
            productInfo: [],
            // Yönetici eklediyse onaylı, personel eklediyse yönetici onayı bekler
            approval: approved ? { status: 'approved', by: user || null, at: new Date() } : { status: 'pending' },
            source: source || 'manual',
            addedBy: user || 'bilinmiyor',
            addDate: new Date(),
            updatedAt: new Date(),
        };
        const { insertedId } = await products.insertOne(doc);
        const createdDoc = await products.findOne({ _id: insertedId });
        log('create', createdDoc, { user });
        return { product: createdDoc, created: true };
    }

    async function updateProduct(ref, { name, price, brand, category, reminderDays } = {}, user) {
        const doc = await findByRef(ref);
        if (!doc) return null;
        const set = { updatedAt: new Date() };
        const update = { $set: set };

        if (name) {
            const nameKey = buildNameKey(name);
            const clash = await products.findOne({ nameKey, _id: { $ne: doc._id } });
            if (clash) return { conflict: clash };
            set.productName = formatName(name);
            set.nameKey = nameKey;
        }
        if (brand !== undefined) set.brand = brand;
        if (category) set.productCategory = category;
        if (reminderDays !== undefined && reminderDays !== null) set.productReminder = reminderDays;
        if (price !== undefined) {
            set.price = price;
            set.priceUpdatedAt = new Date();
            if (price !== null) update.$push = { priceHistory: { price, at: new Date(), by: user || null } };
        }
        await products.updateOne({ _id: doc._id }, update);
        log('edit', doc, { user });
        return { product: await products.findOne({ _id: doc._id }) };
    }

    async function attachBarcode(ref, barcode) {
        const existing = await products.findOne({ barcode });
        if (existing) return { error: 'DUPLICATE', existing };
        const doc = await findByRef(ref);
        if (!doc) return { error: 'NOT_FOUND' };
        await products.updateOne({ _id: doc._id }, { $set: { barcode, updatedAt: new Date() } });
        return { product: await products.findOne({ _id: doc._id }) };
    }

    // Aynı tarih zaten varsa adet artar (kopya kayıt oluşmaz)
    async function addExpiry(ref, dateKey, quantity = 1, user) {
        const doc = await findByRef(ref);
        if (!doc) return null;
        const list = normalizeList(doc.productInfo);
        const existing = list.find((e) => e.expirationDate === dateKey);
        if (existing) existing.quantity += quantity;
        else list.push(buildEntry(dateKey, quantity));
        list.sort((a, b) => a.timestamp - b.timestamp);

        await products.updateOne({ _id: doc._id }, { $set: { productInfo: list, updatedAt: new Date() } });
        log('add', doc, { date: dateKey, quantity, user });
        return {
            product: { ...doc, productInfo: list },
            merged: Boolean(existing),
            total: list.find((e) => e.expirationDate === dateKey).quantity,
        };
    }

    // { key, quantity } belirli tarihten düşer (quantity yoksa o tarihin hepsi) | { all: true } hepsini temizler
    // reason: 'satildi' | 'zayi' | 'iade' | 'diger'. Verilmezse süresi geçmiş partiler 'zayi' sayılır.
    async function removeExpiry(ref, { key, quantity, all, reason } = {}, user) {
        const doc = await findByRef(ref);
        if (!doc) return null;
        const list = normalizeList(doc.productInfo);
        let removed;
        let next;

        if (all) {
            removed = list.reduce((s, e) => s + e.quantity, 0);
            next = [];
            for (const e of list) {
                log('remove', doc, { date: e.expirationDate, quantity: e.quantity, reason: reasonFor(e.expirationDate, reason), user });
            }
        } else {
            const entry = list.find((e) => e.expirationDate === key);
            if (!entry) return { product: doc, notFound: true };
            removed = quantity && quantity < entry.quantity ? quantity : entry.quantity;
            entry.quantity -= removed;
            next = list.filter((e) => e.quantity > 0);
            log('remove', doc, { date: key, quantity: removed, reason: reasonFor(key, reason), user });
        }
        await products.updateOne({ _id: doc._id }, { $set: { productInfo: next, updatedAt: new Date() } });
        return { product: { ...doc, productInfo: next }, removed };
    }

    // Önce SKT'si en yakın olandan düşer (FEFO)
    async function removeEarliest(ref, quantity, user, reason) {
        const doc = await findByRef(ref);
        if (!doc) return null;
        const list = normalizeList(doc.productInfo);
        let need = quantity;
        let removed = 0;
        for (const e of list) {
            if (need <= 0) break;
            const take = Math.min(e.quantity, need);
            e.quantity -= take;
            need -= take;
            removed += take;
            log('remove', doc, { date: e.expirationDate, quantity: take, reason: reasonFor(e.expirationDate, reason), user });
        }
        const next = list.filter((e) => e.quantity > 0);
        await products.updateOne({ _id: doc._id }, { $set: { productInfo: next, updatedAt: new Date() } });
        return { product: { ...doc, productInfo: next }, removed, shortBy: need };
    }

    // days: bugünden itibaren kaç gün içindekiler (süresi geçenler dahil). null = hepsi
    async function listExpiring(days = null) {
        const docs = await products.find({ 'productInfo.0': { $exists: true } }).toArray();
        const out = [];
        for (const doc of docs) {
            for (const e of normalizeList(doc.productInfo)) {
                const remaining = remainingDays(e.expirationDate);
                if (days !== null && remaining > days) continue;
                out.push({
                    ref: String(doc._id),
                    barcode: doc.barcode || null,
                    productName: doc.productName,
                    price: doc.price ?? null,
                    productReminder: doc.productReminder || null,
                    quantity: e.quantity,
                    expirationDate: e.expirationDate,
                    timestamp: e.timestamp,
                    viewDate: e.viewDate,
                    remainingDay: remaining,
                });
            }
        }
        return out.sort((a, b) => a.timestamp - b.timestamp);
    }

    // ---------- Web arayüzleri (Mini App + admin paneli) için ----------
    function toView(doc) {
        const entries = normalizeList(doc.productInfo).map((e) => ({
            expirationDate: e.expirationDate,
            viewDate: e.viewDate,
            quantity: e.quantity,
            remainingDay: remainingDays(e.expirationDate),
        }));
        return {
            ref: String(doc._id),
            barcode: doc.barcode || null,
            name: doc.productName,
            brand: doc.brand || '',
            category: doc.productCategory || '',
            reminderDays: doc.productReminder || null,
            price: doc.price ?? null,
            entries,
            totalQuantity: entries.reduce((sum, e) => sum + e.quantity, 0),
            nextExpiry: entries[0]?.expirationDate || null,
            nextRemaining: entries[0]?.remainingDay ?? null,
            addedBy: doc.addedBy || null,
            addedAt: doc.addDate || null,
            approval: doc.approval?.status || 'approved', // eski kayıtlar onaylı sayılır
        };
    }

    // Barkod: kayıtlıysa kendi bilgisi, değilse Open Food Facts önerisi, yoksa boş form
    async function lookupView(barcode) {
        const res = await lookup(barcode);
        if (res.source === 'local') return { source: 'local', product: toView(res.product) };
        const empty = { ref: null, barcode, name: '', brand: '', category: '', reminderDays: null, price: null, entries: [], totalQuantity: 0 };
        if (res.source === 'openfoodfacts') {
            const g = guessCategory(res.product.name);
            return {
                source: 'openfoodfacts',
                product: { ...empty, name: res.product.name, brand: res.product.brand, category: g.category, reminderDays: g.reminderDay },
            };
        }
        return { source: null, product: empty };
    }

    // Tek adımda: ürünü bul/oluştur + fiyat + SKT ekle
    async function quickAdd({ ref, barcode, name, brand, category, reminderDays, price, dateKey, quantity = 1, user, source, approved }) {
        let product;
        let created = false;
        let linked = false;
        if (ref) {
            product = await findByRef(ref);
            if (!product) return { error: 'NOT_FOUND' };
        } else {
            const r = await ensureProduct({ barcode, name, brand, category, reminderDays, price, source, user, strict: true, approved });
            if (r.error) return r;
            product = r.product;
            created = Boolean(r.created);
            linked = Boolean(r.linked);
        }
        const id = String(product._id);
        if (price !== undefined && price !== null && price !== product.price) {
            await updateProduct(id, { price }, user);
        }
        const add = dateKey ? await addExpiry(id, dateKey, quantity, user) : null;
        return {
            product: toView(await findByRef(id)),
            created,
            linked,
            merged: add?.merged || false,
            total: add?.total ?? null,
        };
    }

    async function listProducts({ q, limit = 50, skip = 0 } = {}) {
        const text = String(q || '').trim();
        let filter = {};
        if (/^\d{6,14}$/.test(text)) filter = { barcode: text };
        else if (text) {
            const key = buildNameKey(text);
            filter = { $and: key.split(' ').map((t) => ({ nameKey: { $regex: escapeRegex(t) } })) };
        }
        const total = await products.countDocuments(filter);
        const docs = await products.find(filter).sort({ productName: 1 }).skip(skip).limit(limit).toArray();
        return { total, items: docs.map(toView) };
    }

    async function deleteProduct(ref, user) {
        const doc = await findByRef(ref);
        if (!doc) return null;
        await log('delete', doc, { user });
        await products.deleteOne({ _id: doc._id });
        return { deleted: doc.productName };
    }

    async function recentLogs(limit = 100, { type, user } = {}) {
        const filter = {};
        if (type) filter.type = type;
        if (user) filter.user = user;
        const rows = await logs.find(filter).sort({ at: -1 }).limit(limit).toArray();
        return rows.map((r) => ({
            type: r.type, name: r.name, barcode: r.barcode || null, brand: r.brand || null,
            date: r.date || null, quantity: r.quantity ?? null, reason: r.reason || null,
            user: r.user || null, at: r.at,
        }));
    }

    async function stats() {
        const [productCount, all, pending] = await Promise.all([
            products.countDocuments({}),
            listExpiring(null),
            products.countDocuments({ 'approval.status': 'pending' }),
        ]);
        const out = { productCount, pending, shelfUnits: 0, expiredUnits: 0, soonUnits: 0, expiredValue: 0, soonValue: 0 };
        for (const e of all) {
            const value = (e.price || 0) * e.quantity;
            out.shelfUnits += e.quantity;
            if (e.remainingDay < 0) { out.expiredUnits += e.quantity; out.expiredValue += value; }
            else if (e.remainingDay <= 7) { out.soonUnits += e.quantity; out.soonValue += value; }
        }
        out.expiredValue = Math.round(out.expiredValue * 100) / 100;
        out.soonValue = Math.round(out.soonValue * 100) / 100;
        return out;
    }

    // ---------- Onay (yeni ürünleri yönetici kontrol eder) ----------
    async function pendingProducts(limit = 200) {
        const docs = await products.find({ 'approval.status': 'pending' }).sort({ addDate: -1 }).limit(limit).toArray();
        return docs.map(toView);
    }

    async function approveProduct(ref, user) {
        const doc = await findByRef(ref);
        if (!doc) return null;
        await products.updateOne({ _id: doc._id }, {
            $set: { approval: { status: 'approved', by: user || null, at: new Date() }, updatedAt: new Date() },
        });
        log('approve', doc, { user });
        return toView(await products.findOne({ _id: doc._id }));
    }

    async function approveAll(user) {
        const count = await products.countDocuments({ 'approval.status': 'pending' });
        if (!count) return 0;
        await products.updateMany({ 'approval.status': 'pending' }, {
            $set: { approval: { status: 'approved', by: user || null, at: new Date() }, updatedAt: new Date() },
        });
        logs.insertOne({ type: 'approve', name: `${count} ürün (toplu)`, quantity: count, user, at: new Date() })
            .catch((e) => console.error('Log yazılamadı:', e.message));
        return count;
    }

    // ---------- Analiz: grafikler, kullanıcılar, markalar ----------
    async function analytics({ days = 30 } = {}) {
        const span = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
        const since = new Date(Date.now() - span * DAY_MS);
        const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' });
        const rows = await logs.find({ at: { $gte: since } }).sort({ at: 1 }).limit(50000).toArray();

        // Eski kayıtlarda marka yoksa ürünlerden tamamla
        const missingIds = [...new Set(rows.filter((r) => !r.brand && r.productId).map((r) => String(r.productId)))];
        const byId = new Map();
        if (missingIds.length) {
            const found = await products.find({ _id: { $in: missingIds.map((id) => new ObjectId(id)) } }).toArray();
            for (const d of found) byId.set(String(d._id), d);
        }

        const today = keyToUTC(todayKey());
        const daily = new Map();
        for (let i = span - 1; i >= 0; i--) {
            const key = new Date(today - i * DAY_MS).toISOString().slice(0, 10);
            daily.set(key, { date: key, added: 0, removed: 0, created: 0 });
        }

        const reasons = {};
        for (const k of [...REASONS, 'belirtilmedi']) reasons[k] = { units: 0, value: 0 };
        const brandAgg = new Map();
        const prodAgg = new Map();
        const userAgg = new Map();
        const totals = { added: 0, removed: 0, created: 0, returned: 0, wasted: 0, sold: 0, lostValue: 0 };

        for (const r of rows) {
            const doc = byId.get(String(r.productId));
            const brandRaw = String(r.brand || doc?.brand || '').trim();
            const brandKey = buildNameKey(brandRaw) || 'bilinmiyor';
            const qty = Number.isFinite(r.quantity) ? r.quantity : 0;
            const price = Number.isFinite(r.price) ? r.price : (Number.isFinite(doc?.price) ? doc.price : 0);
            const day = daily.get(dayFmt.format(new Date(r.at)));

            const b = brandAgg.get(brandKey) || { brand: brandRaw ? formatName(brandRaw) : 'Bilinmiyor', added: 0, removed: 0, sold: 0, returned: 0, wasted: 0, other: 0, lostValue: 0 };
            brandAgg.set(brandKey, b);

            if (r.user) {
                const u = userAgg.get(r.user) || { user: r.user, actions: 0, added: 0, removed: 0, created: 0, approvals: 0, lastActive: null, activeDays: new Set() };
                userAgg.set(r.user, u);
                u.actions += 1;
                u.activeDays.add(dayFmt.format(new Date(r.at)));
                if (!u.lastActive || new Date(r.at) > new Date(u.lastActive)) u.lastActive = r.at;
                if (r.type === 'add') u.added += qty;
                else if (r.type === 'remove') u.removed += qty;
                else if (r.type === 'create') u.created += 1;
                else if (r.type === 'approve') u.approvals += 1;
            }

            if (r.type === 'add') {
                totals.added += qty; b.added += qty; if (day) day.added += qty;
            } else if (r.type === 'create') {
                totals.created += 1; if (day) day.created += 1;
            } else if (r.type === 'remove') {
                const reason = reasons[r.reason] ? r.reason : 'belirtilmedi';
                const value = qty * price;
                totals.removed += qty; b.removed += qty; if (day) day.removed += qty;
                reasons[reason].units += qty; reasons[reason].value += value;

                const pKey = String(r.productId || r.name);
                const p = prodAgg.get(pKey) || { name: r.name, brand: b.brand, removed: 0, returned: 0, wasted: 0, lostValue: 0 };
                prodAgg.set(pKey, p);
                p.removed += qty;

                if (reason === 'iade') { totals.returned += qty; b.returned += qty; p.returned += qty; b.lostValue += value; p.lostValue += value; totals.lostValue += value; }
                else if (reason === 'zayi') { totals.wasted += qty; b.wasted += qty; p.wasted += qty; b.lostValue += value; p.lostValue += value; totals.lostValue += value; }
                else if (reason === 'satildi') { totals.sold += qty; b.sold += qty; }
                else b.other += qty;
            }
        }

        const pct = (a, total) => (total > 0 ? Math.round((a / total) * 1000) / 10 : 0);
        const round2 = (n) => Math.round(n * 100) / 100;
        for (const k of Object.keys(reasons)) reasons[k].value = round2(reasons[k].value);
        totals.lostValue = round2(totals.lostValue);

        const brands = [...brandAgg.values()].map((b) => ({
            ...b, lostValue: round2(b.lostValue), returnRate: pct(b.returned, b.removed), wasteRate: pct(b.wasted, b.removed),
        })).filter((b) => b.removed > 0 || b.added > 0).sort((a, b) => (b.returned + b.wasted) - (a.returned + a.wasted) || b.removed - a.removed);

        const topProducts = [...prodAgg.values()].filter((p) => p.returned + p.wasted > 0)
            .map((p) => ({ ...p, lostValue: round2(p.lostValue) }))
            .sort((a, b) => (b.returned + b.wasted) - (a.returned + a.wasted)).slice(0, 10);

        // Kullanıcılar: dönemdeki işlemler + tüm zamanların ürün sayıları
        const allProducts = await products.find({}).toArray();
        const lifetime = new Map();
        for (const d of allProducts) {
            if (!d.addedBy) continue;
            const l = lifetime.get(d.addedBy) || { totalProducts: 0, approvedProducts: 0, pendingProducts: 0 };
            lifetime.set(d.addedBy, l);
            l.totalProducts += 1;
            if (d.approval?.status === 'pending') l.pendingProducts += 1; else l.approvedProducts += 1;
        }
        for (const name of lifetime.keys()) {
            if (!userAgg.has(name)) userAgg.set(name, { user: name, actions: 0, added: 0, removed: 0, created: 0, approvals: 0, lastActive: null, activeDays: new Set() });
        }
        const users = [...userAgg.values()].map((u) => ({
            user: u.user, actions: u.actions, added: u.added, removed: u.removed, created: u.created, approvals: u.approvals,
            lastActive: u.lastActive, activeDays: u.activeDays.size,
            totalProducts: 0, approvedProducts: 0, pendingProducts: 0, ...(lifetime.get(u.user) || {}),
        })).sort((a, b) => b.actions - a.actions || String(a.user).localeCompare(String(b.user), 'tr'));

        // SKT dağılımı + ürün hareketliliği
        const expiring = await listExpiring(null);
        const bucketDefs = [
            { label: 'Süresi geçmiş', test: (d) => d < 0 }, { label: '0-3 gün', test: (d) => d >= 0 && d <= 3 },
            { label: '4-7 gün', test: (d) => d >= 4 && d <= 7 }, { label: '8-14 gün', test: (d) => d >= 8 && d <= 14 },
            { label: '15-30 gün', test: (d) => d >= 15 && d <= 30 }, { label: '30+ gün', test: (d) => d > 30 },
        ];
        const buckets = bucketDefs.map((def) => {
            const items = expiring.filter((e) => def.test(e.remainingDay));
            return { label: def.label, units: items.reduce((s, e) => s + e.quantity, 0), value: round2(items.reduce((s, e) => s + (e.price || 0) * e.quantity, 0)) };
        });

        const withStock = new Set(expiring.map((e) => e.ref));
        const moved = new Set(rows.filter((r) => r.productId).map((r) => String(r.productId)));
        const union = new Set([...withStock, ...moved]);
        const pendingCount = allProducts.filter((d) => d.approval?.status === 'pending').length;

        return {
            days: span, totals: { ...totals, returnRate: pct(totals.returned, totals.removed), wasteRate: pct(totals.wasted, totals.removed) },
            daily: [...daily.values()], reasons, brands, topProducts, users, buckets,
            products: {
                total: allProducts.length, active: withStock.size, moved: moved.size,
                idle: Math.max(0, allProducts.length - union.size), pending: pendingCount,
                approved: allProducts.length - pendingCount,
            },
        };
    }

    // ---------- Sistem / veritabanı izleme ----------
    async function systemInfo() {
        let dbInfo = null;
        try {
            const st = await db.command({ dbStats: 1, scale: 1024 * 1024 });
            const r2 = (n) => Math.round((n || 0) * 100) / 100;
            dbInfo = { name: st.db, collections: st.collections, objects: st.objects, dataMB: r2(st.dataSize), storageMB: r2(st.storageSize), indexMB: r2(st.indexSize) };
        } catch (e) {
            console.error('dbStats alınamadı:', e.message); // yetki yoksa panel "—" gösterir
        }
        const [productCount, logCount, pending, last] = await Promise.all([
            products.countDocuments({}), logs.countDocuments({}),
            products.countDocuments({ 'approval.status': 'pending' }),
            logs.find({}).sort({ at: -1 }).limit(1).toArray(),
        ]);
        return { db: dbInfo, counts: { products: productCount, logs: logCount, pending }, lastActivityAt: last[0]?.at || null };
    }

    return {
        init, findByRef, search, lookup, ensureProduct, updateProduct, attachBarcode,
        addExpiry, removeExpiry, removeEarliest, listExpiring,
        toView, lookupView, quickAdd, listProducts, deleteProduct, recentLogs, stats,
        pendingProducts, approveProduct, approveAll, analytics, systemInfo,
        normalize: normalizeList,
    };
}

module.exports = { createProductService, normalizeList, todayKey, remainingDays, relativeKey, viewDate, REASONS };