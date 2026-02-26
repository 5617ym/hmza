// /api/analyze/index.js

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = req.body || {};
    const fileName = body.fileName || body.name || "unknown.pdf";

    // هذا اللي عندك في الـ Response: sectionsText = { cashFlow: "...", incomeStatement: "...", ... }
    // إذا كانت عندك باسم آخر غيّره هنا فقط (لكن أنت قلت ما تبغى تعدل؛ فالتزم بالاسم sectionsText)
    const sectionsText = body.sectionsText || {};

    // دمج النصوص لتسهيل البحث (بعض ملفات PDF ما تكون مرتبة)
    const allText = normalizeText(
      [
        sectionsText.incomeStatement,
        sectionsText.cashFlow,
        sectionsText.balanceSheet,
        sectionsText.comprehensiveIncome,
        sectionsText.equityChanges,
        sectionsText.preview,
      ]
        .filter(Boolean)
        .join("\n\n")
    );

    // تحليل المقاييس
    const income = buildIncomeMetrics(allText);
    const cashflow = buildCashflowMetrics(allText);
    const shares = buildSharesMetrics(allText);

    const metrics = {
      income,
      cashflow,
      shares,
    };

    // تساعدك بالـ debugging: ليه طلع "غير متوفر"
    const debug = {
      found: {
        revenue: !!income.revenue,
        grossProfit: !!income.grossProfit,
        operatingProfit: !!income.operatingProfit,
        netIncome: !!income.netIncome,
        cfo: !!cashflow.cfo,
        cfi: !!cashflow.cfi,
        cff: !!cashflow.cff,
        capex: !!cashflow.capex,
        weightedShares: !!shares.weightedAvgSharesBasic,
        epsBasic: !!shares.epsBasic,
        epsDiluted: !!shares.epsDiluted,
      },
      hints: {
        // أقرب سطر تم التقاطه (إن وجد)
        revenueLine: income._lineRevenue || null,
        netIncomeLine: income._lineNetIncome || null,
        cfoLine: cashflow._lineCFO || null,
        capexLine: cashflow._lineCapex || null,
      },
    };

    return res.status(200).json({
      ok: true,
      fileName,
      metrics,
      debug,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Unknown error",
    });
  }
}

/* =========================
   Helpers: normalize + parse
   ========================= */

function normalizeText(s) {
  if (!s) return "";
  let t = String(s);

  // فك \n النصية إذا كانت داخلة كنص
  t = t.replace(/\\n/g, "\n");

  // توحيد المسافات
  t = t.replace(/\u00A0/g, " ");
  t = t.replace(/[ \t]+/g, " ");

  // توحيد الأرقام العربية إلى الإنجليزية
  t = t.replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

  // إزالة التشكيل (اختياري)
  t = t.replace(/[\u064B-\u0652]/g, "");

  return t.trim();
}

