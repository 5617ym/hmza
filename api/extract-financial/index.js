// api/extract-financial/index.js
let parseArabicNumberLib = null;
try {
  // api/extract-financial -> api/_lib
  parseArabicNumberLib = require("../_lib/parse-arabic-number");
} catch (e) {
  // ignore - سنستخدم fallback
}

module.exports = async function (context, req) {
  const send = (status, payload) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: payload,
    };
  };

  // ===== Fallback: تحويل أرقام عربية/هندية إلى لاتينية + تنظيف الفواصل =====
  function toLatinDigits(input) {
    const s = String(input ?? "");
    const map = {
      "٠": "0",
      "١": "1",
      "٢": "2",
      "٣": "3",
      "٤": "4",
      "٥": "5",
      "٦": "6",
      "٧": "7",
      "٨": "8",
      "٩": "9",
      "۰": "0",
      "۱": "1",
      "۲": "2",
      "۳": "3",
      "۴": "4",
      "۵": "5",
      "۶": "6",
      "۷": "7",
      "۸": "8",
      "۹": "9",
    };
    return s.replace(/[٠-٩۰-۹]/g, (ch) => map[ch] ?? ch);
  }

  function normalizeNumberString(raw) {
    let s = String(raw ?? "").trim();
    if (!s) return "";

    // أحياناً السالب يكون بين أقواس (123) => -123
    let negative = false;
    if (s.startsWith("(") && s.endsWith(")")) {
      negative = true;
      s = s.slice(1, -1).trim();
    }

    // تحويل الأرقام العربية إلى لاتينية
    s = toLatinDigits(s);

    // إزالة مسافات
    s = s.replace(/\s+/g, "");

    // الفاصل العشري العربي "٫" => "."
    s = s.replace(/٫/g, ".");

    // فواصل الآلاف العربية "٬" والعادية "," => احذف
    s = s.replace(/[٬,]/g, "");

    // بعض الملفات تستخدم "−" بدل "-"
    s = s.replace(/−/g, "-");

    if (negative && s && !s.startsWith("-")) s = "-" + s;
    return s;
  }

  function parseArabicNumber(raw) {
    // 1) لو مكتبتك موجودة وفيها parseArabicNumber استخدمها
    const fn =
      parseArabicNumberLib?.parseArabicNumber ||
      parseArabicNumberLib?.default ||
      null;

    if (typeof fn === "function") {
      try {
        const v = fn(raw);
        if (typeof v === "number" && Number.isFinite(v)) return v;
      } catch (_) {}
    }

    // 2) fallback
    const s = normalizeNumberString(raw);
    if (!s) return null;

    // لازم يكون شكل رقم (مع احتمال علامة -)
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;

    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeTablesPreview(tablesPreview) {
    const out = [];
    for (const t of tablesPreview) {
      const sample = Array.isArray(t.sample) ? t.sample : [];

      // sampleNormalized: نفس النص لكن مُنظَّف (digits/sep)
      const sampleNormalized = sample.map((row) =>
        (Array.isArray(row) ? row : []).map((cell) => {
          const s = String(cell ?? "");
          return normalizeNumberString(s) || s;
        })
      );

      // sampleNumbers: نحاول نطلع Number لكل خلية (null إذا فشل)
      const sampleNumbers = sample.map((row) =>
        (Array.isArray(row) ? row : []).map((cell) => parseArabicNumber(cell))
      );

      out.push({
        index: t.index ?? null,
        rowCount: t.rowCount ?? null,
        columnCount: t.columnCount ?? null,
        sample, // الأصلي
        sampleNormalized,
        sampleNumbers,
      });
    }
    return out;
  }

  try {
    const body = req.body || {};
    const normalized = body.normalized;

    if (!normalized || typeof normalized !== "object") {
      return send(400, { ok: false, error: "Missing 'normalized' in request body" });
    }

    // ✅ pages عادة موجودة، لكن غالباً بدون text (حسب normalize-di)
    const pages = Array.isArray(normalized.pages) ? normalized.pages : [];

    // ✅ المهم عندك الآن هو tablesPreview
    const tablesPreview = Array.isArray(normalized.tablesPreview) ? normalized.tablesPreview : [];

    // كلمات مفتاحية لاكتشاف صفحات القوائم (قد يظل فارغ إذا pages بدون text)
    const KW = {
      bs: [
        "قائمة المركز المالي",
        "قائمة الوضع المالي",
        "الميزانية",
        "الميزانية العمومية",
        "Statement of Financial Position",
        "Balance Sheet",
      ],
      is: [
        "قائمة الدخل",
        "قائمة الربح والخسارة",
        "قائمة الأرباح والخسائر",
        "Income Statement",
        "Profit & Loss",
        "P&L",
      ],
      cf: [
        "قائمة التدفقات النقدية",
        "بيان التدفقات النقدية",
        "Cash Flow Statement",
        "Statement of Cash Flows",
      ],
      eq: [
        "قائمة التغيرات في حقوق الملكية",
        "Statement of Changes in Equity",
        "Statement of Shareholders' Equity",
      ],
    };

    const norm = (s) => String(s || "").toLowerCase();
    const hasAny = (text, arr) => arr.some((k) => norm(text).includes(norm(k)));

    const detected = { balanceSheet: [], incomeStatement: [], cashFlow: [], equity: [] };

    for (const p of pages) {
      const pageNumber = p.pageNumber ?? p.page ?? null;
      const text = p.text || ""; // غالباً غير موجود حالياً
      if (!pageNumber) continue;

      if (hasAny(text, KW.bs)) detected.balanceSheet.push(pageNumber);
      if (hasAny(text, KW.is)) detected.incomeStatement.push(pageNumber);
      if (hasAny(text, KW.cf)) detected.cashFlow.push(pageNumber);
      if (hasAny(text, KW.eq)) detected.equity.push(pageNumber);
    }

    const uniqSort = (arr) => Array.from(new Set(arr)).sort((a, b) => a - b);
    detected.balanceSheet = uniqSort(detected.balanceSheet);
    detected.incomeStatement = uniqSort(detected.incomeStatement);
    detected.cashFlow = uniqSort(detected.cashFlow);
    detected.equity = uniqSort(detected.equity);

    // ✅ الجديد: تطبيع tablesPreview
    const tablesPreviewNormalized = normalizeTablesPreview(tablesPreview);

    return send(200, {
      ok: true,
      financial: {
        pagesDetected: detected,
        // tablesPreview كما جاء من normalize
        tablesPreviewCount: tablesPreview.length,
        tablesPreview: tablesPreview,

        // ✅ التطبيع المطلوب
        tablesPreviewNormalizedCount: tablesPreviewNormalized.length,
        tablesPreviewNormalized: tablesPreviewNormalized,
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message || String(e) });
  }
};
