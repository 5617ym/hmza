// /api/analyze/index.js

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "25mb",
    },
  },
};

export default async function handler(req, res) {
  const send = (status, payload) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(status).send(JSON.stringify(payload));
  };

  try {
    if (req.method !== "POST") {
      return send(405, { ok: false, error: "Method not allowed" });
    }

    // ✅ بعض البيئات ترسل body كنص
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return send(400, { ok: false, error: "Invalid JSON body" });
      }
    }
    body = body || {};

    const fileName = body.fileName || body.name || "unknown.pdf";
    const sectionsText = body.sectionsText || {};

    // ✅ لو ما وصلنا sectionsText أساسًا، رجّع خطأ مفهوم بدل 500
    const hasAnySection =
      sectionsText &&
      typeof sectionsText === "object" &&
      Object.values(sectionsText).some((v) => typeof v === "string" && v.trim().length > 0);

    if (!hasAnySection) {
      return send(400, {
        ok: false,
        error:
          "sectionsText غير موجود في الطلب. هذا الـ API الآن يتوقع body.sectionsText مثل اللي ظهر عندك في الـ Response سابقًا.",
        debug: {
          gotKeys: Object.keys(body || {}),
          sectionsTextType: typeof sectionsText,
        },
      });
    }

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

    const income = buildIncomeMetrics(allText);
    const cashflow = buildCashflowMetrics(allText);
    const shares = buildSharesMetrics(allText);

    const metrics = { income, cashflow, shares };

    const debug = {
      found: {
        revenue: income.revenue !== null && income.revenue !== undefined,
        grossProfit: income.grossProfit !== null && income.grossProfit !== undefined,
        operatingProfit: income.operatingProfit !== null && income.operatingProfit !== undefined,
        netIncome: income.netIncome !== null && income.netIncome !== undefined,
        cfo: cashflow.cfo !== null && cashflow.cfo !== undefined,
        cfi: cashflow.cfi !== null && cashflow.cfi !== undefined,
        cff: cashflow.cff !== null && cashflow.cff !== undefined,
        capex: cashflow.capex !== null && cashflow.capex !== undefined,
        weightedShares: shares.weightedAvgSharesBasic !== null && shares.weightedAvgSharesBasic !== undefined,
        epsBasic: shares.epsBasic !== null && shares.epsBasic !== undefined,
        epsDiluted: shares.epsDiluted !== null && shares.epsDiluted !== undefined,
      },
      sampleLines: {
        revenueLine: income._lineRevenue || null,
        netIncomeLine: income._lineNetIncome || null,
        cfoLine: cashflow._lineCFO || null,
        capexLine: cashflow._lineCapex || null,
      },
      textStats: {
        totalChars: allText.length,
      },
    };

    return send(200, { ok: true, fileName, metrics, debug });
  } catch (err) {
    // ✅ رجّع خطأ واضح دائمًا
    const message =
      (err && (err.message || (err.toString && err.toString()))) || "Unhandled server error";

    return send(500, {
      ok: false,
      error: message,
      stack: err?.stack || null,
    });
  }
}

/* =========================
   Helpers
   ========================= */

function normalizeArabicDigits(s) {
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
    "٫": ".",
    "٬": ",",
  };
  return String(s).replace(/[٠-٩۰-۹٫٬]/g, (ch) => map[ch] ?? ch);
}

function normalizeText(s) {
  if (!s) return "";
  let t = String(s);

  // لو جايك كنص فيه \n
  t = t.replace(/\\n/g, "\n");

  // مسافات غير قابلة للكسر
  t = t.replace(/\u00A0/g, " ");

  // احذف رموز اتجاه RTL/LTR
  t = t.replace(/[\u200E\u200F\u202A-\u202E]/g, "");

  // وحّد أرقام عربية + فواصل عربية
  t = normalizeArabicDigits(t);

  // احذف التشكيل
  t = t.replace(/[\u064B-\u0652]/g, "");

  // خفف تكدس المسافات
  t = t.replace(/[ \t]+/g, " ");

  return t.trim();
}

