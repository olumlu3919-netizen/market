// parser.js

const CATEGORIES = {
    milk: 4,
    snack: 7,
    delicatessen: 3,
    drinks: 14,
    legumes: 30,
    cleaning: 60,
    std: 7
};

const TURKISH_CATEGORIES = {
    'süt': 'milk', 'sut': 'milk', 'laktozsuz sut': 'milk', 'laktozsuz süt': 'milk',
    'yoğurt': 'milk', 'yogurt': 'milk', 'ayran': 'milk', 'kefir': 'milk',
    'şarküteri': 'delicatessen', 'sarkuteri': 'delicatessen', 'peynir': 'delicatessen',
    'pey': 'delicatessen', 'peyniri': 'delicatessen', 'kaşar': 'delicatessen',
    'kasar': 'delicatessen', 'zeytin': 'delicatessen', 'sucuk': 'delicatessen',
    'kangal': 'delicatessen', 'sosis': 'delicatessen', 'salam': 'delicatessen',
    'tereyağı': 'delicatessen', 'tereyagi': 'delicatessen', 'tereyag': 'delicatessen',
    'tereyağ': 'delicatessen', 'kahvaltılık': 'delicatessen', 'kahvaltilik': 'delicatessen',
    'atıştırmalık': 'snack', 'atistirmalik': 'snack', 'aburcubur': 'snack',
    'bisküvi': 'snack', 'çikolata': 'snack', 'cikolata': 'snack', 'kruvasan': 'snack',
    'çik': 'snack', 'cips': 'snack', 'kraker': 'snack', 'içecek': 'drinks',
    'icecek': 'drinks', 'su': 'drinks', 'kola': 'drinks', 'madensuyu': 'drinks',
    'meyvesuyu': 'drinks', 'bakliyat': 'legumes', 'kuru': 'legumes',
    'kurutulmuş': 'legumes', 'kurutulmus': 'legumes', 'makarna': 'legumes',
    'un': 'legumes', 'şeker': 'legumes', 'seker': 'legumes', 'yağ': 'legumes',
    'yag': 'legumes', 'temizlik': 'cleaning', 'camasir': 'cleaning',
    'çamaşır': 'cleaning', 'kozmetik': 'cleaning', 'deterjan': 'cleaning',
    'sabun': 'cleaning', 'şampuan': 'cleaning', 'sampuan': 'cleaning',
    'standart': 'std', 'std': 'std', 'normal': 'std'
};

function ExpirationDateCalculater(dateData) {
    if (!dateData) return null;
    let expirationDate = new Date();

    if (dateData.type === 'relative') { 
        if (dateData.unit === 'g') expirationDate.setDate(expirationDate.getDate() + dateData.num);
        else if (dateData.unit === 'h') expirationDate.setDate(expirationDate.getDate() + (dateData.num * 7));
        else if (dateData.unit === 'a') expirationDate.setMonth(expirationDate.getMonth() + dateData.num);
        else if (dateData.unit === 'y') expirationDate.setFullYear(expirationDate.getFullYear() + dateData.num);
    } else if (dateData.type === 'exact') {
        expirationDate = new Date(dateData.year, dateData.month - 1, dateData.day);
    }
    
    return {
        dbTimestamp: expirationDate.getTime(),
        dbDate: `${expirationDate.getFullYear()}-${String(expirationDate.getMonth() + 1).padStart(2, '0')}-${String(expirationDate.getDate()).padStart(2, '0')}`,
        viewDate: `${String(expirationDate.getDate()).padStart(2, '0')}/${String(expirationDate.getMonth() + 1).padStart(2, '0')}/${expirationDate.getFullYear()}`
    };
}

function regWork(p) {
    if (!p || !p.startsWith('!')) return null;
    p = p.toLowerCase();
    const words = p.trim().split(/\s+/);

    const command = words[0].toLowerCase();
    const args = words.slice(1);

    const stdDateData = { type: null, num: null, unit: null, day: null, month: null, year: null };

    let productName = null;
    let dateData = null;
    let category = "std";
    let reminderDay = CATEGORIES["std"];
    let brand = null;
    
    if (args.length > 0) {
        let isDateMatched = false;
        const lastArg = args[args.length - 1];
        const regDateRel = /^(\d+)([ghay])$/i;

        if (regDateRel.test(lastArg)) {
            const matches = lastArg.match(regDateRel);
            stdDateData.type = 'relative';
            stdDateData.num = parseInt(matches[1]);
            stdDateData.unit = matches[2].toLowerCase();
            isDateMatched = true;
        } else {
            const parts = lastArg.split(/[\.\-\/]/);
            const day = new Date();

            if (parts.length >= 2 && parts.length <= 3) {
                stdDateData.type = 'exact';

                if (parts.length === 3) {
                    stdDateData.day = parseInt(parts[0]);
                    stdDateData.month = parseInt(parts[1]);
                    stdDateData.year = parseInt(parts[2]);
                    isDateMatched = true;
                } else if (parts.length === 2) {
                    const partSecond = parseInt(parts[1]);
                    if (partSecond > 12 || parts[1].length === 4) {
                        stdDateData.day = 1;
                        stdDateData.month = parseInt(parts[0]);
                        stdDateData.year = parseInt(parts[1]);
                        isDateMatched = true;
                    } else {
                        stdDateData.day = parseInt(parts[0]);
                        stdDateData.month = parseInt(parts[1]);
                        stdDateData.year = day.getFullYear();
                        isDateMatched = true;
                    }
                }

                if (stdDateData.year < 100 && stdDateData.year !== null) {
                    stdDateData.year = stdDateData.year + 2000;
                }
            }
        }

        const today = new Date();
        if (isDateMatched) {
            if (
                stdDateData.type === 'exact' &&
                (stdDateData.year < today.getFullYear() ||
                (stdDateData.year === today.getFullYear() && stdDateData.month < (today.getMonth() + 1)) ||
                (stdDateData.year === today.getFullYear() && stdDateData.month === (today.getMonth() + 1) && stdDateData.day < today.getDate()))
            ) {
                return { error: "⚠️ Tarih yazımı hatası. Lütfen ileri bir tarih girin..." };
            }
            productName = args.slice(0, -1).join(' ');
            dateData = stdDateData;
        } else {
            productName = args.join(' ');
        }
    }

    if (productName) {
        const productWords = productName.split(/\s+/);
        brand = productWords[0];

        for (let a of productWords.slice(1)) {
            if (TURKISH_CATEGORIES[a]) {
                category = TURKISH_CATEGORIES[a];
                reminderDay = CATEGORIES[category];
                break;
            }
        }
    }

    const expirationInfo = ExpirationDateCalculater(dateData);

    return {
        command,
        args,
        productName,
        category,
        reminderDay,
        brand,
        expirationInfo
    };
}

module.exports = { regWork, ExpirationDateCalculater };