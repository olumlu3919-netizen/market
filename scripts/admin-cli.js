// scripts/admin-cli.js
// Kurtarma aracı: sunucuya erişimi olan kişi (sen) panel hesaplarını buradan yönetir.
// Örn. sahibin IP'si değişip panele giremez hale gelirse:
//
//   node scripts/admin-cli.js list                       -> hesapları listeler
//   node scripts/admin-cli.js reset-ip sahip@market.com  -> IP bağını siler; bir sonraki başarılı girişte yeni IP'ye bağlanır
//   node scripts/admin-cli.js set-password <e-posta>     -> yeni parola sorar (ekranda görünmez)
//   node scripts/admin-cli.js kill-sessions <e-posta>    -> açık oturumları kapatır
//   node scripts/admin-cli.js unlock-ip <e-posta>        -> IP kilidini kapatır (her IP'den giriş)
//
// Hangi veritabanında çalışacağı ortamdan gelir: canlıda NODE_ENV=production node scripts/admin-cli.js ...
const readline = require('readline');
const { MongoClient } = require('mongodb');

function askHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const out = rl.output;
        let muted = false;
        rl._writeToOutput = (str) => { if (!muted) out.write(str); else if (/[\r\n]/.test(str)) out.write('\n'); };
        rl.question(question, (answer) => { rl.close(); resolve(answer); });
        muted = true;
    });
}

// db ve parola sorma işlevi dışarıdan verilir (test edilebilsin diye)
async function run(db, argv, { ask = askHidden, log = console.log, hashPassword } = {}) {
    const [cmd, emailArg] = argv;
    const users = db.collection('admin_users');
    const sessions = db.collection('admin_sessions');
    const email = String(emailArg || '').trim().toLowerCase();

    if (cmd === 'list') {
        const all = await users.find({}).sort({ createdAt: 1 }).toArray();
        if (!all.length) { log('Hiç hesap yok. Panel ilk açılışta kurulum ekranını gösterir.'); return 0; }
        for (const u of all) {
            log(`${u.role.padEnd(9)} ${u.status.padEnd(9)} ${u.email.padEnd(32)} IP: ${u.ipLock === false ? '(kilit yok)' : (u.boundIp || '(bağlı değil)')}`);
        }
        return all.length;
    }

    if (!['reset-ip', 'set-password', 'kill-sessions', 'unlock-ip'].includes(cmd) || !email) {
        log('Kullanım: node scripts/admin-cli.js <list | reset-ip | set-password | kill-sessions | unlock-ip> [e-posta]');
        return -1;
    }
    const user = await users.findOne({ email });
    if (!user) { log(`Hesap bulunamadı: ${email}`); return -1; }

    if (cmd === 'reset-ip') {
        await users.updateOne({ _id: user._id }, { $set: { boundIp: null } });
        log(`✅ ${email}: IP bağı silindi. Bir sonraki başarılı girişte bulunduğu IP'ye bağlanacak.`);
    } else if (cmd === 'unlock-ip') {
        await users.updateOne({ _id: user._id }, { $set: { ipLock: false, boundIp: null } });
        log(`✅ ${email}: IP kilidi kapatıldı. Panelden tekrar açabilirsiniz.`);
    } else if (cmd === 'kill-sessions') {
        await sessions.deleteMany({ userId: user._id });
        log(`✅ ${email}: açık oturumlar kapatıldı.`);
    } else if (cmd === 'set-password') {
        const p1 = await ask('Yeni parola (en az 10 karakter): ');
        if (!p1 || p1.length < 10) { log('❌ Parola en az 10 karakter olmalı.'); return -1; }
        const p2 = await ask('Tekrar: ');
        if (p1 !== p2) { log('❌ Parolalar uyuşmuyor.'); return -1; }
        await users.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(p1) } });
        await sessions.deleteMany({ userId: user._id });
        log(`✅ ${email}: parola değiştirildi, tüm oturumlar kapatıldı.`);
    }
    return 0;
}

module.exports = { run };

if (require.main === module) {
    const config = require('../config');
    const { hashPassword } = require('../AdminAuth');
    (async () => {
        const client = new MongoClient(config.mongo.url);
        await client.connect();
        console.log(`DB: ${config.mongo.dbName} (${config.env})`);
        const code = await run(client.db(config.mongo.dbName), process.argv.slice(2), { hashPassword });
        await client.close();
        process.exit(code < 0 ? 1 : 0);
    })().catch((e) => { console.error('Hata:', e.message); process.exit(1); });
}