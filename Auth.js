// auth.js
// Mini App (/api/*): Telegram'ın imzaladığı initData doğrulanır + kullanıcı ana grubun üyesi olmalı
// (ya da ALLOWED_TELEGRAM_IDS listesinde). Web panel hesapları için adminAuth.js'e bakın.
const crypto = require('crypto');
const config = require('./config');

const ALLOWED_IDS = (process.env.ALLOWED_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- Telegram Mini App ----------
function safeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length % 2) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch (e) {
        return false;
    }
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateInitData(initData, botToken = config.telegram.token, maxAgeSec = 24 * 60 * 60) {
    if (!initData || typeof initData !== 'string' || initData.length > 4096) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheck = [...params.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculated = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    if (!safeEqualHex(calculated, hash)) return null;

    const authDate = Number(params.get('auth_date'));
    if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;

    let user;
    try { user = JSON.parse(params.get('user')); } catch (e) { return null; }
    if (!user || !user.id) return null;
    return {
        id: user.id,
        name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id),
    };
}

const memberCache = new Map(); // userId -> { ok, at }
async function isAllowedUser(userId, isMember) {
    if (ALLOWED_IDS.includes(String(userId))) return true;
    const cached = memberCache.get(userId);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.ok;
    try {
        const ok = Boolean(await isMember(userId));
        memberCache.set(userId, { ok, at: Date.now() });
        return ok;
    } catch (e) {
        console.error('Üyelik kontrolü hatası:', e.message);
        return false; // hata durumunda önbelleğe yazma, tekrar denensin
    }
}

function telegramAuth(isMember) {
    return async (req, res, next) => {
        const user = validateInitData(req.get('X-Telegram-Init-Data'));
        if (!user) {
            return res.status(401).json({ success: false, message: 'Bu sayfa sadece Telegram içinden açılabilir.' });
        }
        if (!(await isAllowedUser(user.id, isMember))) {
            return res.status(403).json({ success: false, message: 'Bu işlem için market grubunun üyesi olmalısınız.' });
        }
        req.user = { id: user.id, name: user.name, via: 'telegram' };
        next();
    };
}

// Çerezle çalışan (admin) uçlarda CSRF'ye karşı: sadece fetch() ile gelen istekler kabul edilir
function requireAjaxHeader(req, res, next) {
    if (req.get('X-Requested-With') !== 'fetch') {
        return res.status(403).json({ success: false, message: 'Geçersiz istek.' });
    }
    next();
}

module.exports = { validateInitData, telegramAuth, requireAjaxHeader };