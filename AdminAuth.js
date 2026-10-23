// adminAuth.js
// Web panelin hesap sistemi.
//  - Roller: dev > mudur > yardimci > personel (herkes sadece kendinden alt seviyeyi davet eder / yönetir)
//  - Yetkiler role göre matristen gelir; kişiye özel "izin ver / yasakla" istisnası eklenebilir
//  - Hesap açma: ilk hesap (dev) kurulum anahtarıyla, diğerleri tek kullanımlık QR/bağlantı davetiyle
//  - IP bağlama: hesap kayıt olunan IP'ye bağlanır, IP değişirse giriş reddedilir
const crypto = require('crypto');
const net = require('net');
const { promisify } = require('util');
const { ObjectId } = require('mongodb');
const config = require('./config');

const scrypt = promisify(crypto.scrypt);
const SETUP_KEY = process.env.ADMIN_PASSWORD || ''; // sadece ilk kurulumda "kurulum anahtarı" olarak kullanılır
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ---------- Yetkiler ve roller ----------
const PERMISSIONS = [
    ['dashboard.view', 'Genel bakış ve grafikler'],
    ['finance.view', 'Fiyat ve tutarları görme'],
    ['skt.view', 'SKT listesini görme'],
    ['skt.remove', 'Ürün düşme (satıldı / iade / zayi)'],
    ['products.view', 'Ürünleri görme'],
    ['products.edit', 'Ürün ekleme ve düzenleme'],
    ['products.delete', 'Ürün silme'],
    ['approve.manage', 'Yeni ürünleri onaylama'],
    ['users.view', 'Kullanıcı analizi'],
    ['brands.view', 'Marka iade / zayi analizi'],
    ['logs.view', 'İşlem kayıtları'],
    ['system.view', 'Sistem ve veritabanı bilgisi'],
    ['team.invite', 'QR davet oluşturma'],
    ['team.manage', 'Hesap, rol ve yetki yönetimi'],
];
const ALL = PERMISSIONS.map((p) => p[0]);

const ROLES = {
    dev: { level: 100, label: 'Geliştirici (sahip)' },
    mudur: { level: 70, label: 'Müdür' },
    yardimci: { level: 40, label: 'Müdür yardımcısı' },
    personel: { level: 10, label: 'Personel' },
};
const LEVEL = (role) => ROLES[role]?.level ?? 0;

const DEFAULT_MATRIX = {
    mudur: ALL.filter((p) => p !== 'team.manage'),
    yardimci: ['dashboard.view', 'skt.view', 'skt.remove', 'products.view', 'products.edit', 'approve.manage', 'brands.view', 'logs.view'],
    personel: ['skt.view', 'skt.remove', 'products.view'],
};

// ---------- Yardımcılar ----------
const err = (status, code, message, extra = {}) => ({ error: code, status, message, ...extra });
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

function safeEqual(a, b) {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
}

// IP'yi karşılaştırılabilir hale getirir: IPv4-mapped sadeleşir, IPv6 /64 ön ekine iner, yerel adresler tek sayılır
function normalizeIp(raw) {
    let ip = String(raw || '').trim().split('%')[0];
    if (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
    if (ip === '::1' || ip === '127.0.0.1') return 'localhost';
    if (net.isIPv4(ip)) return ip;
    if (net.isIPv6(ip)) {
        const [head, tail] = ip.split('::');
        const h = head ? head.split(':') : [];
        const t = tail !== undefined && tail ? tail.split(':') : [];
        const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
        return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':').toLowerCase() + '::/64';
    }
    return ip || 'bilinmiyor';
}

async function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(String(pw), salt, 64);
    return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
    const [alg, s, k] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !s || !k) return false;
    const key = await scrypt(String(pw), Buffer.from(s, 'base64'), 64);
    const expected = Buffer.from(k, 'base64');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
