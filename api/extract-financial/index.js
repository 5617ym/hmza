// api/extract-financial/index.js

let parseArabicNumber = null;
try {
  // إذا ملف المساعد موجود: api/_lib/parse-arabic-number.js
  // وداخله: module.exports = function parseArabicNumber(...) { ... }
  parseArabicNumber = require("../_lib/parse-arabic-number");
} catch (e) {
  parseArabicNumber = null;
}

module.exports = async function (context, req) {
  const send = (status, payload) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: payload,
    };
  };

  try {
    const body = req.body || {};

    // يقبل:
    // 1) { normalized: {...} }
    // 2) أو Analyze Response كامل { ok:true, normalized:{...} }
    const normalized = body.normalized || body?.analyze?.normalized || body?.data?.normalized;

    if (!normalized || typeof normalized !== "object") {
      return send(400, { ok: false, error: "Missing 'normalized' in request body" });
    }

    // الجداول المتاحة غالباً:
    // - normalized.tablesPreview (حسب اللي أرسلته)
    // - أو normalized.tablesPreviewNormalized (لو عندك نسخة مطبّعة)
    // - أو normalized.tables (لو لاحقاً صار عندك استخراج كامل)
    const tablesPreview =
      (Array.isArray(normalized.tablesPreview) && normalized.tablesPreview) ||
      (Array.isArray(normalized.tablesPreviewNormalized) && normalized.tablesPreviewNormalized) ||
      (Array.isArray(normalized.tables) && normalized.tables) ||
      [];

    // صفحات حاليا meta فقط، ما نقدر نستخدمها لاكتشاف العناوين
    const pagesMeta = Array.isArray(normalized.pages) ? normalized.pages : [];

    const norm = (s) => String(s || "").toLowerCase();

    const TABLE_KW = {
      incomeStatement: [
        "الإيرادات",
        "تكلفة الإيرادات",
        "مجمل الربح",
        "الربح التشغيلي",
        "مصروفات",
        "income",
        "revenue",
        "gross profit",
        "operating profit",
        "p&l",
      ],
      balanceSheet: [
        "الأصول",
        "الموجودات",
        "الخصوم",
        "المطلوبات",
        "حقوق الملكية",
        "balance sheet",
        "statement of financial position",
      ],
      cashFlow: [
        "التدفقات النقدية",
        "النقد",
        "تشغيلية",
        "استثمارية",
        "تمويلية",
        "cash flow",
        "operating activities",
        "investing activities",
        "financing activities",
      ],
      equity: [
        "التغيرات في حقوق الملكية",
        "أرباح مبقاة",
        "علاوة الإصدار",
        "أسهم خزينة",
        "changes in equity",
        "shareholders' equity",
      ],
    };

    const scoreTable = (t) => {
      // نجمع نصوص الـ sample كاملة كسلسلة واحدة للفحص
      const sample = Array.isArray(t?.sample) ? t.sample : [];
      const flat = sample.flat().map((x) => String(x || ""));
      const text = norm(flat.join(" | "));

      const score = {
        incomeStatement: 0,
        balanceSheet: 0,
        cashFlow: 0,
        equity: 0,
      };

      for (const k of TABLE_KW.incomeStatement) if (text.includes(norm(k))) score.incomeStatement += 2;
      for (const k of TABLE_KW.balanceSheet) if (text.includes(norm(k))) score.balanceSheet += 2;
      for (const k of TABLE_KW.cashFlow) if (text.includes(norm(k))) score.cashFlow += 2;
      for (const k of TABLE_KW.equity) if (text.includes(norm(k))) score.equity += 2;

      // أفضل نوع
      let bestType = "unknown";
      let bestScore = 0;
      for (const [type, sc] of Object.entries(score)) {
        if (sc > bestScore) {
          bestScore = sc;
          bestType = type;
        }
      }

      return { bestType, bestScore, textSample: text.slice(0, 700) };
    };

    // يحاول تحويل قيم عربية/لاتينية إلى رقم
    const toNumber = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === "number" && Number.isFinite(v)) return v;

      const s = String(v).trim();
      if (!s) return null;

      // أقواس سالب (123) أو (١٢٣)
      const isNeg = /^\(.*\)$/.test(s);
      const cleaned = s.replace(/^\(|\)$/g, "").trim();

      // لو عندنا helper جاهز
      if (typeof parseArabicNumber === "function") {
        const n = parseArabicNumber(cleaned);
        if (typeof n === "number" && Number.isFinite(n)) return isNeg ? -n : n;
      }

      // fallback بسيط
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
        "٫": ".",
        "٬": ",",
      };

      const latin = cleaned.replace(/[٠-٩٫٬]/g, (ch) => map[ch] ?? ch);
      const normalizedNum = latin.replace(/,/g, "").replace(/\s+/g, "");

      const n = Number(normalizedNum);
      if (Number.isFinite(n)) return isNeg ? -n : n;
      return null;
    };

    // نجرب نستخرج مؤشرات “نسخة 1” من جدول قائمة الدخل (لو موجود)
    const extractIncomeStatementLite = (table) => {
      // table.sample: صفوف، عادة العمود الأخير = اسم البند
      const sample = Array.isArray(table?.sample) ? table.sample : [];
      if (!sample.length) return {};

      // نحاول نلقط: الإيرادات / تكلفة الإيرادات / مجمل الربح / الربح التشغيلي
      // ونرجع أفضل رقمين موجودين في نفس الصف (مثلاً 2024/2025)
      const pickRowNumbers = (row) => {
        const nums = row.map(toNumber).filter((x) => typeof x === "number" && Number.isFinite(x));
        // غالباً يكون فيه قيمتين (سنة وسنة) — نأخذ آخر قيمتين (أقرب للأرقام الحقيقية)
        if (nums.length >= 2) return nums.slice(-2);
        if (nums.length === 1) return [nums[0]];
        return [];
      };

      const findRow = (kwArr) => {
        for (const row of sample) {
          const rowText = norm(row.join(" | "));
          if (kwArr.some((k) => rowText.includes(norm(k)))) return row;
        }
        return null;
      };

      const out = {};

      const rRevenue = findRow(["الإيرادات", "revenue"]);
      if (rRevenue) out.revenue = pickRowNumbers(rRevenue);

      const rCogs = findRow(["تكلفة الإيرادات", "cost of revenue", "cost of sales"]);
      if (rCogs) out.costOfRevenue = pickRowNumbers(rCogs);

      const rGross = findRow(["مجمل الربح", "gross profit"]);
      if (rGross) out.grossProfit = pickRowNumbers(rGross);

      const rOp = findRow(["الربح التشغيلي", "operating profit", "operating income"]);
      if (rOp) out.operatingProfit = pickRowNumbers(rOp);

      return out;
    };

    // صنّف الجداول وأخرج ملخص
    const classified = tablesPreview.map((t) => {
      const sc = scoreTable(t);
      return {
        index: t.index ?? null,
        rowCount: t.rowCount ?? null,
        columnCount: t.columnCount ?? null,
        type: sc.bestType,
        score: sc.bestScore,
        sample: t.sample || [],
        extractedLite:
          sc.bestType === "incomeStatement" ? extractIncomeStatementLite(t) : {},
      };
    });

    // خذ أفضل جدول قائمة دخل (أعلى score)
    const incomeTables = classified
      .filter((x) => x.type === "incomeStatement")
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    const bestIncome = incomeTables[0] || null;

    // pagesDetected: هنا لن نقدر نحددها بدون نص الصفحات
    const pagesDetected = {
      balanceSheet: [],
      incomeStatement: [],
      cashFlow: [],
      equity: [],
      note: "لا يمكن اكتشاف صفحات القوائم بدون نص الصفحات (p.text). نستخدم tablesPreview حالياً.",
    };

    return send(200, {
      ok: true,
      financial: {
        pagesMeta: {
          pagesCount: pagesMeta.length,
          meta: normalized?.meta || null,
        },

        pagesDetected,

        tablesPreviewCount: tablesPreview.length,
        tablesClassifiedCount: classified.length,

        // نرجع أول 10 فقط عشان لا يصير response ضخم
        tablesClassifiedTop: classified.slice(0, 10).map((t) => ({
          index: t.index,
          rowCount: t.rowCount,
          columnCount: t.columnCount,
          type: t.type,
          score: t.score,
          extractedLite: t.extractedLite,
          // sample مختصر
          sample: Array.isArray(t.sample) ? t.sample.slice(0, 12) : [],
        })),

        bestIncomeTable: bestIncome
          ? {
              index: bestIncome.index,
              score: bestIncome.score,
              extractedLite: bestIncome.extractedLite,
              sample: bestIncome.sample.slice(0, 20),
            }
          : null,
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e?.message || String(e) });
  }
};