function parseNumberFromLine(line) {
  if (!line) return null;

  // يدعم:
  // 23,007,954
  // (108,959)
  // -108,959
  // 108959
  // 108,959.50
  const m = line.match(/(\(?-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|\(?-?\d+(?:\.\d+)?\)?)/);
  if (!m) return null;

  let raw = m[0].trim();

  // إذا بين قوسين = سالب
  const negativeByParens = raw.startsWith("(") && raw.endsWith(")");
  raw = raw.replace(/[(),]/g, "");

  let n = Number(raw);
  if (!Number.isFinite(n)) return null;

  if (negativeByParens) n = -Math.abs(n);
  return n;
}

function pickBestLine(text, keywords, opts = {}) {
  const lines = String(text || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  const {
    // كلمة لازم تكون موجودة (اختياري)
    mustInclude = [],
    // كلمات ممنوعة
    mustNotInclude = [],
    // حد أقصى لطول السطر
    maxLen = 220,
  } = opts;

  const inc = (line, arr) => arr.every((k) => line.includes(k));
  const any = (line, arr) => arr.some((k) => line.includes(k));

  // نبحث عن أفضل سطر يحتوي أي من الكلمات المفتاحية
  let candidates = lines
    .filter((l) => l.length <= maxLen)
    .filter((l) => any(l, keywords))
    .filter((l) => (mustInclude.length ? inc(l, mustInclude) : true))
    .filter((l) => (mustNotInclude.length ? !any(l, mustNotInclude) : true));

  // أولوية: السطر الذي يحتوي أكثر عدد كلمات مطابقة
  candidates.sort((a, b) => scoreLine(b, keywords) - scoreLine(a, keywords));

  return candidates[0] || null;
}

function scoreLine(line, keywords) {
  let s = 0;
  for (const k of keywords) if (line.includes(k)) s += 1;
  // مكافأة لو فيه رقم
  if (/\d/.test(line)) s += 0.5;
  return s;
}

/* =========================
   Metrics Extractors
   ========================= */

function buildIncomeMetrics(allText) {
  const t = allText;

  // الإيرادات
  const revenueLine = pickBestLine(t, [
    "الإيرادات",
    "ايرادات",
    "المبيعات",
    "Sales",
    "Revenue",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "ملاحظات", "Note", "صفحة"],
  });

  const revenue = parseNumberFromLine(revenueLine);

  // مجمل الربح
  const grossProfitLine = pickBestLine(t, [
    "مجمل الربح",
    "Gross profit",
    "Gross Profit",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note"],
  });
  const grossProfit = parseNumberFromLine(grossProfitLine);

  // الربح التشغيلي
  const operatingProfitLine = pickBestLine(t, [
    "الربح التشغيلي",
    "ربح تشغيلي",
    "Operating profit",
    "Operating Profit",
    "EBIT",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note"],
  });
  const operatingProfit = parseNumberFromLine(operatingProfitLine);

  // صافي الربح
  const netIncomeLine = pickBestLine(t, [
    "صافي الربح",
    "صافي الدخل",
    "Net profit",
    "Net income",
    "Profit for the year",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note", "حقوق الأقلية", "غير المسيطرة", "Non-controlling"],
  });
  const netIncome = parseNumberFromLine(netIncomeLine);

  // إرجاع + حفظ السطر للاختبار
  return {
    revenue,
    grossProfit,
    operatingProfit,
    netIncome,
    _lineRevenue: revenueLine || null,
    _lineNetIncome: netIncomeLine || null,
  };
}

function buildCashflowMetrics(allText) {
  const t = allText;

  // CFO التدفق النقدي من التشغيل
  const cfoLine = pickBestLine(t, [
    "التدفقات النقدية من الأنشطة التشغيلية",
    "التدفقات النقدية من التشغيل",
    "صافي النقد من الأنشطة التشغيلية",
    "Net cash from operating activities",
    "Cash flows from operating activities",
    "CFO",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note"],
    maxLen: 260,
  });
  const cfo = parseNumberFromLine(cfoLine);

  // CFI التدفق النقدي من الاستثمار
  const cfiLine = pickBestLine(t, [
    "التدفقات النقدية من الأنشطة الاستثمارية",
    "التدفقات النقدية من الاستثمار",
    "Net cash used in investing activities",
    "Net cash from investing activities",
    "CFI",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note"],
    maxLen: 260,
  });
  const cfi = parseNumberFromLine(cfiLine);

  // CFF التدفق النقدي من التمويل
  const cffLine = pickBestLine(t, [
    "التدفقات النقدية من الأنشطة التمويلية",
    "التدفقات النقدية من التمويل",
    "Net cash from financing activities",
    "Net cash used in financing activities",
    "CFF",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note"],
    maxLen: 260,
  });
  const cff = parseNumberFromLine(cffLine);

  // CAPEX الإنفاق الرأسمالي (قد يأتي كنص: شراء ممتلكات ومعدات)
  const capexLine = pickBestLine(t, [
    "الإنفاق الرأسمالي",
    "الانفاق الرأسمالي",
    "ممتلكات ومعدات",
    "شراء ممتلكات ومعدات",
    "Purchase of property",
    "Purchase of PPE",
    "Capital expenditure",
    "CAPEX",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note"],
    maxLen: 260,
  });
  const capex = parseNumberFromLine(capexLine);

  return {
    cfo,
    cfi,
    cff,
    capex,
    _lineCFO: cfoLine || null,
    _lineCapex: capexLine || null,
  };
}

function buildSharesMetrics(allText) {
  const t = allText;

  // متوسط الأسهم المرجح (Basic)
  const weightedSharesBasicLine = pickBestLine(t, [
    "متوسط الأسهم المرجح",
    "المتوسط المرجح لعدد الأسهم",
    "Weighted average number of shares",
    "Weighted average shares",
    "Weighted Shares",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note"],
    maxLen: 260,
  });
  const weightedAvgSharesBasic = parseNumberFromLine(weightedSharesBasicLine);

  // EPS Basic
  const epsBasicLine = pickBestLine(t, [
    "ربحية السهم الأساسية",
    "ربحية السهم الاساسية",
    "Basic EPS",
    "Earnings per share (basic)",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note"],
    maxLen: 260,
  });
  const epsBasic = parseNumberFromLine(epsBasicLine);

  // EPS Diluted
  const epsDilutedLine = pickBestLine(t, [
    "ربحية السهم المخففة",
    "ربحية السهم المخففه",
    "Diluted EPS",
    "Earnings per share (diluted)",
  ], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note"],
    maxLen: 260,
  });
  const epsDiluted = parseNumberFromLine(epsDilutedLine);

  return {
    weightedAvgSharesBasic,
    epsBasic,
    epsDiluted,
    _lineWeightedShares: weightedSharesBasicLine || null,
    _lineEPSBasic: epsBasicLine || null,
    _lineEPSDiluted: epsDilutedLine || null,
  };
}
