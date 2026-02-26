// api/analyze/index.js
// Azure Static Web Apps API (Azure Functions - Node.js)

module.exports = async function (context, req) {
  const send = (status, payload) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: payload,
    };
  };

  try {
    if ((req.method || "").toUpperCase() !== "POST") {
      return send(405, { ok: false, error: "Method not allowed" });
    }

    const body = req.body || {};
    const fileName = body.fileName || body.name || "unknown.pdf";
let sectionsText = body.sectionsText || null;

// لو جاء PDF Base64 من الواجهة
const fileBase64 = body.fileBase64 || null;

if (!sectionsText && fileBase64) {
  const extractedText = await extractTextFromPdfBase64(fileBase64);
  sectionsText = { preview: extractedText };
}

    const hasAnySection =
      sectionsText &&
      typeof sectionsText === "object" &&
      Object.values(sectionsText).some((v) => typeof v === "string" && v.trim().length > 0);

    if (!hasAnySection) {
      return send(400, {
        ok: false,
        error: "sectionsText غير موجود في الطلب. أرسل body.sectionsText.",
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
        revenue: income.revenue != null,
        grossProfit: income.grossProfit != null,
        operatingProfit: income.operatingProfit != null,
        netIncome: income.netIncome != null,
        cfo: cashflow.cfo != null,
        cfi: cashflow.cfi != null,
        cff: cashflow.cff != null,
        capex: cashflow.capex != null,
        weightedShares: shares.weightedAvgSharesBasic != null,
        epsBasic: shares.epsBasic != null,
        epsDiluted: shares.epsDiluted != null,
      },
      sampleLines: {
        revenueLine: income._lineRevenue || null,
        netIncomeLine: income._lineNetIncome || null,
        cfoLine: cashflow._lineCFO || null,
        capexLine: cashflow._lineCapex || null,
      },
      textStats: { totalChars: allText.length },
    };

    return send(200, { ok: true, fileName, metrics, debug });
  } catch (err) {
    const message = (err && (err.message || String(err))) || "Unhandled server error";
    return send(500, { ok: false, error: message, stack: err?.stack || null });
  }
};

/* =========================
   Helpers
   ========================= */

function normalizeArabicDigits(s) {
  const map = {
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
    "٫":".","٬":","
  };
  return String(s).replace(/[٠-٩۰-۹٫٬]/g, (ch) => map[ch] ?? ch);
}

function normalizeText(s) {
  if (!s) return "";
  let t = String(s);
  t = t.replace(/\\n/g, "\n");
  t = t.replace(/\u00A0/g, " ");
  t = t.replace(/[\u200E\u200F\u202A-\u202E]/g, "");
  t = normalizeArabicDigits(t);
  t = t.replace(/[\u064B-\u0652]/g, "");
  t = t.replace(/[ \t]+/g, " ");
  return t.trim();
}

function parseFinancialNumber(raw) {
  if (raw == null) return null;

  let s = normalizeArabicDigits(raw);
  s = s.replace(/[\u200E\u200F\u202A-\u202E]/g, "").trim();

  let isNeg = false;
  if (/^\(.*\)$/.test(s)) {
    isNeg = true;
    s = s.slice(1, -1).trim();
  }
  if (/^[\-−–—]/.test(s)) {
    isNeg = true;
    s = s.replace(/^[\-−–—]+/, "");
  }

  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;

  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;

  if (dots === 0 && commas === 1) {
    const [a, b] = s.split(",");
    if (b && b.length <= 2) s = a + "." + b;
    else s = s.replace(/,/g, "");
  } else {
    s = s.replace(/,/g, "");
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return isNeg ? -Math.abs(n) : n;
}

function parseNumberFromLine(line) {
  if (!line) return null;
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
    { mustNotInclude: ["إيضاحات", "ملاحظة", "Note", "حقوق الأقلية", "غير المسيطرة", "Non-controlling"] }
  );
  const netIncome = parseNumberFromLine(netIncomeLine);

  return { revenue, grossProfit, operatingProfit, netIncome, _lineRevenue: revenueLine || null, _lineNetIncome: netIncomeLine || null };
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

  return { cfo, cfi, cff, capex, _lineCFO: cfoLine || null, _lineCapex: capexLine || null };
}

function buildSharesMetrics(t) {
  const weightedSharesBasicLine = pickBestLine(
    t,
    ["متوسط الأسهم المرجح", "المتوسط المرجح لعدد الأسهم", "Weighted average number of shares", "Weighted average shares", "Weighted Shares"],
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
