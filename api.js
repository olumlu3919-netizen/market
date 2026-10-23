// api.js
//  /api/*        -> Telegram Mini App (kamera ekranı). İmzalı initData + grup üyeliği gerekir.
//  /admin/api/*  -> Web admin paneli. Parola ile giriş + oturum çerezi gerekir.
//  /kamera, /admin sadece HTML döner; veri bu uçlardan gelir.
const express = require('express');
const path = require('path');
const config = require('./config');
const auth = require('./auth');
const { remainingDays, REASONS } = require('./productService');
const { normalizeIp, redactMoney, parseCookies } = require('./AdminAuth');

const REF_RE = /^[a-f0-9]{24}$/i;
const BARCODE_RE = /^[0-9A-Za-z-]{4,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const cleanStr = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function validDateKey(k) {
    if (typeof k !== 'string' || !DATE_RE.test(k)) return false;
    const [y, m, d] = k.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function parseQty(v, def = 1) {
    const n = Number(v ?? def);
    return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : null;
}
// undefined: dokunma | null: fiyatı sil | sayı | NaN: geçersiz
function parsePriceVal(v) {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = typeof v === 'string' ? Number(v.trim().replace(',', '.')) : Number(v); // "12,5" da kabul
    return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) / 100 : NaN;
}
const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

function apiStarter(service, { isMember, getStatus = () => ({}), admin: A }) {
    if (!A) throw new Error('apiStarter: admin (adminAuth) gerekli');
    const app = express();
    // IP bağlama için kritik: kaç proxy arkasındayız? (nginx/ngrok = 1). Sunucu doğrudan internete açıksa 0 yapın.
    const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
    app.set('trust proxy', Number.isInteger(hops) && hops >= 0 ? hops : 1);
    app.disable('x-powered-by');
    app.use(express.json({ limit: '50kb' }));
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });

    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
        console.error(`API hatası (${req.method} ${req.path}):`, err);
        fail(res, 500, 'Sunucu hatası oluştu.');
    });

    // ---------- Ortak işleyiciler ----------
    const h = {
        lookup: async (req, res) => {
            const code = String(req.params.barcode || '').trim();
            if (!BARCODE_RE.test(code)) return fail(res, 400, 'Geçersiz barkod.');
            res.json({ success: true, ...(await service.lookupView(code)) });
        },

        // Barkodlu/barkodsuz ürün + fiyat + SKT tek adımda
        save: async (req, res) => {
            const b = req.body || {};
            const ref = b.ref ? String(b.ref) : null;
            const barcode = b.barcode ? String(b.barcode).trim() : null;
            if (ref && !REF_RE.test(ref)) return fail(res, 400, 'Geçersiz ürün.');
            if (barcode && !BARCODE_RE.test(barcode)) return fail(res, 400, 'Geçersiz barkod.');

            const price = parsePriceVal(b.price);
            if (Number.isNaN(price)) return fail(res, 400, 'Fiyat geçersiz.');

            let dateKey = null;
            if (b.dateKey) {
                if (!validDateKey(b.dateKey)) return fail(res, 400, 'Tarih geçersiz.');
                if (remainingDays(b.dateKey) < 0) return fail(res, 400, 'Tarih geçmişte kalmış.');
                dateKey = b.dateKey;
            }
            const quantity = parseQty(b.quantity);
            if (quantity === null) return fail(res, 400, 'Adet 1-9999 arasında olmalı.');

            const name = cleanStr(b.name);
            if (!ref && !name && !barcode) return fail(res, 400, 'Ürün adı gerekli.');

            let result;
            try {
                result = await service.quickAdd({
                    ref, barcode, name,
                    brand: cleanStr(b.brand, 60) || undefined,
                    category: cleanStr(b.category, 30) || undefined,
                    reminderDays: Number.isInteger(b.reminderDays) && b.reminderDays > 0 ? b.reminderDays : undefined,
                    price, dateKey, quantity,
                    user: req.user.name, source: req.user.via,
                    approved: req.user.via === 'admin', // admin eklediği ürün onaylı, personelinki onay bekler
                });
            } catch (e) {
                if (/Ürün adı gerekli/.test(e.message)) return fail(res, 400, 'Yeni ürün için ad gerekli.');
                throw e;
            }
            if (result.error === 'NAME_CLASH') {
                return fail(res, 409,
                    `Bu ad başka bir barkodlu üründe zaten var (${result.existing.productName}). Adı ayırt edin (örn. gramaj ekleyin).`);
            }
            if (result.error === 'NOT_FOUND') return fail(res, 404, 'Ürün bulunamadı.');
            res.status(result.created ? 201 : 200).json({ success: true, ...result });
        },

        // { key, quantity } belirli tarihten düşer | { all: true } hepsini temizler
        remove: async (req, res) => {
            const ref = String(req.params.ref || '');
            if (!REF_RE.test(ref)) return fail(res, 400, 'Geçersiz ürün.');
            const b = req.body || {};
            let reason;
            if (b.reason !== undefined && b.reason !== '') {
                if (!REASONS.includes(b.reason)) return fail(res, 400, 'Düşme nedeni geçersiz.');
                reason = b.reason;
            }
            let r;
            if (b.all === true) {
                r = await service.removeExpiry(ref, { all: true, reason }, req.user.name);
            } else {
                if (!validDateKey(b.key)) return fail(res, 400, 'Tarih geçersiz.');
                const quantity = b.quantity === undefined ? undefined : parseQty(b.quantity);
                if (quantity === null) return fail(res, 400, 'Adet geçersiz.');
                r = await service.removeExpiry(ref, { key: b.key, quantity, reason }, req.user.name);
            }
            if (!r) return fail(res, 404, 'Ürün bulunamadı.');
            if (r.notFound) return fail(res, 404, 'Bu tarihte kayıt yok.');
            res.json({ success: true, removed: r.removed, product: service.toView(r.product) });
        },
    };

    // ---------- Mini App (/api) ----------
    const tg = express.Router();
    tg.use(auth.telegramAuth(isMember));
    tg.get('/urun/:barcode', wrap(h.lookup));
    tg.post('/urun/kaydet', wrap(h.save));
    tg.post('/dus/:ref', wrap(h.remove));
    app.use('/api', tg);

    // ---------- Admin paneli (/admin/api) ----------
    const adm = express.Router();
    adm.use((req, res, next) => (req.method === 'GET' ? next() : auth.requireAjaxHeader(req, res, next)));

    const sendErr = (res, r) => res.status(r.status).json({ success: false, code: r.error, message: r.message, ...(r.ip ? { ip: r.ip } : {}) });
    const setSessionCookie = (req, res, sid, maxAgeSec) => {
        const secure = req.secure || req.get('X-Forwarded-Proto') === 'https';
        res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
    };

    // --- Herkese açık: durum, kurulum, giriş, davet ---
    adm.get('/durum', wrap(async (req, res) => {
        res.json({ success: true, setupNeeded: await A.needsSetup(), ip: normalizeIp(req.ip), env: config.env });
    }));
    adm.post('/kurulum', wrap(async (req, res) => {
        const r = await A.setup(req.body || {}, req.ip);
        if (r.error) return sendErr(res, r);
        setSessionCookie(req, res, r.sid, r.maxAgeSec);
        res.status(201).json({ success: true });
    }));
    adm.post('/giris', wrap(async (req, res) => {
        const r = await A.login(req.body || {}, req.ip);
        if (r.error) return sendErr(res, r);
        setSessionCookie(req, res, r.sid, r.maxAgeSec);
        res.json({ success: true });
    }));
    adm.get('/davet/:token', wrap(async (req, res) => {
        const r = await A.inviteInfo(req.params.token, req.ip);
        if (r.error) return sendErr(res, r);
        res.json({ success: true, ...r });
    }));
    adm.post('/davet/kabul', wrap(async (req, res) => {
        const r = await A.acceptInvite(req.body || {}, req.ip);
        if (r.error) return sendErr(res, r);
        setSessionCookie(req, res, r.sid, r.maxAgeSec);
        res.status(201).json({ success: true, rebound: Boolean(r.rebound) });
    }));

    // --- Buradan sonrası oturum ister ---
    adm.use(wrap(async (req, res, next) => {
        const a = await A.authenticate(parseCookies(req.headers.cookie).sid, req.ip);
        if (!a) return res.status(401).json({ success: false, code: 'LOGIN', message: 'Oturum gerekli.' });
        if (a.error === 'IP_CHANGED') {
            return res.status(403).json({ success: false, code: 'IP_CHANGED', ip: a.ip, message: 'IP adresiniz değişti. Yöneticinizden yeni bir bağlantı/QR isteyin.' });
        }
        req.admin = a;
        req.user = { id: String(a.user._id), name: a.user.name, via: 'admin', role: a.user.role };
        req.can = (p) => a.perms.has(p);
        // Fiyat/tutar yetkisi yoksa bu alanlar hiç gönderilmez (sadece arayüzde gizlemek yetmez)
        if (!a.perms.has('finance.view')) {
            const orig = res.json.bind(res);
            res.json = (body) => orig(redactMoney(body));
            if (req.body && typeof req.body === 'object') delete req.body.price;
        }
        next();
    }));
    const need = (...perms) => (req, res, next) => (perms.some((p) => req.can(p))
        ? next()
        : fail(res, 403, 'Bu işlem için yetkiniz yok.', { code: 'FORBIDDEN' }));

    adm.post('/cikis', wrap(async (req, res) => {
        await A.logout(parseCookies(req.headers.cookie).sid);
        res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
        res.json({ success: true });
    }));
    adm.get('/me', (req, res) => res.json({ success: true, env: config.env, me: A.describe(req.admin, req.ip) }));
    adm.post('/parola', wrap(async (req, res) => {
        const r = await A.changePassword(req.admin, req.body || {}, req.ip);
        if (r.error) return sendErr(res, r);
        res.json({ success: true });
    }));

    // --- Raf, ürün, analiz ---
    adm.get('/stats', need('dashboard.view', 'approve.manage'), wrap(async (req, res) => {
        res.json({ success: true, stats: await service.stats() });
    }));

    adm.get('/analiz', need('dashboard.view', 'users.view', 'brands.view'), wrap(async (req, res) => {
        const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
        const a = await service.analytics({ days });
        if (!req.can('dashboard.view')) { delete a.totals; delete a.daily; delete a.reasons; delete a.buckets; delete a.products; }
        if (!req.can('users.view')) delete a.users;
        if (!req.can('brands.view')) { delete a.brands; delete a.topProducts; }
        res.json({ success: true, ...a });
    }));

    adm.get('/liste', need('skt.view'), wrap(async (req, res) => {
        const parsed = parseInt(req.query.days, 10);
        const days = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 3650) : null; // null: hepsi
        res.json({ success: true, data: await service.listExpiring(days) });
    }));

    adm.get('/urunler', need('products.view'), wrap(async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
        res.json({ success: true, ...(await service.listProducts({ q: cleanStr(String(req.query.q || ''), 80), limit, skip })) });
    }));

    adm.get('/urun/:ref', need('products.view', 'approve.manage'), wrap(async (req, res) => {
        if (!REF_RE.test(req.params.ref)) return fail(res, 400, 'Geçersiz ürün.');
        const doc = await service.findByRef(req.params.ref);
        if (!doc) return fail(res, 404, 'Ürün bulunamadı.');
        res.json({ success: true, product: service.toView(doc) });
    }));

    adm.get('/onay', need('approve.manage'), wrap(async (req, res) => res.json({ success: true, data: await service.pendingProducts() })));
    adm.post('/onay/hepsi', need('approve.manage'), wrap(async (req, res) => {
        res.json({ success: true, approved: await service.approveAll(req.user.name) });
    }));
    adm.post('/onay/:ref', need('approve.manage'), wrap(async (req, res) => {
        if (!REF_RE.test(req.params.ref)) return fail(res, 400, 'Geçersiz ürün.');
        const product = await service.approveProduct(req.params.ref, req.user.name);
        if (!product) return fail(res, 404, 'Ürün bulunamadı.');
        res.json({ success: true, product });
    }));

    adm.get('/sistem', need('system.view'), wrap(async (req, res) => {
        const info = await service.systemInfo();
        const mem = process.memoryUsage();
        res.json({
            success: true, ...info,
            server: {
                env: config.env, node: process.version, uptimeSec: Math.round(process.uptime()),
                memoryMB: Math.round(mem.rss / 1048576), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            },
            bots: getStatus(),
        });
    }));

    adm.get('/barkod/:barcode', need('products.view', 'products.edit'), wrap(h.lookup));
    adm.post('/urun/kaydet', need('products.edit'), wrap(h.save));
    adm.post('/dus/:ref', need('skt.remove'), wrap(h.remove));

    adm.patch('/urun/:ref', need('products.edit'), wrap(async (req, res) => {
        const ref = req.params.ref;
        if (!REF_RE.test(ref)) return fail(res, 400, 'Geçersiz ürün.');
        const b = req.body || {};
        const price = parsePriceVal(b.price);
        if (Number.isNaN(price)) return fail(res, 400, 'Fiyat geçersiz.');
        if (b.reminderDays !== undefined && !(Number.isInteger(b.reminderDays) && b.reminderDays >= 1 && b.reminderDays <= 365)) {
            return fail(res, 400, 'Hatırlatma günü 1-365 olmalı.');
        }

        const res1 = await service.updateProduct(ref, {
            name: cleanStr(b.name) || undefined,
            brand: b.brand === undefined ? undefined : cleanStr(b.brand, 60),
            category: cleanStr(b.category, 30) || undefined,
            reminderDays: b.reminderDays,
            price,
        }, req.user.name);
        if (!res1) return fail(res, 404, 'Ürün bulunamadı.');
        if (res1.conflict) return fail(res, 409, `Bu adla başka bir ürün var: ${res1.conflict.productName}`);

        if (b.barcode !== undefined && String(b.barcode || '').trim() !== (res1.product.barcode || '')) {
            const code = String(b.barcode || '').trim();
            if (!BARCODE_RE.test(code)) return fail(res, 400, 'Geçersiz barkod.');
            const r2 = await service.attachBarcode(ref, code);
            if (r2.error === 'DUPLICATE') return fail(res, 409, `Bu barkod zaten kayıtlı: ${r2.existing.productName}`);
        }
        res.json({ success: true, product: service.toView(await service.findByRef(ref)) });
    }));

    adm.delete('/urun/:ref', need('products.delete'), wrap(async (req, res) => {
        if (!REF_RE.test(req.params.ref)) return fail(res, 400, 'Geçersiz ürün.');
        const r = await service.deleteProduct(req.params.ref, req.user.name);
        if (!r) return fail(res, 404, 'Ürün bulunamadı.');
        res.json({ success: true, deleted: r.deleted });
    }));

    adm.get('/loglar', need('logs.view'), wrap(async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const type = ['add', 'remove', 'create', 'edit', 'delete', 'approve'].includes(req.query.type) ? req.query.type : undefined;
        const user = cleanStr(String(req.query.user || ''), 80) || undefined;
        res.json({ success: true, data: await service.recentLogs(limit, { type, user }) });
    }));

    // --- Ekip: hesaplar, QR davetler, roller ---
    const team = (fn) => wrap(async (req, res) => {
        const r = await fn(req);
        if (r.error) return sendErr(res, r);
        res.json({ success: true, ...r });
    });
    adm.get('/ekip', team((req) => A.listTeam(req.admin)));
    adm.post('/ekip/davet', team((req) => A.createInvite(req.admin, req.body || {}, req.ip)));
    adm.delete('/ekip/davet/:id', team((req) => A.revokeInvite(req.admin, req.params.id, req.ip)));
    adm.patch('/ekip/kullanici/:id', team((req) => A.updateUser(req.admin, req.params.id, req.body || {}, req.ip)));
    adm.post('/ekip/kullanici/:id/ip-davet', team((req) => A.createRebindInvite(req.admin, req.params.id, req.body || {}, req.ip)));
    adm.post('/ekip/kullanici/:id/oturumlari-kapat', team((req) => A.closeSessions(req.admin, req.params.id, req.ip)));
    adm.delete('/ekip/kullanici/:id', team((req) => A.deleteUser(req.admin, req.params.id, req.ip)));
    adm.put('/ekip/roller', team((req) => A.setMatrix(req.admin, req.body?.matrix, req.ip)));
    adm.get('/ekip/denetim', team((req) => A.auditLog(req.admin)));

    app.use('/admin/api', adm);

    // ---------- Sayfalar ----------
    app.get('/health', (req, res) => res.json({ ok: true, env: config.env }));
    app.get('/kamera', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kamera.html')));
    const sendAdminPage = (req, res) => {
        res.setHeader('Content-Security-Policy',
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    };
    app.get('/admin', sendAdminPage);
    app.get('/admin/davet/:token', sendAdminPage);

    // JSON ayrıştırma hataları vb.
    app.use((err, req, res, next) => {
        if (err.type === 'entity.parse.failed' || err.status === 400) return fail(res, 400, 'Geçersiz istek.');
        console.error('Beklenmeyen hata:', err);
        fail(res, 500, 'Sunucu hatası oluştu.');
    });

    return app.listen(config.port, () => {
        console.log(`🌐 API çalışıyor -> http://localhost:${config.port}/health | Admin: /admin`);
    });
}

module.exports = apiStarter;