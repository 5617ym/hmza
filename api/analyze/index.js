// ===============================
// Step 1: Number cleaning + sanity checks
// ===============================

function normalizeArabicDigits(s = "") {
  const map = {
    "٠": "0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "۰": "0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
  };
  return String(s).replace(/[٠-٩۰-۹]/g, (d) => map[d] ?? d);
}

function looksLikeYear(n, periodYear) {
  if (!Number.isFinite(n)) return false;
  // سنوات شائعة + سنة الفترة (مثلاً 2024)
  if (n >= 1990 && n <= 2090) return true;
  if (periodYear && Math.abs(n - periodYear) <= 1) return true;
  return false;
}

function parseMoneyFromSnippet(snippet) {
  if (!snippet) return null;

  // طبعاً نطبع الأرقام العربية ونزيل المسافات الغريبة
  const s0 = normalizeArabicDigits(snippet)
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ");

  // أهم جزء: نلتقط "رقم واحد" فقط (مع فواصل)
  // مثال: 541,162,565
  // ونرفض إذا جاء رقمين ملتصقين بدون فاصل منطقي
  const m = s0.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/);
  if (!m) return null;

  const token = m[0];

  // إزالة الفواصل وتحويله لرقم
  const num = Number(token.replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;

  return num;
}

function cleanField(field, opts = {}) {
  // field expected shape: { value, snippet }
  if (!field) return { value: null, snippet: null };

  const periodYear = opts.periodYear ?? null;

  let v = field.value;

  // إذا القيمة نص أو null، نحاول نقرأها من snippet
  if (!Number.isFinite(v)) {
    v = parseMoneyFromSnippet(field.snippet);
  }

  // فلترة: سنة؟ أو رقم صغير جداً غير منطقي؟
  if (!Number.isFinite(v)) return { value: null, snippet: field.snippet ?? null };

  // 1) امنع السنوات
  if (looksLikeYear(v, periodYear)) {
    return { value: null, snippet: field.snippet ?? null };
  }

  // 2) امنع قيم “مضحكة” مثل -23 في قوائم مالية سنوية
  // (تقدر تشددها لاحقاً، الآن نخليها بسيطة)
  if (Math.abs(v) < 1000) {
    return { value: null, snippet: field.snippet ?? null };
  }

  // 3) منع الأرقام الضخمة غير المنطقية الناتجة من “دمج رقمين”
  // إذا أكبر من 10^13 غالباً صار دمج أو قراءة خاطئة (حسب شركتك ممكن تعدل)
  if (Math.abs(v) > 1e13) {
    return { value: null, snippet: field.snippet ?? null };
  }

  return { value: v, snippet: field.snippet ?? null };
}

function postProcessExtracted(extracted, meta) {
  const periodYear = (() => {
    const h = meta?.periodHint || "";
    const m = normalizeArabicDigits(h).match(/(20\d{2})/);
    return m ? Number(m[1]) : null;
  })();

  const out = structuredClone(extracted || {});

  // Income statement
  if (out.incomeStatement) {
    out.incomeStatement.revenue = cleanField(out.incomeStatement.revenue, { periodYear });
    out.incomeStatement.grossProfit = cleanField(out.incomeStatement.grossProfit, { periodYear });
    out.incomeStatement.operatingProfit = cleanField(out.incomeStatement.operatingProfit, { periodYear });
    out.incomeStatement.netIncome = cleanField(out.incomeStatement.netIncome, { periodYear });
  }

  // Balance sheet
  if (out.balanceSheet) {
    out.balanceSheet.totalAssets = cleanField(out.balanceSheet.totalAssets, { periodYear });
    out.balanceSheet.totalLiabilities = cleanField(out.balanceSheet.totalLiabilities, { periodYear });
    out.balanceSheet.totalEquity = cleanField(out.balanceSheet.totalEquity, { periodYear });
  }

  // Cashflow
  if (out.cashFlow) {
    out.cashFlow.cfo = cleanField(out.cashFlow.cfo, { periodYear });
    out.cashFlow.cfi = cleanField(out.cashFlow.cfi, { periodYear });
    out.cashFlow.cff = cleanField(out.cashFlow.cff, { periodYear });
    out.cashFlow.capex = cleanField(out.cashFlow.capex, { periodYear });
  }

  // Shares
  if (out.shares) {
    out.shares.weightedShares = cleanField(out.shares.weightedShares, { periodYear });
    out.shares.epsBasic = cleanField(out.shares.epsBasic, { periodYear });
    out.shares.epsDiluted = cleanField(out.shares.epsDiluted, { periodYear });
  }

  return out;
}

