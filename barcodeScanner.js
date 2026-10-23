// barcodeScanner.js
// Fotoğraftan barkod okur. Her denemede farklı bir görüntü işleme ve iki farklı binarizer kullanır.
const {
    MultiFormatReader,
    RGBLuminanceSource,
    BinaryBitmap,
    HybridBinarizer,
    GlobalHistogramBinarizer,
    DecodeHintType,
    BarcodeFormat,
} = require('@zxing/library');
const { Jimp } = require('jimp');

const reader = new MultiFormatReader();
const hints = new Map();
hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
    BarcodeFormat.QR_CODE,
]);
hints.set(DecodeHintType.TRY_HARDER, true);
reader.setHints(hints);

// EAN-8 / UPC-A / EAN-13 / EAN-14 kontrol hanesi
function checksumOk(code) {
    const digits = code.split('').map(Number);
    const check = digits.pop();
    let sum = 0;
    for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
    return (10 - (sum % 10)) % 10 === check;
}

// Elle yazılan veya okunan sayısal barkodlar için
function isValidBarcode(code) {
    const s = String(code).trim();
    return /^\d+$/.test(s) && [8, 12, 13, 14].includes(s.length) && checksumOk(s);
}

function decodeWith(image, Binarizer) {
    const { width, height, data } = image.bitmap;
    const luminances = new Uint8ClampedArray(width * height);
    for (let i = 0; i < luminances.length; i++) {
        luminances[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
    }
    try {
        const bitmap = new BinaryBitmap(new Binarizer(new RGBLuminanceSource(luminances, width, height)));
        const text = reader.decode(bitmap).getText();
        // Yanlış okumayı ele: sayısal EAN/UPC ise kontrol hanesi tutmalı
        if (/^\d{8,14}$/.test(text) && !checksumOk(text)) return null;
        return text;
    } catch (e) {
        return null; // NotFound / Checksum / Format hatalarını yut
    }
}

function tryDecode(image) {
    return decodeWith(image, HybridBinarizer) || decodeWith(image, GlobalHistogramBinarizer);
}

// Her strateji orijinalin kopyası üzerinde çalışır
const strategies = [
    (img) => img,
    (img) => img.greyscale().contrast(0.5),
    (img) => {
        const { width, height } = img.bitmap;
        return img
            .crop({ x: Math.round(width * 0.1), y: Math.round(height * 0.25), w: Math.round(width * 0.8), h: Math.round(height * 0.5) })
            .resize({ w: 1400 })
            .greyscale()
            .contrast(0.3);
    },
    (img) => img.rotate(90).greyscale().contrast(0.4),
    (img) => img.rotate(270).greyscale().contrast(0.4),
];

async function readBarcodeFromBuffer(imageBuffer) {
    try {
        const base = await Jimp.read(imageBuffer);
        if (base.bitmap.width > 1600) base.resize({ w: 1600 });

        for (const strategy of strategies) {
            try {
                const code = tryDecode(strategy(base.clone()));
                if (code) return code;
            } catch (e) {
                // bu strateji başarısız, sonrakine geç
            }
        }
        return null;
    } catch (error) {
        console.error('❌ Görsel okuma hatası:', error.message);
        return null;
    }
}

module.exports = { readBarcodeFromBuffer, isValidBarcode };