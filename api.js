const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { sendNotification } = require('./telegramBot');

let productsCollection;

let DOMAIN_URL = process.env.DOMAIN_URL;
const MODE = process.env.MODE;
if (MODE === 'dev') {
    DOMAIN_URL = process.env.DOMAIN_URL_DEV
}

function apiStarter(productsCollection) {
    const app = express();

    app.use(cors());
    app.use(express.json());

    app.use((req, res, next) => {
        res.setHeader('ngrok-skip-browser-warning', 'true');
        next();
    });

    app.get('/api/liste', async (req, res) => {
        try {
            const limit = req.query.limit ? parseInt(req.query.limit) : 14;
            const todayMs = new Date().getTime();

            let limitMs = null;
            if (limit && !isNaN(limit)) {
                limitMs = todayMs + (limit * 24 * 60 * 60 * 1000);
            }

            const products = await productsCollection.find({
                'productInfo': {
                    $exists: true,
                    $not: { $size: 0 }
                }
            }).toArray();

            if (products.length === 0) {
                return res.status(200).json({
                    success: true,
                    count: 0,
                    data: [],
                    message: "Sistemde ürün bulunamadı."
                });
            }

            let allDate = [];
            for (const product of products) {
                for (const info of product.productInfo) {
                    if (limitMs && info.timestamp > limitMs) {
                        continue;
                    }

                    const remainingMs = info.timestamp - todayMs;
                    const remainingDay = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));

                    if (remainingDay <= 0) {
                        continue;
                    }
                    allDate.push({
                        productName: product.productName,
                        timestamp: info.timestamp,
                        viewDate: info.viewDate,
                        remainingDay: remainingDay
                    });
                }
            }

            allDate.sort((a, b) => a.timestamp - b.timestamp);

            res.status(200).json({
                success: true,
                count: allDate.length,
                limitApplied: limit || false,
                data: allDate
            });

        } catch (error) {
            console.error("API Hatası (Liste):", error);
            res.status(500).json({
                success: false,
                message: "Liste çekilirken veritabanı hatası oluştu."
            });
        }
    });

    app.post('/api/ekle', async (req, res) => {
        try {
            const {
                productName,
                addDate,
                productInfo,
                addedBy,
                approver,
                brand,
                productCategory,
                productReminder
            } = req.body;

            if (!productName || !productInfo || !productInfo[0]) {
                return res.status(400).json({
                    success: false,
                    message: "Eksik veri: productName ve productInfo zorunludur!"
                });
            }

            if (!productName || !productInfo) {
                return res.status(400).json({
                    success: false,
                    message: "Ürün adı ve tarih bilgisi zorunludur!"
                });
            }


            const newRecord = {
                productName: productName,
                brand: brand || "",
                productCategory: productCategory || "",
                productReminder: productReminder || null,
                productInfo: {
                    expirationDate: productInfo[0].expirationDate,
                    timestamp: productInfo[0].timestamp,
                    viewDate: productInfo[0].viewDate
                },
                addedBy: addedBy || "API",
                approver: addedBy || "API"
            };

            const productExists = await productsCollection.findOne({
                productName: { $regex: new RegExp(`^${productName}$`, 'i') }
            });

            if (productExists) {
                const expDateExists = productExists.productInfo?.some(
                    record => record.expirationDate == newRecord.productInfo.expirationDate
                );

                if (expDateExists) {
                    return res.status(409).json({
                        success: false,
                        errorType: "DUPLICATE_DATE",
                        message: `Bu ürün için ${newRecord.productInfo.viewDate} tarihi zaten sistemde mevcut.`
                    });
                }

                await productsCollection.updateOne(
                    { _id: productExists._id },
                    {
                        $push: {
                            productInfo: {
                                $each: [newRecord.productInfo],
                                $sort: { timestamp: -1 }
                            }
                        }
                    }
                );
            } else {
                await productsCollection.insertOne({
                    productName: productName,
                    productCategory: newRecord.productCategory,
                    brand: newRecord.brand,
                    productReminder: newRecord.productReminder,
                    productInfo: [newRecord.productInfo],
                    addedBy: newRecord.addedBy,
                    approver: newRecord.approver,
                    addDate: new Date(),
                });
            }

            res.status(201).json({
                success: true,
                message: `${productInfo.viewDate} ürünü başarıyla eklendi.`,
                expirationDate: productInfo.viewDate
            });

        } catch (error) {
            console.error("API Hatası (Ekle):", error);
            res.status(500).json({
                success: false,
                message: "Ürün eklenirken veritabanı hatası oluştu."
            });
        }
    });

    app.post('/api/dus', async (req, res) => {
        try {
            const { productName, piece } = req.body;

            if (!productName || piece === undefined) {
                return res.status(400).json({ success: false, message: "Ürün adı ve miktar belirtilmelidir." });
            }

            const temizUrunAdi = productName.trim();
            const temizPiece = String(piece).toLowerCase().trim();
            const wholesale = ["all", "tümü", "hepsi", "ok", "tamam", "bitti", ""];
            const isWholeSale = wholesale.includes(temizPiece);

            // 1. ADIM: Tam Birebir Ürün Adı Eşleşmesi (Exact Match)
            let product = await productsCollection.findOne({
                productName: { $regex: new RegExp(`^${temizUrunAdi}$`, 'i') }
            });

            // 2. ADIM: Birebir İsim Bulunamadıysa Marka Veya Kısmi İsim Araması Yap
            if (!product) {
                const matchedProducts = await productsCollection.find({
                    $or: [
                        { productName: { $regex: new RegExp(temizUrunAdi, 'i') } },
                        { brand: { $regex: new RegExp(temizUrunAdi, 'i') } }
                    ],
                    'productInfo': { $exists: true, $not: { $size: 0 } }
                }).toArray();

                // Birden fazla ürün eşleştiyse doğrudan SILME, seçenekleri kullanıcıya sor
                if (matchedProducts.length > 1) {
                    const urunListesi = matchedProducts.map(p => p.productName);
                    return res.status(200).json({
                        success: true,
                        type: "MULTIPLE_MATCH",
                        searchKey: temizUrunAdi,
                        products: urunListesi,
                        message: `'${temizUrunAdi}' araması ile birden fazla ürün eşleşti.`
                    });
                }

                // Sadece 1 ürün eşleştiyse onu seç
                if (matchedProducts.length === 1) {
                    product = matchedProducts[0];
                } else {
                    return res.status(404).json({
                        success: false,
                        message: `'${temizUrunAdi}' adında aktif bir ürün veya marka bulunamadı.`
                    });
                }
            }

            // 3. ADIM: Kesinleşen Ürünü Sil / Düş
            if (isWholeSale) {
                await productsCollection.updateOne(
                    { _id: product._id },
                    { $set: { productInfo: [] } }
                );
                return res.status(200).json({
                    success: true,
                    type: "DELETED",
                    productName: product.productName,
                    message: `*${product.productName}* ürününün tüm bilgileri temizlendi.`
                });
            }

            res.status(200).json({
                success: true,
                type: "DELETED",
                productName: product.productName,
                message: `*${product.productName}* stoktan düşüldü.`
            });

        } catch (error) {
            console.error("API Hatası (Dus):", error);
            res.status(500).json({ success: false, message: "Veritabanı hatası." });
        }
    });

    app.get('/api/yardim', (req, res) => {
        try {
            const yardimKilavuzu = {
                title: "MarketBot Kullanım ve Yardım Kılavuzu",
                description: "Market stok ve Son Kullanma Tarihi (SKT) takibini kolayca yapabilmeniz için API rehberi aşağıdadır.",
                categories: [
                    {
                        id: 1,
                        name: "SKT Listeleme İşlemleri",
                        commands: [
                            {
                                endpoint: "GET /api/liste",
                                description: "Sistemdeki tüm aktif SKT kayıtlarını en yakın tarihten en uzağa doğru listeler.",
                                example: "/api/liste"
                            },
                            {
                                endpoint: "GET /api/liste?limit=10",
                                description: "Sadece belirtilen gün sayısı içinde skosu gelecek ürünleri filtreler.",
                                example: "/api/liste?limit=10"
                            }
                        ]
                    },
                    {
                        id: 2,
                        name: "Ürün Ekleme İşlemi",
                        commands: [
                            {
                                endpoint: "POST /api/ekle",
                                description: "Sisteme yeni bir ürün veya mevcut ürüne yeni bir SKT ekler.",
                                exampleBody: {
                                    productName: "Pınar Süt",
                                    dateData: "15.08.2026",
                                    brand: "Pınar",
                                    category: "Süt Ürünleri",
                                    userName: "Görkem"
                                }
                            }
                        ]
                    },
                    {
                        id: 3,
                        name: "Ürün Düşme / Temizleme İşlemi",
                        commands: [
                            {
                                endpoint: "POST /api/dus",
                                description: "Raftan satılan veya biten ürünlerin kayıtlarını düşer.",
                                exampleBody: {
                                    productName: "Pınar Süt",
                                    piece: "bitti"
                                }
                            }
                        ]
                    }
                ],
                hint: "Tüm işlemler arka plandaki merkezi API üzerinden güvenle gerçekleştirilir!"
            };

            // Hem JSON formatında (mobil uygulama için) hem de okunabilir metin formatında sunuyoruz
            res.status(200).json({
                success: true,
                data: yardimKilavuzu
            });

        } catch (error) {
            console.error("API Hatası (Yardim):", error);
            res.status(500).json({
                success: false,
                message: "Yardım kılavuzu yüklenirken hata oluştu."
            });
        }
    });

    app.get('/api/ara', async (req, res) => {
        try {
            // URL üzerinden arama kelimesini alıyoruz: /api/ara?q=pinar
            const query = req.query.q;

            if (!query || query.trim() === "") {
                return res.status(400).json({
                    success: false,
                    message: "⚠️ Lütfen aramak istediğiniz ürünü veya markayı belirtin. (Örn: /api/ara?q=pinar)"
                });
            }

            const prodCategory = query.trim();
            const todayMs = new Date().getTime();

            // Veritabanında hem ürün adında hem markada regex ile arama yapıyoruz
            const products = await productsCollection.find({
                $or: [
                    { productName: { $regex: new RegExp(prodCategory, 'i') } },
                    { brand: { $regex: new RegExp(prodCategory, 'i') } }
                ],
                'productInfo': {
                    $exists: true,
                    $not: { $size: 0 }
                }
            }).toArray();

            if (products.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: `Sistemde '${prodCategory}' kelimesini içeren ve SKT'si girilmiş bir ürün bulunamadı.`
                });
            }

            let allDate = [];
            for (const product of products) {
                for (const info of product.productInfo) {
                    if (!info || !info.timestamp) continue;

                    const difMs = info.timestamp - todayMs;
                    const difDays = Math.ceil(difMs / (1000 * 60 * 60 * 24));

                    allDate.push({
                        brand: product.brand || "",
                        productName: product.productName,
                        timestamp: info.timestamp,
                        viewDate: info.viewDate,
                        remainingDay: difDays
                    });
                }
            }

            // Tarihe göre en yakından en uzağa sırala
            allDate.sort((a, b) => a.timestamp - b.timestamp);

            res.status(200).json({
                success: true,
                query: prodCategory,
                count: allDate.length,
                data: allDate
            });

        } catch (error) {
            console.error("API Hatası (Ara):", error);
            res.status(500).json({
                success: false,
                message: "Arama yapılırken veritabanı hatası oluştu."
            });
        }
    });

    app.post('/api/barkod', async (req, res) => {
        try {
            // İstek gövdesinden barkod ve tarih bilgisini alıyoruz
            const { barcode, dateData, chatId } = req.body;


            if (!barcode || !dateData) {
                return res.status(400).json({
                    success: false,
                    message: "⚠️ Lütfen barkod numarası ve SKT tarihi girin."
                });
            }

            const temizBarkod = String(barcode).trim();
            const hedefChatId = chatId || process.env.TELEGRAM_CHAT_ID;

            // Open Food Facts küresel API'sine istek atıyoruz
            const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${temizBarkod}.json`);
            const data = await response.json();

            // API 'status: 1' döndürürse ürün global veritabanında var demektir
            if (data.status === 1) {
                const product = data.product;

                const urunAdi = product.product_name_tr || product.product_name || "İsimsiz Ürün";
                const marka = product.brands ? product.brands.split(',')[0].trim() : "";
                const kategori = product.categories ? product.categories.split(',')[0].trim() : "";

                const globalMesajMetni =
                    `🌐 **KÜRESEL VERİTABANINDA TANINDI!**\n\n` +
                    `Sisteminizde kayıtlı değil ancak Open Food Facts üzerinde bulundu:\n\n` +
                    `🏷️ **Ürün Adı:** ${urunAdi}\n` +
                    `🏢 **Marka:** ${marka}\n` +
                    `📂 **Kategori:** ${kategori}\n` +
                    `📅 **SKT:** ${dateData || 'Girilmedi'}\n` +
                    `🔢 **Barkod:** \`${temizBarkod}\`\n\n` +
                    `Bu ürünü lokal veritabanınıza eklemek ister misiniz?`;

                const ekleButonu = {
                    inline_keyboard: [
                        [
                            {
                                text: "➕ Veritabanıma Ekle",
                                callback_data: `add_prod_${temizBarkod}_${encodeURIComponent(dateData || 'yok')}`
                            }
                        ]
                    ]
                };


                res.status(200).json({
                    success: true,
                    foundInGlobal: true,
                    message: "✅ Ürün küresel veritabanında tanındı!",
                    productDetails: {
                        barcode: temizBarkod,
                        productName: urunAdi,
                        brand: marka,
                        category: kategori,
                        dateData: dateData
                    }
                });

                if (hedefChatId) {
                    sendNotification(globalMesajMetni);
                }

            } else {
                // Ürün global veritabanında yoksa
                const bulunamadiMesaj =
                    `❌ **ÜRÜN BULUNAMADI**\n\n` +
                    `\`${temizBarkod}\` barkodu ne sizin veritabanınızda ne de küresel veritabanında bulunamadı.`;

                if (hedefChatId) {
                    sendNotification(bulunamadiMesaj);
                }

                return res.status(404).json({
                    success: false,
                    foundInLocal: false,
                    foundInGlobal: false,
                    message: `❌ '${temizBarkod}' barkodu hiçbir veritabanında bulunamadı.`
                });
            }

        } catch (error) {
            console.error("API Hatası (Barkod):", error);
            res.status(500).json({
                success: false,
                message: "Barkod sorgulanırken sunucu kaynaklı bir hata oluştu."
            });
        }
    });

    app.post('/api/barkod-ara', async (req, res) => {
        try {
            const { barcode } = req.body;

            if (!barcode) {
                return res.status(400).json({
                    success: false,
                    message: 'Barkod numarası gerekli.'
                });
            }

            return barcode

        } catch (error) {
            console.log(error)
        }
    });

    app.get('/kamera', (req, res) => {

        res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Barkod Okuyucu</title>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <script src="https://unpkg.com/html5-qrcode" type="text/javascript"></script>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { 
                background-color: #17212b; 
                color: #ffffff; 
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                min-height: 100vh;
                padding: 16px;
            }
            .card {
                background: #242f3d;
                padding: 20px;
                border-radius: 16px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.3);
                width: 100%;
                max-width: 380px;
                text-align: center;
            }
            h3 { margin-bottom: 8px; font-size: 18px; color: #64b5ef; }
            p { font-size: 13px; color: #7f91a4; margin-bottom: 16px; }
            #reader { width: 100%; border-radius: 12px; overflow: hidden; margin-bottom: 16px; min-height: 200px; background: #17212b; }
            .btn {
                background: #2481cc;
                color: white;
                border: none;
                padding: 14px 18px;
                border-radius: 10px;
                font-size: 16px;
                font-weight: 600;
                width: 100%;
                cursor: pointer;
            }
            #debugConsole {
                background: #0e1621;
                color: #00ff66;
                font-family: monospace;
                font-size: 11px;
                padding: 10px;
                border-radius: 8px;
                text-align: left;
                width: 100%;
                max-width: 380px;
                margin-top: 16px;
                max-height: 100px;
                overflow-y: auto;
            }
        </style>
    </head>
    <body>
        <div class="card">
            <h3>📸 Barkod Okuyucu</h3>
            <p id="status">Kamera hazırlanıyor...</p>
            
            <div id="reader"></div>

            <button id="scanBtn" class="btn" onclick="checkPermissionAndScan()">📸 Taramayı Başlat</button>
        </div>

        <div id="debugConsole">🔍 LOGLAR:<br></div>

        <script>
            function log(msg) {
                const consoleDiv = document.getElementById('debugConsole');
                consoleDiv.innerHTML += "> " + msg + "<br>";
                consoleDiv.scrollTop = consoleDiv.scrollHeight;
            }

            let html5QrCode = null;
            let isScanning = false;
            const tg = window.Telegram?.WebApp;

            if (tg) {
                try {
                    tg.ready();
                    tg.expand();
                    log("Telegram WebApp Hazır.");
                } catch(e) {
                    log("SDK Hatası: " + e.message);
                }
            }

            // Kamera izin durumunu akıllı kontrol eden ana fonksiyon
            async function checkPermissionAndScan() {
                if (isScanning) return;

                // 1. Telegram Native Reader Kullanılabilirse
                if (tg && tg.openCodeReader) {
                    log("Telegram Native Reader başlatılıyor...");
                    try {
                        tg.openCodeReader({ text: "Barkodu Hizalayın" }, (result) => {
                            if (result) {
                                tg.closeCodeReader();
                                handleResult(result);
                            }
                        });
                        return;
                    } catch (e) {
                        log("Native Hata: " + e.message);
                    }
                }

                // 2. Tarayıcı İzin Sorgusu (Permissions API)
                if (navigator.permissions && navigator.permissions.query) {
                    try {
                        const permissionStatus = await navigator.permissions.query({ name: 'camera' });
                        log("Mevcut Kamera İzin Durumu: " + permissionStatus.state);

                        if (permissionStatus.state === 'granted') {
                            log("İzin zaten var, doğrudan kamera açılıyor...");
                            startCameraStream();
                        } else {
                            log("İzin eksik, izin isteme tetikleniyor...");
                            startCameraStream();
                        }
                    } catch (e) {
                        log("Permission API sorgulanamadı, doğrudan açılıyor...");
                        startCameraStream();
                    }
                } else {
                    startCameraStream();
                }
            }

            async function startCameraStream() {
                const btn = document.getElementById('scanBtn');
                btn.style.display = 'none';
                isScanning = true;

                try {
                    if (!html5QrCode) {
                        html5QrCode = new Html5Qrcode("reader");
                    }

                    const config = { fps: 10, qrbox: { width: 250, height: 150 } };

                    await html5QrCode.start(
                        { facingMode: "environment" },
                        config,
                        (decodedText) => {
                            log("Barkod Okundu: " + decodedText);
                            stopCameraAndHandle(decodedText);
                        },
                        (errorMessage) => {
                            // Arka planda kare tarama hataları
                        }
                    );
                    log("✅ Kamera aktif!");
                } catch (err) {
                    log("❌ Kamera Açma Hatası: " + err);
                    isScanning = false;
                    btn.style.display = 'block';
                }
            }

            async function stopCameraAndHandle(code) {
                if (html5QrCode && html5QrCode.isScanning) {
                    try {
                        await html5QrCode.stop();
                    } catch(e) {
                        log("Kamera durdurma uyarısı: " + e);
                    }
                }
                isScanning = false;
                handleResult(code);
            }

            function handleResult(code) {
                log("Onay İstenecek Kod: " + code);

                const confirmed = tg.showConfirm("Okunan Barkod:\\n\\n" + code + "\\n\\nBu veri doğru mu? Bota gönderilsin mi?",async (isConfirmed) => {
                log("Kullanıcı seçimi: " + isConfirmed);
                
                if (isConfirmed) {
                    
                    log("İşlem onaylandı. API'ye gönderiliyor...");
                     try{
                     sendDataToBackend(code);
                     }catch (err) {
                    log("❌ sendDataToBackend İç Hata: " + err.message);
                }
                } else {
                    log("İptal edildi.");
                    document.getElementById('scanBtn').style.display = 'block';
                }
            });}


function sendDataToBackend(code) {
                log("Backend'e HTTP POST atılıyor... Kod: " + code);

                try {
                    let chatId = null;
                    
                    if (tg && tg.initDataUnsafe) {
                        chatId = tg.initDataUnsafe.start_param || tg.initDataUnsafe.user?.id;
                    }

                    // URL parametrelerinden startapp / chatId yedek kontrolü
                    if (!chatId) {
                        const urlParams = new URLSearchParams(window.location.search);
                        chatId = urlParams.get('startapp') || urlParams.get('chatId');
                    }

                    log("Tespit Edilen ChatID: " + chatId);

                    const currentHost = window.location.origin;

                    fetch(currentHost + "/api/barkod", {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'ngrok-skip-browser-warning': 'true'
                        },
                        body: JSON.stringify({
                            barcode: code,
                            dateData: new Date().toISOString().split('T')[0],
                            chatId: chatId
                        })
                    })
                    .then(function(response) { return response.json(); })
                    .then(function(resData) {
                        log("✅ API Yanıtı: " + JSON.stringify(resData));
                        setTimeout(function() {
                            if (tg) tg.close();
                        }, 800);
                    })
                    .catch(function(err) {
                        log("❌ Fetch İsteği Başarısız: " + err.message);
                    });

                } catch (err) {
                    log("❌ sendDataToBackend İç Hata: " + err.message);
                }
            }


            // Sayfa yüklendiğinde daha önce verilmiş izin varsa otomatik aç, yoksa butona bırak
            window.onload = async () => {
                log("Sayfa yüklendi.");
                if (navigator.permissions && navigator.permissions.query) {
                    try {
                        const permissionStatus = await navigator.permissions.query({ name: 'camera' });
                        if (permissionStatus.state === 'granted') {
                            log("Kamera izni önceden onaylanmış, otomatik başlatılıyor...");
                            checkPermissionAndScan();
                        }
                    } catch(e) {}
                }
            };
            window.onerror = function(message, source, lineno, colno, error) {
    log("❌ JS HAKKIMDA HATA: " + message + " (Satır: " + lineno + ")");
};


        </script>
    </body>
    </html>
    `);
    });

    app.get('/urun-ekle-multi', (req, res) => {
        const { barkod, chatId } = req.query;

        res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Çoklu Ürün Ekleme</title>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { 
                background-color: #17212b; 
                color: #ffffff; 
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                padding: 16px;
                display: flex;
                flex-direction: column;
                align-items: center;
            }
            .header { text-align: center; margin-bottom: 16px; width: 100%; max-width: 480px; }
            .header h3 { color: #64b5ef; font-size: 20px; }
            .header p { color: #7f91a4; font-size: 13px; margin-top: 4px; }
            
            .product-card {
                background: #242f3d;
                padding: 16px;
                border-radius: 12px;
                width: 100%;
                max-width: 480px;
                margin-bottom: 12px;
                border: 1px solid #2b394a;
                position: relative;
            }
            .card-title {
                font-size: 14px;
                font-weight: 600;
                color: #64b5ef;
                margin-bottom: 10px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .remove-btn {
                background: #e53935;
                color: white;
                border: none;
                padding: 4px 8px;
                border-radius: 6px;
                font-size: 12px;
                cursor: pointer;
            }
            .form-row { display: flex; gap: 8px; margin-bottom: 8px; }
            .form-group { flex: 1; display: flex; flex-direction: column; }
            label { font-size: 11px; color: #7f91a4; margin-bottom: 4px; }
            input {
                padding: 10px;
                background: #17212b;
                border: 1px solid #2b394a;
                border-radius: 6px;
                color: white;
                font-size: 14px;
            }
            .action-buttons { width: 100%; max-width: 480px; display: flex; gap: 10px; margin-top: 8px; }
            .btn-add {
                background: #2b394a;
                color: #64b5ef;
                border: 1px dashed #64b5ef;
                padding: 12px;
                border-radius: 10px;
                font-weight: 600;
                flex: 1;
                cursor: pointer;
            }
            .btn-submit {
                background: #2481cc;
                color: white;
                border: none;
                padding: 14px;
                border-radius: 10px;
                font-size: 16px;
                font-weight: 600;
                width: 100%;
                max-width: 480px;
                margin-top: 16px;
                cursor: pointer;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h3>📦 Toplu Ürün Kaydı</h3>
            <p>Forma istediğiniz kadar ürün ekleyip tek seferde kaydedebilirsiniz.</p>
        </div>

        <form id="multiProductForm" style="width: 100%; display: flex; flex-direction: column; align-items: center;">
            <div id="productList" style="width: 100%; display: flex; flex-direction: column; align-items: center;">
                <!-- İlk ürün kartı varsayılan gelir -->
            </div>

            <div class="action-buttons">
                <button type="button" class="btn-add" onclick="addProductCard()">➕ Başka Ürün Ekle</button>
            </div>

            <button type="submit" class="btn-submit">💾 Tüm Ürünleri Kaydet (${'${'}chatId ? 've Bota Bildir' : ''})</button>
        </form>

        <script>
            const tg = window.Telegram?.WebApp;
            if (tg) { tg.ready(); tg.expand(); }

            let productCount = 0;
            const initialBarcode = "${barkod || ''}";

            function addProductCard(barcodeValue = '') {
                productCount++;
                const list = document.getElementById('productList');
                const card = document.createElement('div');
                card.className = 'product-card';
                card.id = \`product-card-\${productCount}\`;

                card.innerHTML = \`
                    <div class="card-title">
                        <span>Ürün #\${productCount}</span>
                        \${productCount > 1 ? \`<button type="button" class="remove-btn" onclick="removeCard(\${productCount})">🗑️ Sil</button>\` : ''}
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>Barkod *</label>
                            <input type="text" name="barcode" value="\${barcodeValue}" placeholder="8690..." required>
                        </div>
                        <div class="form-group">
                            <label>Ürün Adı *</label>
                            <input type="text" name="productName" placeholder="Örn: Süt 1L" required>
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>Marka</label>
                            <input type="text" name="brand" placeholder="Örn: Sütaş">
                        </div>
                        <div class="form-group">
                            <label>Kategori</label>
                            <input type="text" name="category" placeholder="Örn: Süt Ürünleri">
                        </div>
                        <div class="form-group">
                            <label>SKT</label>
                            <input type="date" name="dateData">
                        </div>
                    </div>
                \`;
                list.appendChild(card);
            }

            function removeCard(id) {
                const card = document.getElementById(\`product-card-\${id}\`);
                if (card) card.remove();
            }

            // Sayfa yüklendiğinde ilk kartı oluştur
            window.onload = () => {
                addProductCard(initialBarcode);
            };

            // Toplu Gönderim İşlemi
            document.getElementById('multiProductForm').addEventListener('submit', async (e) => {
                e.preventDefault();

                const cards = document.querySelectorAll('.product-card');
                const products = [];

                cards.forEach(card => {
                    const barcode = card.querySelector('[name="barcode"]').value.trim();
                    const productName = card.querySelector('[name="productName"]').value.trim();
                    const brand = card.querySelector('[name="brand"]').value.trim();
                    const category = card.querySelector('[name="category"]').value.trim();
                    const dateData = card.querySelector('[name="dateData"]').value;

                    if (barcode && productName) {
                        products.push({ barcode, productName, brand, category, dateData });
                    }
                });

                if (products.length === 0) {
                    alert("Lütfen en az bir geçerli ürün girin.");
                    return;
                }

                try {
                    const response = await fetch('/api/urun-kaydet-multi', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            products: products,
                            chatId: "${chatId || ''}"
                        })
                    });

                    const resData = await response.json();

                    if (resData.success) {
                        alert(\`✅ \${products.length} adet ürün başarıyla kaydedildi!\`);
                        if (tg) tg.close();
                    } else {
                        alert("❌ Hata: " + resData.message);
                    }
                } catch (err) {
                    alert("Ağ hatası: " + err.message);
                }
            });
        </script>
    </body>
    </html>
    `);
    });


    app.listen(3000, () => {
        console.log("🌐 Basit Modüler API Çalışıyor! -> http://localhost:3000/api/liste");
    });


}

module.exports = apiStarter;