const pdfParse = require("pdf-parse");

// ---------- Helpers ----------
function normalizeText(raw) {
  if (!raw) return "";
  // توحيد الأرقام العربية-الهندية إلى أرقام لاتينية
  const map = {
    "٠": "0","١": "1","٢": "2","٣": "3","٤": "4","٥": "5","٦": "6","٧": "7","٨": "8","٩": "9",
    "۰": "0","۱": "1","۲": "2","۳": "3","۴": "4","۵": "5","۶": "6","۷": "7","۸": "8","۹": "9",
    "٬": ",", "٫": ".", "،": ","
  };
  let t = raw.replace(/[٠-٩۰-۹٬٫،]/g, (c) => map[c] ?? c);
  // تقليل الفراغات
  t = t.replace(/\r/g, "\n");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function toNumber(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;

  // يسمح بصيغ مثل: (1,234) أو -1,234 أو 1,234.56
  const isParenNeg = /^\(.*\)$/.test(str);
  const cleaned = str
    .replace(/[()]/g, "")
    .replace(/[, ]/g, "")
    .replace(/[^\d.\-]/g, "");

  if (!cleaned || cleaned === "-" || cleaned === ".") return null;

  const n = Number(cleaned);
  if (Number.isNaN(n)) return null;
  return isParenNeg ? -Math.abs(n) : n;
}

function pickFirstMatch(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m;
  }
  return null;
}

function findValueNearLabel(text, labelRegexes) {
  // نحاول نلقط رقم قريب من السطر نفسه (أفضل حل عملي كبداية)
  // مثال سطر: "الإيرادات  12,345  11,222"
  // نأخذ أول رقم كبير يظهر بعد العنوان
  for (const r of labelRegexes) {
    const idx = text.search(r);
    if (idx === -1) continue;

    const window = text.slice(idx, idx + 500); // نافذة بعد العنوان
    const numMatch = window.match(/(\(?-?\d[\d, ]{2,}\)?(?:\.\d+)?)/);
    if (numMatch) {
      return {
        value: toNumber(numMatch[1]),
        snippet: window.slice(0, 180).trim()
      };
    }
  }
  return { value: null, snippet: null };
}

function extractMeta(text) {
  // اسم الشركة (تقريبي)
  const companyMatch = pickFirstMatch(text, [
    /شركة\s+([^\n]{2,80})/i,
    /([^\n]{2,80})\s+شركة/i
  ]);
  const company = companyMatch ? (companyMatch[0] || "").trim() : null;

  // تاريخ/فترة (تقريبي)
  const periodMatch = pickFirstMatch(text, [
    /للسنة\s+المنتهية\s+في\s+(\d{1,2}\s+\S+\s+\d{4})/i,
    /للفترة\s+المنتهية\s+في\s+(\d{1,2}\s+\S+\s+\d{4})/i,
    /(31)\s*(?:ديسمبر|December)\s*(\d{4})/i,
    /(\d{4})\s*\/\s*(\d{2})\s*\/\s*(\d{2})/
  ]);

  const currencyMatch = pickFirstMatch(text, [
    /بالريال\s+السعودي/i,
    /ريال\s+سعودي/i,
    /Saudi\s+Riyal/i,
    /\bSAR\b/i
  ]);

  const currency = currencyMatch ? "SAR" : null;

  return { company, currency, periodHint: periodMatch ? periodMatch[0] : null };
}

