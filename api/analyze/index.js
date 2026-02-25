const pdfParse = require("pdf-parse");

/* =========================
   Step 1: Lexicon + Normalization + Section Detection
   (No advanced extraction yet)
========================= */

function normalizeText(s = "") {
  return String(s)
    .toLowerCase()
    // إزالة التشكيل
    .replace(/[\u064B-\u065F\u0670]/g, "")
    // توحيد الهمزات
    .replace(/[إأآٱ]/g, "ا")
    // توحيد حروف شائعة
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ـ/g, "")
    // توحيد الفواصل
    .replace(/[٬،]/g, ",")
    // تنظيف الرموز
    .replace(/[^\u0600-\u06FFa-z0-9\s&/().-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LEXICON = {
  sections: {
    balanceSheet: [
      "قائمة المركز المالي",
      "المركز المالي",
      "الميزانية",
      "الميزانية العمومية",
      "قائمة الوضع المالي",
      "statement of financial position",
      "financial position",
    ],
    incomeStatement: [
      "قائمة الدخل",
      "قائمة الربح والخسارة",
      "قائمة الأرباح والخسائر",
      "قائمة النتائج",
      "بيان الأرباح",
      "income statement",
      "profit & loss statement",
      "profit and loss statement",
      "p&l",
      "p l",
      "قائمة الربح او الخسارة", // بدون همزة/تشكيل
      "قائمة الربح أو الخسارة",
    ],
    comprehensiveIncome: [
      "قائمة الدخل الشامل",
      "الدخل الشامل",
      "الدخل الشامل الاخر",
      "الدخل الشامل الآخر",
      "قائمة الربح أو الخسارة والدخل الشامل",
      "قائمة الربح او الخسارة والدخل الشامل",
      "comprehensive income",
      "other comprehensive income",
    ],
    cashFlow: [
      "قائمة التدفقات النقدية",
      "بيان التدفقات النقدية",
      "قائمة حركة النقد",
      "cash flow statement",
      "statement of cash flows",
    ],
    equityChanges: [
      "قائمة التغيرات في حقوق الملكية",
      "بيان التغير في حقوق المساهمين",
      "statement of changes in equity",
      "statement of shareholders equity",
      "statement of shareholders' equity",
    ],
  },
};

// يبحث عن أول ظهور لأي عنوان من عناوين القسم، ويرجع 3 أسطر حوله كتأكيد
function findSectionTitles(rawText, sectionKey) {
  const titles = LEXICON.sections[sectionKey] || [];
  const norm = normalizeText(rawText);

  const found = [];
  for (const title of titles) {
    const tNorm = normalizeText(title);
    const idx = norm.indexOf(tNorm);
    if (idx !== -1) {
      // لإرجاع سياق مفيد: نبحث في النص الخام حول هذا العنوان (تقريباً)
      // (نستخدم rawText بدل norm عشان المستخدم يشوف النص كما هو)
      const approx = Math.max(0, Math.min(rawText.length - 1, idx));
      const window = rawText.slice(Math.max(0, approx - 250), Math.min(rawText.length, approx + 500));
      found.push({
        match: title,
        contextPreview: window.replace(/\s+/g, " ").trim().slice(0, 260),
      });
    }
  }

  // إزالة التكرار (قد تظهر صيغة قريبة)
  const uniq = [];
  const seen = new Set();
  for (const f of found) {
    const k = normalizeText(f.match);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(f);
  }

  return uniq;
}

function detectSections(rawText) {
  const result = {
    balanceSheet: false,
    incomeStatement: false,
    comprehensiveIncome: false,
    cashFlow: false,
    equityChanges: false,
  };

  for (const key of Object.keys(result)) {
    const hits = findSectionTitles(rawText, key);
    if (hits.length) result[key] = true;
  }
  return result;
}

function buildMeta(text) {
  const lines = (text || "").split("\n").map((x) => x.trim()).filter(Boolean);

  // الشركة: أول سطر يحتوي "شركة" غالباً
  const companyLine = lines.find((l) => l.includes("شركة")) || null;

  const currency = /SAR|ر\.س|ريال|﷼/i.test(text) ? "SAR" : null;

  const periodMatch =
    text.match(/للسنة\s+المنتهية\s+في[\s\S]{0,60}\d{4}/) ||
    text.match(/للفترة\s+المنتهية\s+في[\s\S]{0,60}\d{4}/);

  return {
    company: companyLine,
    currency,
    periodHint: periodMatch ? periodMatch[0].replace(/\s+/g, " ").trim() : null,
  };
}

module.exports = async function (context, req) {
  try {
    // GET للتأكد فقط
    if ((req.method || "").toUpperCase() === "GET") {
      context.res = {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: { message: "API شغال بنجاح 🚀", timestamp: new Date().toISOString() },
      };
      return;
    }

    const body = req.body || {};
    const fileName = body.fileName || "uploaded.pdf";
    const fileBase64 = body.fileBase64;

    if (!fileBase64 || typeof fileBase64 !== "string") {
      context.res = {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: { ok: false, error: "لم يتم إرسال fileBase64" },
      };
      return;
    }

    // لو جاء data url نفصله
    const cleaned = fileBase64.includes("base64,")
      ? fileBase64.split("base64,")[1]
      : fileBase64;

    const buffer = Buffer.from(cleaned, "base64");

    const parsed = await pdfParse(buffer);
    const rawText = (parsed.text || "").replace(/\r/g, "\n");
    const text = rawText.replace(/\n{3,}/g, "\n\n").trim();

    const meta = buildMeta(text);

    const detectedSections = detectSections(text);

    const sectionTitlesFound = {
      balanceSheet: findSectionTitles(text, "balanceSheet"),
      incomeStatement: findSectionTitles(text, "incomeStatement"),
      comprehensiveIncome: findSectionTitles(text, "comprehensiveIncome"),
      cashFlow: findSectionTitles(text, "cashFlow"),
      equityChanges: findSectionTitles(text, "equityChanges"),
    };

    context.res = {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        ok: true,
        fileName,
        pages: parsed.numpages,
        textLength: text.length,
        meta,
        detectedSections,
        sectionTitlesFound,
        preview: text.slice(0, 900),
      },
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: { ok: false, error: err?.message || "خطأ غير معروف" },
    };
  }
};
