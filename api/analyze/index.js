// /api/analyze/index.js
// Azure Static Web Apps Function (Node.js)
// Purpose: Receive PDF (base64), extract text, build meta + preview,
// and extract key financial fields with sanity checks (Step 1) + better extraction (Step 2)

const pdfParse = require("pdf-parse");

// ===============================
// Helpers: Number cleaning + sanity checks (Step 1)
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
  if (n >= 1990 && n <= 2090) return true;
  if (periodYear && Math.abs(n - periodYear) <= 1) return true;
  return false;
}

function parseFirstMoneyLikeNumber(snippet) {
  if (!snippet) return null;

  const s0 = normalizeArabicDigits(snippet)
    .replace(/\u00A0/g, " ")
    .replace(/[٬]/g, ",") // Arabic thousands separator sometimes
    .replace(/\s+/g, " ");

  // grab first numeric token (supports commas)
  const m = s0.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/);
  if (!m) return null;

  const token = m[0];
  const num = Number(token.replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;

  return num;
}

function cleanField(field, opts = {}) {
  const periodYear = opts.periodYear ?? null;

  if (!field) return { value: null, snippet: null };

  let v = field.value;

  // try parse from snippet if needed
  if (!Number.isFinite(v)) {
    v = parseFirstMoneyLikeNumber(field.snippet);
  }

  if (!Number.isFinite(v)) return { value: null, snippet: field.snippet ?? null };

  // block years
  if (looksLikeYear(v, periodYear)) {
    return { value: null, snippet: field.snippet ?? null };
  }

  // block tiny values that are usually wrong for annual statements
  if (Math.abs(v) < 1000) {
    return { value: null, snippet: field.snippet ?? null };
  }

  // block absurdly large values (often merged numbers)
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

  // clone-safe
  const out = JSON.parse(JSON.stringify(extracted || {}));

  if (out.incomeStatement) {
    out.incomeStatement.revenue = cleanField(out.incomeStatement.revenue, { periodYear });
    out.incomeStatement.grossProfit = cleanField(out.incomeStatement.grossProfit, { periodYear });
    out.incomeStatement.operatingProfit = cleanField(out.incomeStatement.operatingProfit, { periodYear });
    out.incomeStatement.netIncome = cleanField(out.incomeStatement.netIncome, { periodYear });
  }

  if (out.balanceSheet) {
    out.balanceSheet.totalAssets = cleanField(out.balanceSheet.totalAssets, { periodYear });
    out.balanceSheet.totalLiabilities = cleanField(out.balanceSheet.totalLiabilities, { periodYear });
    out.balanceSheet.totalEquity = cleanField(out.balanceSheet.totalEquity, { periodYear });
  }

  if (out.cashFlow) {
    out.cashFlow.cfo = cleanField(out.cashFlow.cfo, { periodYear });
    out.cashFlow.cfi = cleanField(out.cashFlow.cfi, { periodYear });
    out.cashFlow.cff = cleanField(out.cashFlow.cff, { periodYear });
    out.cashFlow.capex = cleanField(out.cashFlow.capex, { periodYear });
  }

  if (out.shares) {
    out.shares.weightedShares = cleanField(out.shares.weightedShares, { periodYear });
    out.shares.epsBasic = cleanField(out.shares.epsBasic, { periodYear });
    out.shares.epsDiluted = cleanField(out.shares.epsDiluted, { periodYear });
  }

  return out;
}

// ===============================
// Step 2: Better extraction from text context
// - Search for Arabic labels, take a window around it,
// - pick best "money-like" number from that window
// ===============================

function takeWindow(text, idx, radius = 350) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return text.slice(start, end);
}

