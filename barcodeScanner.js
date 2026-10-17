const { 
    MultiFormatReader, 
    RGBLuminanceSource, 
    BinaryBitmap, 
    HybridBinarizer, 
    DecodeHintType, 
    BarcodeFormat 
} = require('@zxing/library');
const {Jimp} = require('jimp');



async function readBarcodeFromBuffer(imageBuffer) {
    try {
        // 1. Resmi Jimp ile yükle
        let image = await Jimp.read(imageBuffer);
        
        // İşleme hızını ve başarımını artırmak için büyük görselleri boyutlandır
        if (image.bitmap.width > 1200) {
            image.resize(1200, Jimp.AUTO);
        }

        // 🟢 1. Deneme: Orijinal resim üzerinde ara
        let barcode = decodeImage(image);
        if (barcode) return barcode;

        // 🟢 2. Deneme: Görsel işleme (Kontrast & Gri Tonlama)
        try {
            if (typeof image.greyscale === 'function') {
                image.greyscale();
            } else if (typeof image.grayscale === 'function') {
                image.grayscale();
            }
            
            if (typeof image.contrast === 'function') {
                image.contrast(0.4);
            }

            barcode = decodeImage(image);
            if (barcode) return barcode;
        } catch (manipulationError) {
            // Görsel işleme başarısız olursa orijinal hali yetsin
        }

        return null;
    } catch (error) {
        console.error("❌ Görsel Okuma Hatası:", error.message);
        return null;
    }
}

function decodeImage(jimpImage) {
    try {
        const { width, height, data } = jimpImage.bitmap;
        const len = width * height;
        const luminances = new Uint8ClampedArray(len);

        for (let i = 0; i < len; i++) {
            luminances[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
        }

        const luminanceSource = new RGBLuminanceSource(luminances, width, height);
        const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));

        const reader = new MultiFormatReader();
        const hints = new Map();
        
        // Market ürünleri için öncelikli barkod formatları
        const possibleFormats = [
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
            BarcodeFormat.QR_CODE
        ];

        hints.set(DecodeHintType.POSSIBLE_FORMATS, possibleFormats);
        hints.set(DecodeHintType.TRY_HARDER, true);

        const result = reader.decode(binaryBitmap, hints);
        return result ? result.getText() : null;

    } catch (e) {
        // ZXing'in iç tarama hatalarını (NotFound, Checksum, Format) tamamen sessizce yut
        return null;
    }
}

module.exports = {readBarcodeFromBuffer};