let dummyHashPromise = null; // kullanıcı yoksa da aynı süreyi harcamak için
const dummyVerify = async (pw) => { dummyHashPromise = dummyHashPromise || hashPassword('dummy-parola'); return verifyPassword(pw, await dummyHashPromise); };

function makeLimiter(max, windowMs) {
    const map = new Map();
    return {
        blocked(key) { const r = map.get(key); return Boolean(r && r.reset > Date.now() && r.count >= max); },
        hit(key) {
            const now = Date.now();
            const r = map.get(key);
            if (!r || r.reset <= now) map.set(key, { count: 1, reset: now + windowMs });
            else r.count += 1;
        },
        clear(key) { map.delete(key); },
    };
}

function validateProfile({ name, email, password }, { needEmail = true, needPassword = true } = {}) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 60) return 'Ad 2-60 karakter olmalı.';
    if (needEmail && (!EMAIL_RE.test(email) || email.length > 120)) return 'Geçerli bir e-posta girin.';
    if (needPassword) {
        if (typeof password !== 'string' || password.length < 10) return 'Parola en az 10 karakter olmalı.';
        if (password.length > 200) return 'Parola çok uzun.';
        if (password.toLowerCase() === String(email).toLowerCase()) return 'Parola e-posta ile aynı olamaz.';
    }
    return null;
}

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

// Müşteri sunucusuna giden JSON'da fiyat/tutar alanlarını temizler (finance.view yetkisi yoksa)
const MONEY_KEYS = new Set(['price', 'value', 'lostValue', 'expiredValue', 'soonValue', 'priceHistory']);
function redactMoney(v) {
    if (Array.isArray(v)) return v.map(redactMoney);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
        const out = {};
        for (const [k, x] of Object.entries(v)) if (!MONEY_KEYS.has(k)) out[k] = redactMoney(x);
        return out;
    }
    return v;
}

async function makeQr(text) {
    try {
        const QRCode = require('qrcode');
        return await QRCode.toString(text, { type: 'svg', margin: 1, width: 240 });
    } catch (e) {
        console.error('QR üretilemedi (npm install qrcode):', e.message);
        return null;
    }
}