function extractBestNumberNearLabel(fullText, labels = []) {
  if (!fullText || !labels.length) return { value: null, snippet: null };

  const t = normalizeArabicDigits(fullText).replace(/\u00A0/g, " ").replace(/[٬]/g, ",");
  const lower = t.toLowerCase();

  // find earliest occurrence among labels (prefer statements)
  let bestIdx = -1;
  let bestLabel = null;

  for (const lab of labels) {
    const i = lower.indexOf(normalizeArabicDigits(lab).toLowerCase());
    if (i !== -1 && (bestIdx === -1 || i < bestIdx)) {
      bestIdx = i;
      bestLabel = lab;
    }
  }

  if (bestIdx === -1) return { value: null, snippet: null };

  const snippet = takeWindow(t, bestIdx, 500);

  // collect all money-like tokens in that snippet
  const tokens = snippet.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g);
  if (!tokens || !tokens.length) return { value: null, snippet };

  // rank tokens: prefer ones with commas (usually real amounts), and larger magnitudes
  const candidates = tokens
    .map((tok) => {
      const num = Number(tok.replace(/,/g, ""));
      return { tok, num };
    })
    .filter((x) => Number.isFinite(x.num));

  if (!candidates.length) return { value: null, snippet };

  candidates.sort((a, b) => {
    const aComma = a.tok.includes(",") ? 1 : 0;
    const bComma = b.tok.includes(",") ? 1 : 0;
    if (bComma !== aComma) return bComma - aComma;
    return Math.abs(b.num) - Math.abs(a.num);
  });

  // take top candidate
  return { value: candidates[0].num, snippet };
}

function extractFinancialsFromText(fullText) {
  // Income statement
  const revenue = extractBestNumberNearLabel(fullText, ["الإيرادات", "إيرادات", "Revenue"]);
  const grossProfit = extractBestNumberNearLabel(fullText, ["مجمل الربح", "Gross profit"]);
  const operatingProfit = extractBestNumberNearLabel(fullText, ["الربح التشغيلي", "Operating profit", "الربح من العمليات"]);
  const netIncome = extractBestNumberNearLabel(fullText, ["صافي الربح", "صافي (الربح", "Net income", "Profit for the year"]);

  // Balance sheet
  const totalAssets = extractBestNumberNearLabel(fullText, ["إجمالي الأصول", "Total assets"]);
  const totalLiabilities = extractBestNumberNearLabel(fullText, ["إجمالي المطلوبات", "Total liabilities", "إجمالي الالتزامات"]);
  const totalEquity = extractBestNumberNearLabel(fullText, ["إجمالي حقوق الملكية", "Total equity"]);

  // Cashflow
  const cfo = extractBestNumberNearLabel(fullText, ["صافي النقد من الأنشطة التشغيلية", "التدفقات النقدية من الأنشطة التشغيلية", "CFO"]);
  const cfi = extractBestNumberNearLabel(fullText, ["صافي النقد من الأنشطة الاستثمارية", "CFI"]);
  const cff = extractBestNumberNearLabel(fullText, ["صافي النقد من الأنشطة التمويلية", "CFF"]);
  const capex = extractBestNumberNearLabel(fullText, ["الإنفاق الرأسمالي", "مشتريات ممتلكات", "CAPEX"]);

  // Shares/EPS
  const weightedShares = extractBestNumberNearLabel(fullText, ["متوسط عدد الأسهم", "Weighted average number of shares"]);
  const epsBasic = extractBestNumberNearLabel(fullText, ["ربحية السهم الأساسية", "EPS (Basic)", "Basic EPS"]);
  const epsDiluted = extractBestNumberNearLabel(fullText, ["ربحية السهم المخففة", "EPS (Diluted)", "Diluted EPS"]);

  return {
    incomeStatement: { revenue, grossProfit, operatingProfit, netIncome },
    balanceSheet: { totalAssets, totalLiabilities, totalEquity },
    cashFlow: { cfo, cfi, cff, capex },
    shares: { weightedShares, epsBasic, epsDiluted },
  };
}

// ===============================
// Meta + preview
// ===============================