function parseFinancialNumber(raw) {
  if (raw == null) return null;

  let s = normalizeArabicDigits(raw);

  // احذف رموز اتجاه النص RTL/LTR
  s = s.replace(/[\u200E\u200F\u202A-\u202E]/g, "").trim();

  // سالب بالأقواس
  let isNeg = false;
  if (/^\(.*\)$/.test(s)) {
    isNeg = true;
    s = s.slice(1, -1).trim();
  }

  // إشارات سالب مختلفة
  if (/^[\-−–—]/.test(s)) {
    isNeg = true;
    s = s.replace(/^[\-−–—]+/, "");
  }

  // خلي فقط أرقام + فواصل + نقطة
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;

  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;

  // لو صيغة 123,45 (فاصلة عشرية)
  if (dots === 0 && commas === 1) {
    const [a, b] = s.split(",");
    if (b && b.length <= 2) s = a + "." + b;
    else s = s.replace(/,/g, "");
  } else {
    // اعتبر الفواصل آلاف
    s = s.replace(/,/g, "");
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  return isNeg ? -Math.abs(n) : n;
}

function parseNumberFromLine(line) {
  if (!line) return null;

  // يلتقط الأرقام سواء عربية/إنجليزية + فواصل عربية/إنجليزية + أقواس + سالب
  const m = String(line).match(/[\(]?[\-−–—]?\s*[\d٠-٩۰-۹][\d٠-٩۰-۹\s,٬\.٫]*[\)]?/);
  if (!m) return null;

  return parseFinancialNumber(m[0]);
}

function pickBestLine(text, keywords, opts = {}) {
  const lines = String(text || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  const { mustInclude = [], mustNotInclude = [], maxLen = 220 } = opts;

  const inc = (line, arr) => arr.every((k) => line.includes(k));
  const any = (line, arr) => arr.some((k) => line.includes(k));

  let candidates = lines
    .filter((l) => l.length <= maxLen)
    .filter((l) => any(l, keywords))
    .filter((l) => (mustInclude.length ? inc(l, mustInclude) : true))
    .filter((l) => (mustNotInclude.length ? !any(l, mustNotInclude) : true));

  candidates.sort((a, b) => scoreLine(b, keywords) - scoreLine(a, keywords));
  return candidates[0] || null;
}

function scoreLine(line, keywords) {
  let s = 0;
  for (const k of keywords) if (line.includes(k)) s += 1;
  if (/\d/.test(line)) s += 0.5;
  return s;
}

/* =========================
   Extractors
   ========================= */

function buildIncomeMetrics(t) {
  const revenueLine = pickBestLine(
    t,
    ["الإيرادات", "ايرادات", "المبيعات", "Sales", "Revenue"],
    { mustNotInclude: ["إيضاحات", "ملاحظة", "ملاحظات", "Note", "صفحة"] }
  );
  const revenue = parseNumberFromLine(revenueLine);

  const grossProfitLine = pickBestLine(t, ["مجمل الربح", "Gross profit", "Gross Profit"], {
    mustNotInclude: ["إيضاحات", "ملاحظة", "Note"],
  });
  const grossProfit = parseNumberFromLine(grossProfitLine);

  const operatingProfitLine = pickBestLine(
    t,
    ["الربح التشغيلي", "ربح تشغيلي", "Operating profit", "Operating Profit", "EBIT"],
    { mustNotInclude: ["إيضاحات", "ملاحظة", "Note"] }
  );
  const operatingProfit = parseNumberFromLine(operatingProfitLine);

  const netIncomeLine = pickBestLine(
    t,
    ["صافي الربح", "صافي الدخل", "Net profit", "Net income", "Profit for the year"],
    {
      mustNotInclude: ["إيضاحات", "ملاحظة", "Note", "حقوق الأقلية", "غير المسيطرة", "Non-controlling"],
    }
  );
  const netIncome = parseNumberFromLine(netIncomeLine);

  return {
    revenue,
    grossProfit,
    operatingProfit,
    netIncome,
    _lineRevenue: revenueLine || null,
    _lineNetIncome: netIncomeLine || null,
  };
}

function buildCashflowMetrics(t) {
  const cfoLine = pickBestLine(
    t,
    [
      "التدفقات النقدية من الأنشطة التشغيلية",
      "التدفقات النقدية من التشغيل",
      "صافي النقد من الأنشطة التشغيلية",
      "Net cash from operating activities",
      "Cash flows from operating activities",
      "CFO",
    ],
    { mustNotInclude: ["إيضاحات", "ملاحظة", "Note"], maxLen: 260 }
  );
  const cfo = parseNumberFromLine(cfoLine);

  const cfiLine = pickBestLine(
    t,
    [
      "التدفقات النقدية من الأنشطة الاستثمارية",
      "التدفقات النقدية من الاستثمار",
      "Net cash used in investing activities",
      "Net cash from investing activities",
      "CFI",
    ],
    { mustNotInclude: ["إيضاحات", "ملاحظة", "Note"], maxLen: 260 }
  );
  const cfi = parseNumberFromLine(cfiLine);

  const cffLine = pickBestLine(
    t,
    [
      "التدفقات النقدية من الأنشطة التمويلية",
      "التدفقات النقدية من التمويل",
      "Net cash from financing activities",
      "Net cash used in financing activities",
      "CFF",
    ],
    { mustNotInclude: ["إيضاحات", "ملاحظة", "Note"], maxLen: 260 }
  );
  const cff = parseNumberFromLine(cffLine);

  const capexLine = pickBestLine(
    t,
    [
      "الإنفاق الرأسمالي",
      "الانفاق الرأسمالي",
      "ممتلكات ومعدات",
      "شراء ممتلكات ومعدات",
      "Purchase of property",
      "Purchase of PPE",
      "Capital expenditure",
      "CAPEX",
    ],
    { mustNotInclude: ["إيضاحات", "ملاحظة", "Note"], maxLen: 260 }
  );
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

function buildSharesMetrics(t) {
  const weightedSharesBasicLine = pickBestLine(
    t,
    [
      "متوسط الأسهم المرجح",
      "المتوسط المرجح لعدد الأسهم",
      "Weighted average number of shares",
      "Weighted average shares",
      "Weighted Shares",
    ],
    { mustNotInclude: ["إيضاحات", "ملاحظة", "Note"], maxLen: 260 }
  );
  const weightedAvgSharesBasic = parseNumberFromLine(weightedSharesBasicLine);

  const epsBasicLine = pickBestLine(
    t,
    ["ربحية السهم الأساسية", "ربحية السهم الاساسية", "Basic EPS", "Earnings per share (basic)"],
    { mustNotInclude: ["إيضاحات", "ملاحظة", "Note"], maxLen: 260 }
  );
  const epsBasic = parseNumberFromLine(epsBasicLine);

  const epsDilutedLine = pickBestLine(
    t,
    ["ربحية السهم المخففة", "ربحية السهم المخففه", "Diluted EPS", "Earnings per share (diluted)"],
    { mustNotInclude: ["إيضاحات", "ملاحظة", "Note"], maxLen: 260 }
  );
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