function extractStatements(text) {
  // -------- Income Statement --------
  const revenue = findValueNearLabel(text, [
    /الإيرادات/i,
    /صافي\s+المبيعات/i,
    /Revenue/i,
    /Net\s+Sales/i
  ]);

  const grossProfit = findValueNearLabel(text, [
    /مجمل\s+الربح/i,
    /Gross\s+Profit/i
  ]);

  const operatingProfit = findValueNearLabel(text, [
    /الربح\s+التشغيلي/i,
    /دخل\s+تشغيلي/i,
    /Operating\s+Profit/i,
    /Operating\s+Income/i
  ]);

  const netIncome = findValueNearLabel(text, [
    /صافي\s+الربح/i,
    /صافي\s+الدخل/i,
    /Net\s+Income/i,
    /Profit\s+for\s+the\s+period/i
  ]);

  // -------- Balance Sheet --------
  const totalAssets = findValueNearLabel(text, [
    /إجمالي\s+الأصول/i,
    /Total\s+Assets/i
  ]);

  const totalLiabilities = findValueNearLabel(text, [
    /إجمالي\s+الالتزامات/i,
    /Total\s+Liabilities/i
  ]);

  const totalEquity = findValueNearLabel(text, [
    /إجمالي\s+حقوق\s+الملكية/i,
    /إجمالي\s+حقوق\s+المساهمين/i,
    /Total\s+Equity/i
  ]);

  // -------- Cash Flow --------
  const cfo = findValueNearLabel(text, [
    /صافي\s+النقد\s+من\s+الأنشطة\s+التشغيلية/i,
    /Net\s+cash\s+from\s+operating\s+activities/i
  ]);

  const cfi = findValueNearLabel(text, [
    /صافي\s+النقد\s+من\s+الأنشطة\s+الاستثمارية/i,
    /Net\s+cash\s+from\s+investing\s+activities/i
  ]);

  const cff = findValueNearLabel(text, [
    /صافي\s+النقد\s+من\s+الأنشطة\s+التمويلية/i,
    /Net\s+cash\s+from\s+financing\s+activities/i
  ]);

  const capex = findValueNearLabel(text, [
    /ممتلكات\s+ومعدات/i,
    /إنفاق\s+رأسمالي/i,
    /Purchases?\s+of\s+property/i,
    /Capital\s+expenditure/i
  ]);

  // -------- Shares / EPS --------
  const epsBasic = findValueNearLabel(text, [
    /ربحية\s+السهم\s+الأساسية/i,
    /Basic\s+EPS/i
  ]);

  const epsDiluted = findValueNearLabel(text, [
    /ربحية\s+السهم\s+المخفضة/i,
    /Diluted\s+EPS/i
  ]);

  const weightedShares = findValueNearLabel(text, [
    /المتوسط\s+المرجح\s+لعدد\s+الأسهم/i,
    /Weighted\s+average\s+number\s+of\s+shares/i
  ]);

  return {
    incomeStatement: {
      revenue,
      grossProfit,
      operatingProfit,
      netIncome
    },
    balanceSheet: {
      totalAssets,
      totalLiabilities,
      totalEquity
    },
    cashFlow: {
      cfo,
      cfi,
      cff,
      capex
    },
    shares: {
      weightedShares,
      epsBasic,
      epsDiluted
    }
  };
}

// ---------- Azure Function ----------
module.exports = async function (context, req) {
  try {
    if ((req.method || "").toUpperCase() === "GET") {
      context.res = {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: { message: "API شغالة بنجاح 🚀", timestamp: new Date().toISOString() }
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
        body: { ok: false, error: "لم يتم إرسال fileBase64" }
      };
      return;
    }

    const cleaned = fileBase64.includes("base64,")
      ? fileBase64.split("base64,")[1]
      : fileBase64;

    const buffer = Buffer.from(cleaned, "base64");
    const parsed = await pdfParse(buffer);
    const text = normalizeText(parsed.text || "");

    const meta = extractMeta(text);
    const extracted = extractStatements(text);

    // درجة بسيطة للنجاح: كم قيمة أساسية قدرنا نجيبها
    const keyValues = [
      extracted.incomeStatement.revenue.value,
      extracted.incomeStatement.netIncome.value,
      extracted.balanceSheet.totalAssets.value,
      extracted.cashFlow.cfo.value
    ];
    const foundCount = keyValues.filter(v => typeof v === "number").length;

    context.res = {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        ok: true,
        fileName,
        pages: parsed.numpages,
        textLength: text.length,
        meta,
        extracted,
        extractionScore: {
          foundCount,
          totalChecked: keyValues.length
        },
        // نعرض مقطع صغير فقط للتأكد (بدون إغراق)
        preview: text.slice(0, 800)
      }
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: { ok: false, error: err?.message || "خطأ غير معروف" }
    };
  }
};