function buildMetaFromText(text) {
  const t = (text || "").replace(/\u00A0/g, " ");
  const meta = {};

  // company (very naive but useful)
  // take first non-empty line as candidate company name
  const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);
  if (lines.length) meta.company = lines[0].slice(0, 120);

  // currency
  if (/SAR|ريال|ر\.س/i.test(t)) meta.currency = "SAR";

  // period hint
  const m = t.match(/للسنة\s+المنتهية\s+في[\s\S]{0,40}(20\d{2})/);
  if (m) meta.periodHint = `للسنة المنتهية في ${m[1]}`;

  // also try: "31 ديسمبر 2024"
  const m2 = t.match(/31\s+ديسمبر\s+(20\d{2})/);
  if (!meta.periodHint && m2) meta.periodHint = `للسنة المنتهية في 31 ديسمبر ${m2[1]}`;

  return meta;
}

function buildPreview(text, maxChars = 1800) {
  if (!text) return "";
  const t = text.replace(/\u00A0/g, " ").replace(/\s+\n/g, "\n");
  return t.slice(0, maxChars);
}

// ===============================
// Azure Function handler
// ===============================

module.exports = async function (context, req) {
  try {
    // CORS (adjust if needed)
    context.res = context.res || {};
    context.res.headers = {
      ...(context.res.headers || {}),
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      context.res.status = 204;
      context.res.body = "";
      return;
    }

    if (req.method !== "POST") {
      context.res.status = 405;
      context.res.body = { ok: false, error: "Method not allowed. Use POST." };
      return;
    }

    const body = req.body || {};
    const fileName = body.fileName || "file.pdf";
    let fileBase64 = body.fileBase64;

    if (!fileBase64 || typeof fileBase64 !== "string" || fileBase64.length < 50) {
      context.res.status = 400;
      context.res.body = { ok: false, error: "API error 400: لم يتم إرسال fileBase64" };
      return;
    }

    // Strip data URL prefix if present
    const commaIdx = fileBase64.indexOf(",");
    if (fileBase64.startsWith("data:") && commaIdx !== -1) {
      fileBase64 = fileBase64.slice(commaIdx + 1);
    }

    let pdfBuffer;
    try {
      pdfBuffer = Buffer.from(fileBase64, "base64");
    } catch (e) {
      context.res.status = 400;
      context.res.body = { ok: false, error: "API error 400: fileBase64 غير صالح" };
      return;
    }

    // Parse PDF
    const parsed = await pdfParse(pdfBuffer);
    const text = parsed.text || "";
    const pages = Number.isFinite(parsed.numpages) ? parsed.numpages : null;
    const textLength = text.length;

    const meta = buildMetaFromText(text);
    const preview = buildPreview(text);

    // Extract (Step 2)
    let extracted = extractFinancialsFromText(text);

    // Score (how many fields have values before/after cleaning)
    const totalChecked = 4; // revenue, grossProfit, operatingProfit, netIncome (simple score)
    const foundCountRaw = [
      extracted?.incomeStatement?.revenue?.value,
      extracted?.incomeStatement?.grossProfit?.value,
      extracted?.incomeStatement?.operatingProfit?.value,
      extracted?.incomeStatement?.netIncome?.value,
    ].filter((v) => Number.isFinite(v)).length;

    // Post-process (Step 1)
    extracted = postProcessExtracted(extracted, meta);

    const foundCountClean = [
      extracted?.incomeStatement?.revenue?.value,
      extracted?.incomeStatement?.grossProfit?.value,
      extracted?.incomeStatement?.operatingProfit?.value,
      extracted?.incomeStatement?.netIncome?.value,
    ].filter((v) => Number.isFinite(v)).length;

    const extractionScore = {
      foundCount: foundCountClean,
      totalChecked,
      foundCountRaw,
    };

    context.res.status = 200;
    context.res.body = {
      ok: true,
      fileName,
      pages,
      textLength,
      meta,
      extracted,
      extractionScore,
      preview,
    };
  } catch (err) {
    context.res.status = 500;
    context.res.body = {
      ok: false,
      error: "Server error",
      details: String(err && err.message ? err.message : err),
    };
  }
};
