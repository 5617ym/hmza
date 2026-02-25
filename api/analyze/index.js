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
      const window = rawText.slice(
        Math.max(0, approx - 250),
        Math.min(rawText.length, approx + 500)
      );
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
  const lines = (text || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

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

/* =========================
   Step 2: Section Extraction (simple, text-based)
   - Find real section start (skip TOC)
   - Slice from this section to the next
========================= */

function normalizeChar(ch) {
  // إزالة التشكيل
  if (/[\u064B-\u065F\u0670]/.test(ch)) return "";

  // توحيد الهمزات
  if (/[إأآٱ]/.test(ch)) return "ا";

  // توحيد حروف شائعة
  if (ch === "ى") return "ي";
  if (ch === "ة") return "ه";
  if (ch === "ؤ") return "و";
  if (ch === "ئ") return "ي";
  if (ch === "ـ") return "";

  // توحيد الفواصل العربية
  if (ch === "٬" || ch === "،") return ",";

  // أبقِ العربي/الإنجليزي/الأرقام/المسافات وبعض الرموز
  if (/[\u0600-\u06FFa-zA-Z0-9\s&/().-]/.test(ch)) return ch.toLowerCase();

  // أي شيء آخر نحوله لمسافة
  return " ";
}

function normalizeWithMap(raw = "") {
  let norm = "";
  const map = []; // map[normIndex] = rawIndex
  for (let i = 0; i < raw.length; i++) {
    const out = normalizeChar(raw[i]);
    if (!out) continue;
    for (let k = 0; k < out.length; k++) {
      norm += out[k];
      map.push(i);
    }
  }
  // ملاحظة: لن نضغط المسافات هنا لتجنب تعقيد الـ map
  return { norm, map };
}

function findBestSectionStart(rawText, sectionKey) {
  const titles = LEXICON.sections[sectionKey] || [];
  const { norm, map } = normalizeWithMap(rawText);

  let best = null;

  for (const title of titles) {
    const tNorm = normalizeText(title);
    let from = 0;

    while (true) {
      const idx = norm.indexOf(tNorm, from);
      if (idx === -1) break;

      const rawIdx = map[idx] ?? 0;

      // سياق حول التطابق لاستبعاد "الفهرس"
      const ctx = rawText
        .slice(Math.max(0, rawIdx - 200), Math.min(rawText.length, rawIdx + 300))
        .replace(/\s+/g, " ");

      const looksLikeTOC =
        /الفهرس/.test(ctx) ||
        (/صفحة/.test(ctx) && /تقرير مراجع الحسابات/.test(ctx));

      // لو تطابق داخل الفهرس، نتجاوزه
      if (looksLikeTOC) {
        from = idx + tNorm.length;
        continue;
      }

      // اختر أول تطابق معقول، وفضّل التطابق الأبعد (غالبًا الحقيقي داخل القوائم)
      best = best || { rawIdx, match: title };
      if (rawIdx > best.rawIdx) best = { rawIdx, match: title };

      from = idx + tNorm.length;
    }
  }

  return best; // { rawIdx, match } أو null
}

function buildSectionsText(rawText) {
  const sectionKeys = [
    "balanceSheet",
    "incomeStatement",
    "comprehensiveIncome",
    "cashFlow",
    "equityChanges",
  ];

  const starts = [];

  for (const key of sectionKeys) {
    const found = findBestSectionStart(rawText, key);
    if (found) starts.push({ key, ...found });
  }

  // ترتيب حسب الظهور في الملف
  starts.sort((a, b) => a.rawIdx - b.rawIdx);

  const sectionsText = {};
  const sectionsInfo = {};

  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i];
    const next = starts[i + 1];

    const start = cur.rawIdx;
    const end = next ? next.rawIdx : rawText.length;

    const chunk = rawText
      .slice(start, end)
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    sectionsText[cur.key] = chunk;
    sectionsInfo[cur.key] = {
      titleMatched: cur.match,
      start,
      end,
      length: chunk.length,
    };
  }

  return { sectionsText, sectionsInfo };
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

    // ✅ استخراج نص كل قسم (كتلة نصية بين العناوين)
    const { sectionsText, sectionsInfo } = buildSectionsText(text);

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
        sectionsInfo,
        sectionsText,
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
