// cronScheduler.js
const cron = require('node-cron');
const { sendNotification } = require('./telegramBot');

function startCronScheduler(service) {
    // Her gün 11:00 (İstanbul saati, sunucu UTC olsa bile)
    cron.schedule('0 11 * * *', async () => {
        try {
            // En fazla 30 gün ilerisi + süresi geçenler
            const records = await service.listExpiring(30);

            // Ürünün kendi hatırlatma süresi (kategoriye göre), yoksa 7 gün
            const critical = records.filter((item) => item.remainingDay <= (item.productReminder || 7));

            if (critical.length === 0) {
                await sendNotification('⏰ Bugün hatırlatılacak kritik SKT ürünü yok.');
                return;
            }

            let report = '🔔 *GÜNLÜK OTOMATİK SKT HATIRLATMASI*\n\n';
            report += `Hatırlatma süresi yaklaşan veya geçen *${critical.length}* kayıt bulundu:\n\n`;

            for (const item of critical) {
                let emoji = '🟢';
                let status = `(Kalan: *${item.remainingDay} gün*)`;

                if (item.remainingDay < 0) {
                    emoji = '💀';
                    status = '*(SÜRESİ GEÇTİ!)*';
                } else if (item.remainingDay === 0) {
                    emoji = '☠️';
                    status = '*(BUGÜN BİTİYOR!)*';
                } else if (item.remainingDay <= 3) {
                    emoji = '🔴';
                } else if (item.remainingDay <= 7) {
                    emoji = '🟠';
                }

                report += `${emoji} *${item.productName}* (${item.quantity} adet)\n⏳ SKT: ${item.viewDate} ${status}\n\n`;
            }

            report += '💡 _Lütfen raftaki ürünleri kontrol edip düşümlerini (!dus) yapınız._';
            await sendNotification(report);
        } catch (error) {
            console.error('⏰ Cron Servisi Hatası:', error.message);
        }
    }, { timezone: 'Europe/Istanbul' });

    console.log('⏰ Cron zamanlayıcı başlatıldı (her gün 11:00 İstanbul)');
}

module.exports = startCronScheduler;