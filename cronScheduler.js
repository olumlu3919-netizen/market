const cron = require('node-cron');
const axios = require('axios');
const { sendNotification } = require('./telegramBot');
const { response } = require('express');

const API_BASE_URL = process.env.API_BASE_URL;


function startCronScheduler() {

    cron.schedule('0 11 * * *', async () => {
        try {
            const response = await axios.get(`${API_BASE_URL}/liste`)
            if (response.data.success && response.data.data.length > 0) {
                const records = response.data.data;
                const criticalRecords = records.filter(item => {
                    const reminderLimit = item.productReminder || 7;
                    return item.remainingDay <= reminderLimit || item.remainingDay <= 7;
                });


                if (criticalRecords.length === 0) {
                    await sendNotification("⏰ Cron: Bugün hatırlatılacak kritik SKT ürünü yok.");
                    return;
                }
                let reportMessage = `🔔 *GÜNLÜK OTOMATİK SKT HATIRLATMASI*\n\n`;
                reportMessage += `Hatırlatma süresi yaklaşan veya geçen *${criticalRecords.length}* ürün bulundu:\n\n`;

                criticalRecords.forEach(item => {
                    let emoji = "🟢";
                    let statusText = `(Kalan: *${item.remainingDay} gün*)`;

                    if (item.remainingDay < 0) {
                        emoji = "💀";
                        statusText = `*(SÜRESİ GEÇTİ!)*`;
                    } else if (item.remainingDay === 0) {
                        emoji = "☠️";
                        statusText = `*(BUGÜN BİTİYOR!)*`;
                    } else if (item.remainingDay <= 3) {
                        emoji = "🔴";
                    } else if (item.remainingDay <= 7) {
                        emoji = "🟠";
                    }

                    reportMessage += `${emoji} *${item.productName}*\n ⏳ SKT: ${item.viewDate} ${statusText}\n\n`;
                });

                reportMessage += `💡 _Lütfen raftaki ürünleri kontrol edip düşümlerini (!dus) yapınız._`;

                await sendNotification(reportMessage)
            };

        } catch (error) {
            console.error("⏰ Cron Servisi Hatası:", error.response?.data || error.message);
        }
    });
};

module.exports = startCronScheduler;