function createAdminAuth(db) {
    const users = db.collection('admin_users');
    const invites = db.collection('admin_invites');
    const sessions = db.collection('admin_sessions');
    const settings = db.collection('admin_settings');
    const auditCol = db.collection('admin_audit');

    const loginLimiter = makeLimiter(5, 15 * 60 * 1000);
    const setupLimiter = makeLimiter(5, 15 * 60 * 1000);
    const inviteLimiter = makeLimiter(15, 15 * 60 * 1000);
    let matrixCache = { at: 0, value: null };

    const toId = (id) => (/^[a-f0-9]{24}$/i.test(String(id)) ? new ObjectId(String(id)) : null);

    async function init() {
        await users.createIndex({ email: 1 }, { unique: true });
        await users.createIndex({ role: 1 }, { unique: true, partialFilterExpression: { role: 'dev' } }); // tek sahip
        await invites.createIndex({ tokenHash: 1 }, { unique: true });
        await invites.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 7 * 86400 });
        await sessions.createIndex({ exp: 1 }, { expireAfterSeconds: 0 });
        await auditCol.createIndex({ at: 1 }, { expireAfterSeconds: 180 * 86400 });
    }

    function audit(action, { actor, target, ip, detail } = {}) {
        auditCol.insertOne({ at: new Date(), action, actor: actor || null, target: target || null, ip: ip ? normalizeIp(ip) : null, detail: detail || null })
            .catch((e) => console.error('Denetim kaydı yazılamadı:', e.message));
    }

    // ---------- Yetki matrisi ----------
    async function getMatrix() {
        if (matrixCache.value && Date.now() - matrixCache.at < 15000) return matrixCache.value;
        const doc = await settings.findOne({ _id: 'roles' });
        const matrix = { ...DEFAULT_MATRIX, ...(doc?.matrix || {}) };
        matrixCache = { at: Date.now(), value: matrix };
        return matrix;
    }

    async function setMatrix(actor, input, ip) {
        if (actor.user.role !== 'dev') return err(403, 'FORBIDDEN', 'Rol yetkilerini sadece sahip değiştirebilir.');
        const next = {};
        for (const role of ['mudur', 'yardimci', 'personel']) {
            const list = Array.isArray(input?.[role]) ? input[role] : DEFAULT_MATRIX[role];
            next[role] = [...new Set(list.filter((p) => ALL.includes(p)))]
                .filter((p) => !(p === 'team.manage' && LEVEL(role) < LEVEL('mudur'))); // alt roller hesap yönetemez
        }
        await settings.updateOne({ _id: 'roles' }, { $set: { matrix: next, updatedAt: new Date() } }, { upsert: true });
        matrixCache = { at: 0, value: null };
        audit('roles_update', { actor: actor.user.email, ip });
        return { matrix: await getMatrix() };
    }

    function permsFor(user, matrix) {
        if (user.role === 'dev') return new Set(ALL);
        const set = new Set(matrix[user.role] || []);
        for (const p of user.grant || []) if (ALL.includes(p)) set.add(p);
        for (const p of user.revoke || []) set.delete(p);
        return set;
    }

    // ---------- Oturumlar ----------
    async function startSession(user) {
        const sid = crypto.randomBytes(32).toString('hex');
        await sessions.insertOne({ _id: sha256(sid), userId: user._id, createdAt: new Date(), exp: new Date(Date.now() + SESSION_TTL_MS) });
        return { sid, maxAgeSec: SESSION_TTL_MS / 1000 };
    }

    async function authenticate(sid, ip) {
        if (!sid) return null;
        const s = await sessions.findOne({ _id: sha256(sid) });
        if (!s || new Date(s.exp) < new Date()) return null;
        const user = await users.findOne({ _id: s.userId });
        if (!user || user.status !== 'active') return null;
        const nip = normalizeIp(ip);
        if (user.ipLock && user.boundIp && user.boundIp !== nip) {
            await sessions.deleteOne({ _id: s._id });
            audit('session_ip_blocked', { actor: user.email, ip: nip });
            return { error: 'IP_CHANGED', ip: nip };
        }
        return { user, perms: permsFor(user, await getMatrix()), sessionId: s._id };
    }

    async function logout(sid) {
        if (sid) await sessions.deleteOne({ _id: sha256(sid) });
    }

    // ---------- Kurulum (ilk hesap = dev) ----------
    async function needsSetup() {
        return (await users.countDocuments({})) === 0;
    }

    async function setup({ key, name, email, password, ipLock = true }, ip) {
        const nip = normalizeIp(ip);
        if (setupLimiter.blocked(nip)) return err(429, 'RATE', 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.');
        if (SETUP_KEY.length < 8) return err(503, 'SETUP_DISABLED', 'Kurulum için sunucuda ADMIN_PASSWORD (en az 8 karakter) tanımlı olmalı.');
        if (!(await needsSetup())) return err(403, 'ALREADY', 'Kurulum zaten yapılmış. Giriş yapın.');
        if (!safeEqual(key || '', SETUP_KEY)) {
            setupLimiter.hit(nip);
            audit('setup_fail', { ip: nip });
            return err(401, 'BAD_KEY', 'Kurulum anahtarı hatalı.');
        }
        const mail = normEmail(email);
        const problem = validateProfile({ name, email: mail, password });
        if (problem) return err(400, 'INVALID', problem);

        const doc = {
            email: mail, name: name.trim(), role: 'dev', passwordHash: await hashPassword(password), status: 'active',
            ipLock: ipLock !== false, boundIp: ipLock !== false ? nip : null, grant: [], revoke: [],
            createdAt: new Date(), createdBy: null, lastLoginAt: new Date(), lastIp: nip,
        };
        try {
            const { insertedId } = await users.insertOne(doc);
            doc._id = insertedId;
        } catch (e) {
            return err(403, 'ALREADY', 'Kurulum zaten yapılmış. Giriş yapın.');
        }
        audit('setup_ok', { actor: mail, ip: nip });
        return { user: doc, ...(await startSession(doc)) };
    }

    // ---------- Giriş ----------
    async function login({ email, password }, ip) {
        const nip = normalizeIp(ip);
        const mail = normEmail(email);
        if (loginLimiter.blocked(nip) || loginLimiter.blocked('e:' + mail)) {
            return err(429, 'RATE', 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.');
        }
        const user = mail ? await users.findOne({ email: mail }) : null;
        const ok = user ? await verifyPassword(password || '', user.passwordHash) : (await dummyVerify(password || ''), false);
        if (!ok) {
            loginLimiter.hit(nip); loginLimiter.hit('e:' + mail);
            audit('login_fail', { actor: mail, ip: nip });
            return err(401, 'BAD_LOGIN', 'E-posta veya parola hatalı.');
        }
        if (user.status !== 'active') return err(403, 'DISABLED', 'Bu hesap devre dışı bırakılmış.');

        if (user.ipLock) {
            if (!user.boundIp) {
                await users.updateOne({ _id: user._id }, { $set: { boundIp: nip } }); // sıfırlanmış hesap: bu IP'ye bağlanır
                user.boundIp = nip;
                audit('ip_bound', { actor: user.email, ip: nip });
            } else if (user.boundIp !== nip) {
                audit('login_ip_blocked', { actor: user.email, ip: nip });
                return err(403, 'IP_CHANGED', 'IP adresiniz değişti. Güvenlik nedeniyle giriş reddedildi. Yöneticinizden yeni bir bağlantı/QR isteyin.', { ip: nip });
            }
        }
        loginLimiter.clear(nip); loginLimiter.clear('e:' + mail);
        await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date(), lastIp: nip } });
        audit('login_ok', { actor: user.email, ip: nip });
        return { user, ...(await startSession(user)) };
    }

    // ---------- Davetler ----------
    async function createInvite(actor, { role, email, hours, sameNetwork = true, ipLock = true }, ip) {
        if (!actor.perms.has('team.invite')) return err(403, 'FORBIDDEN', 'Davet oluşturma yetkiniz yok.');
        if (!ROLES[role] || role === 'dev' || LEVEL(role) >= LEVEL(actor.user.role)) {
            return err(403, 'HIERARCHY', 'Sadece kendi seviyenizden alt bir rol için davet oluşturabilirsiniz.');
        }
        let mail = null;
        if (email) {
            mail = normEmail(email);
            if (!EMAIL_RE.test(mail)) return err(400, 'INVALID', 'Geçerli bir e-posta girin.');
            if (await users.findOne({ email: mail })) return err(409, 'EXISTS', 'Bu e-posta ile zaten bir hesap var.');
        }
        const h = Math.min(Math.max(parseInt(hours, 10) || 24, 1), 168);
        const token = crypto.randomBytes(32).toString('base64url');
        const nip = normalizeIp(ip);
        const doc = {
            type: 'invite', tokenHash: sha256(token), role, email: mail,
            allowedIp: sameNetwork ? nip : null, ipLock: ipLock !== false,
            createdBy: { id: String(actor.user._id), name: actor.user.name }, createdAt: new Date(),
            expiresAt: new Date(Date.now() + h * 3600 * 1000), usedAt: null,
        };
        const { insertedId } = await invites.insertOne(doc);
        const link = `${config.publicUrl}/admin/davet/${token}`;
        audit('invite_create', { actor: actor.user.email, target: mail || role, ip: nip, detail: `${role}, ${h} saat${sameNetwork ? ', aynı ağ' : ''}` });
        return { id: String(insertedId), link, qrSvg: await makeQr(link), expiresAt: doc.expiresAt, restrictedToYourNetwork: Boolean(doc.allowedIp), role };
    }

    // Mevcut hesap için "yeni IP'ye taşı" bağlantısı
    async function createRebindInvite(actor, targetId, { hours, sameNetwork = false } = {}, ip) {
        if (!actor.perms.has('team.invite')) return err(403, 'FORBIDDEN', 'Bu işlem için yetkiniz yok.');
        const target = await users.findOne({ _id: toId(targetId) });
        if (!target) return err(404, 'NOT_FOUND', 'Hesap bulunamadı.');
        if (String(target._id) !== String(actor.user._id) && LEVEL(target.role) >= LEVEL(actor.user.role)) {
            return err(403, 'HIERARCHY', 'Bu hesap sizinle aynı veya üst seviyede.');
        }
        const h = Math.min(Math.max(parseInt(hours, 10) || 24, 1), 168);
        const token = crypto.randomBytes(32).toString('base64url');
        const nip = normalizeIp(ip);
        const doc = {
            type: 'rebind', tokenHash: sha256(token), userId: target._id, email: target.email, role: target.role,
            allowedIp: sameNetwork ? nip : null,
            createdBy: { id: String(actor.user._id), name: actor.user.name }, createdAt: new Date(),
            expiresAt: new Date(Date.now() + h * 3600 * 1000), usedAt: null,
        };
        const { insertedId } = await invites.insertOne(doc);
        const link = `${config.publicUrl}/admin/davet/${token}`;
        audit('rebind_create', { actor: actor.user.email, target: target.email, ip: nip });
        return { id: String(insertedId), link, qrSvg: await makeQr(link), expiresAt: doc.expiresAt, email: target.email };
    }

    async function findInvite(token) {
        if (!token || typeof token !== 'string' || token.length > 100) return null;
        return invites.findOne({ tokenHash: sha256(token) });
    }

    async function inviteInfo(token, ip) {
        const inv = await findInvite(token);
        if (!inv) return err(404, 'INVALID', 'Bağlantı geçersiz.');
        if (inv.usedAt) return err(410, 'USED', 'Bu bağlantı daha önce kullanılmış.');
        if (new Date(inv.expiresAt) < new Date()) return err(410, 'EXPIRED', 'Bağlantının süresi dolmuş. Yöneticinizden yenisini isteyin.');
        return {
            type: inv.type, role: inv.role, roleLabel: ROLES[inv.role]?.label || inv.role, email: inv.email || null,
            expiresAt: inv.expiresAt, networkRestricted: Boolean(inv.allowedIp),
            networkOk: !inv.allowedIp || inv.allowedIp === normalizeIp(ip),
        };
    }

    async function acceptInvite({ token, name, email, password }, ip) {
        const nip = normalizeIp(ip);
        if (inviteLimiter.blocked(nip)) return err(429, 'RATE', 'Çok fazla deneme. Biraz sonra tekrar deneyin.');
        inviteLimiter.hit(nip);
        const inv = await findInvite(token);
        if (!inv) return err(404, 'INVALID', 'Bağlantı geçersiz.');
        if (inv.usedAt) return err(410, 'USED', 'Bu bağlantı daha önce kullanılmış.');
        if (new Date(inv.expiresAt) < new Date()) return err(410, 'EXPIRED', 'Bağlantının süresi dolmuş.');
        if (inv.allowedIp && inv.allowedIp !== nip) {
            audit('invite_network_blocked', { target: inv.email || inv.role, ip: nip });
            return err(403, 'NETWORK_MISMATCH', 'Bu davet sadece daveti oluşturan kişinin ağından kabul edilebilir.');
        }

        const consume = async () => {
            const r = await invites.updateOne({ _id: inv._id, usedAt: null }, { $set: { usedAt: new Date(), usedIp: nip } });
            return (r?.modifiedCount ?? 0) === 1;
        };

        if (inv.type === 'rebind') {
            const user = await users.findOne({ _id: inv.userId });
            if (!user || user.status !== 'active') return err(404, 'NOT_FOUND', 'Hesap bulunamadı veya devre dışı.');
            if (normEmail(email) !== user.email || !(await verifyPassword(password || '', user.passwordHash))) {
                audit('rebind_fail', { actor: normEmail(email), ip: nip });
                return err(401, 'BAD_LOGIN', 'E-posta veya parola hatalı.');
            }
            if (!(await consume())) return err(410, 'USED', 'Bu bağlantı daha önce kullanılmış.');
            await users.updateOne({ _id: user._id }, { $set: { boundIp: user.ipLock ? nip : null, lastLoginAt: new Date(), lastIp: nip } });
            audit('rebind_ok', { actor: user.email, ip: nip });
            return { user, rebound: true, ...(await startSession(user)) };
        }

        const mail = inv.email || normEmail(email);
        const problem = validateProfile({ name, email: mail, password });
        if (problem) return err(400, 'INVALID', problem);
        if (await users.findOne({ email: mail })) return err(409, 'EXISTS', 'Bu e-posta ile zaten bir hesap var.');
        if (!(await consume())) return err(410, 'USED', 'Bu bağlantı daha önce kullanılmış.');

        const doc = {
            email: mail, name: name.trim(), role: inv.role, passwordHash: await hashPassword(password), status: 'active',
            ipLock: inv.ipLock !== false, boundIp: inv.ipLock !== false ? nip : null, grant: [], revoke: [],
            createdAt: new Date(), createdBy: inv.createdBy, lastLoginAt: new Date(), lastIp: nip,
        };
        try {
            const { insertedId } = await users.insertOne(doc);
            doc._id = insertedId;
        } catch (e) {
            await invites.updateOne({ _id: inv._id }, { $set: { usedAt: null } }); // e-posta çakıştı: daveti geri ver
            return err(409, 'EXISTS', 'Bu e-posta ile zaten bir hesap var.');
        }
        audit('invite_accept', { actor: mail, ip: nip, detail: inv.role });
        return { user: doc, ...(await startSession(doc)) };
    }

    async function revokeInvite(actor, id, ip) {
        const inv = await invites.findOne({ _id: toId(id) });
        if (!inv) return err(404, 'NOT_FOUND', 'Davet bulunamadı.');
        const mine = inv.createdBy?.id === String(actor.user._id);
        if (!mine && !actor.perms.has('team.manage')) return err(403, 'FORBIDDEN', 'Bu daveti iptal edemezsiniz.');
        await invites.deleteOne({ _id: inv._id });
        audit('invite_revoke', { actor: actor.user.email, target: inv.email || inv.role, ip });
        return { ok: true };
    }

    // ---------- Ekip yönetimi ----------
    const publicUser = (u, actor, manage) => {
        const isSelf = String(u._id) === String(actor.user._id);
        const lower = LEVEL(u.role) < LEVEL(actor.user.role);
        const base = {
            id: String(u._id), name: u.name, email: u.email, role: u.role, roleLabel: ROLES[u.role]?.label || u.role,
            status: u.status, ipLock: u.ipLock !== false, lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt || null,
            createdBy: u.createdBy?.name || null, self: isSelf,
            canManage: manage && lower && !isSelf, canRebind: actor.perms.has('team.invite') && (lower || isSelf),
        };
        if (manage) Object.assign(base, { boundIp: u.boundIp || null, lastIp: u.lastIp || null, grant: u.grant || [], revoke: u.revoke || [] });
        return base;
    };

    async function listTeam(actor) {
        const manage = actor.perms.has('team.manage');
        if (!manage && !actor.perms.has('team.invite')) return err(403, 'FORBIDDEN', 'Bu bölüm için yetkiniz yok.');
        const [all, inv, matrix] = await Promise.all([
            users.find({}).sort({ createdAt: 1 }).toArray(),
            invites.find({ usedAt: null }).sort({ createdAt: -1 }).toArray(),
            getMatrix(),
        ]);
        const now = new Date();
        return {
            users: all.map((u) => publicUser(u, actor, manage)),
            invites: inv.filter((i) => new Date(i.expiresAt) > now && (manage || i.createdBy?.id === String(actor.user._id))).map((i) => ({
                id: String(i._id), type: i.type, role: i.role, roleLabel: ROLES[i.role]?.label || i.role, email: i.email || null,
                createdBy: i.createdBy?.name || null, expiresAt: i.expiresAt, restrictedNetwork: Boolean(i.allowedIp),
            })),
            roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, level: r.level })),
            invitableRoles: Object.entries(ROLES).filter(([k, r]) => k !== 'dev' && r.level < LEVEL(actor.user.role)).map(([key, r]) => ({ key, label: r.label })),
            permissions: PERMISSIONS.map(([id, label]) => ({ id, label })),
            matrix: { dev: ALL, ...matrix },
            canEditMatrix: actor.user.role === 'dev',
            canManage: manage,
        };
    }

    async function updateUser(actor, id, patch, ip) {
        if (!actor.perms.has('team.manage')) return err(403, 'FORBIDDEN', 'Hesap yönetimi için yetkiniz yok.');
        const target = await users.findOne({ _id: toId(id) });
        if (!target) return err(404, 'NOT_FOUND', 'Hesap bulunamadı.');
        const self = String(target._id) === String(actor.user._id);
        if (!self && LEVEL(target.role) >= LEVEL(actor.user.role)) {
            return err(403, 'HIERARCHY', 'Kendinizle aynı veya üst seviyedeki hesapları yönetemezsiniz.');
        }
        const set = {};
        if (patch.name !== undefined) {
            if (validateProfile({ name: patch.name }, { needEmail: false, needPassword: false })) return err(400, 'INVALID', 'Ad 2-60 karakter olmalı.');
            set.name = patch.name.trim();
        }
        const touchesAccess = ['role', 'status', 'ipLock', 'grant', 'revoke', 'resetIp'].some((k) => patch[k] !== undefined);
        if (self && touchesAccess) return err(400, 'SELF', 'Kendi rolünüzü, durumunuzu veya yetkilerinizi buradan değiştiremezsiniz.');

        if (!self) {
            if (patch.role !== undefined) {
                if (!ROLES[patch.role] || patch.role === 'dev' || LEVEL(patch.role) >= LEVEL(actor.user.role)) {
                    return err(403, 'HIERARCHY', 'Bu rolü atayamazsınız.');
                }
                set.role = patch.role;
            }
            if (patch.status !== undefined) {
                if (!['active', 'disabled'].includes(patch.status)) return err(400, 'INVALID', 'Durum geçersiz.');
                set.status = patch.status;
            }
            if (patch.ipLock !== undefined) {
                set.ipLock = Boolean(patch.ipLock);
                if (!set.ipLock) set.boundIp = null;
            }
            if (patch.resetIp === true) set.boundIp = null; // bir sonraki başarılı girişte yeni IP'ye bağlanır
            for (const key of ['grant', 'revoke']) {
                if (patch[key] === undefined) continue;
                if (!Array.isArray(patch[key])) return err(400, 'INVALID', 'Yetki listesi geçersiz.');
                const list = [...new Set(patch[key].filter((p) => ALL.includes(p)))];
                if (key === 'grant') {
                    for (const p of list) {
                        if (!actor.perms.has(p)) return err(403, 'ESCALATION', `Sahip olmadığınız bir yetkiyi veremezsiniz: ${p}`);
                        if (p === 'team.manage' && actor.user.role !== 'dev') return err(403, 'ESCALATION', 'Hesap yönetimi yetkisini sadece sahip verebilir.');
                    }
                }
                set[key] = list;
            }
        }
        if (!Object.keys(set).length) return err(400, 'INVALID', 'Değiştirilecek bir alan yok.');
        await users.updateOne({ _id: target._id }, { $set: set });
        audit('user_update', { actor: actor.user.email, target: target.email, ip, detail: Object.keys(set).join(',') });
        return { user: publicUser(await users.findOne({ _id: target._id }), actor, true) };
    }

    async function closeSessions(actor, id, ip) {
        if (!actor.perms.has('team.manage')) return err(403, 'FORBIDDEN', 'Bu işlem için yetkiniz yok.');
        const target = await users.findOne({ _id: toId(id) });
        if (!target) return err(404, 'NOT_FOUND', 'Hesap bulunamadı.');
        if (String(target._id) !== String(actor.user._id) && LEVEL(target.role) >= LEVEL(actor.user.role)) return err(403, 'HIERARCHY', 'Bu hesap sizinle aynı veya üst seviyede.');
        await sessions.deleteMany({ userId: target._id });
        audit('sessions_close', { actor: actor.user.email, target: target.email, ip });
        return { ok: true };
    }

    async function deleteUser(actor, id, ip) {
        if (!actor.perms.has('team.manage')) return err(403, 'FORBIDDEN', 'Bu işlem için yetkiniz yok.');
        const target = await users.findOne({ _id: toId(id) });
        if (!target) return err(404, 'NOT_FOUND', 'Hesap bulunamadı.');
        if (String(target._id) === String(actor.user._id)) return err(400, 'SELF', 'Kendi hesabınızı silemezsiniz.');
        if (LEVEL(target.role) >= LEVEL(actor.user.role)) return err(403, 'HIERARCHY', 'Bu hesap sizinle aynı veya üst seviyede.');
        await users.deleteOne({ _id: target._id });
        await sessions.deleteMany({ userId: target._id });
        audit('user_delete', { actor: actor.user.email, target: target.email, ip });
        return { ok: true };
    }

    async function changePassword(actor, { current, next }, ip) {
        if (!(await verifyPassword(current || '', actor.user.passwordHash))) return err(401, 'BAD_LOGIN', 'Mevcut parola hatalı.');
        const problem = validateProfile({ name: 'xx', email: actor.user.email, password: next }, { needEmail: false });
        if (problem) return err(400, 'INVALID', problem);
        await users.updateOne({ _id: actor.user._id }, { $set: { passwordHash: await hashPassword(next) } });
        await sessions.deleteMany({ userId: actor.user._id, _id: { $ne: actor.sessionId } }); // diğer cihazlardaki oturumlar düşer
        audit('password_change', { actor: actor.user.email, ip });
        return { ok: true };
    }

    async function auditLog(actor, limit = 200) {
        if (!actor.perms.has('team.manage')) return err(403, 'FORBIDDEN', 'Bu bölüm için yetkiniz yok.');
        const rows = await auditCol.find({}).sort({ at: -1 }).limit(limit).toArray();
        return { data: rows.map((r) => ({ at: r.at, action: r.action, actor: r.actor, target: r.target, ip: r.ip, detail: r.detail })) };
    }

    function describe(auth, ip) {
        const u = auth.user;
        return {
            id: String(u._id), name: u.name, email: u.email, role: u.role, roleLabel: ROLES[u.role]?.label || u.role,
            permissions: [...auth.perms], ipLock: u.ipLock !== false, boundIp: u.boundIp || null, currentIp: normalizeIp(ip),
        };
    }

    return {
        init, needsSetup, setup, login, logout, authenticate, startSession, describe,
        createInvite, createRebindInvite, inviteInfo, acceptInvite, revokeInvite,
        listTeam, updateUser, closeSessions, deleteUser, changePassword, setMatrix, auditLog, getMatrix,
    };
}

module.exports = {
    createAdminAuth, normalizeIp, hashPassword, verifyPassword, redactMoney, parseCookies,
    PERMISSIONS, ROLES, DEFAULT_MATRIX, LEVEL,
};