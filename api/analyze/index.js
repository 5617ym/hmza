const pdfParse = require("pdf-parse");

/* =========================
   Normalization
========================= */

function normalizeText(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ـ/g, "")
    .replace(/[٬،]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================
   Section Titles
========================= */

const SECTION_TITLES = {
  incomeStatement: [
    "قائمة الربح",
    "قائمة الدخل",
    "income statement",
    "profit and loss",
  ],
  cashFlow: [
    "قائمة التدفقات النقدية",
    "cash flow statement",
  ],
};

function findSectionStart(text, titles) {
  const norm = normalizeText(text);
  for (const t of titles) {
    const idx = norm.indexOf(normalizeText(t));
    if (idx !== -1) return idx;
  }
  return -1;
}

function sliceSection(text, startIdx) {
  if (startIdx === -1) return "";
  return text.slice(startIdx);
}

/* =========================
   Number Extraction
========================= */

function extractNumberNear(text, keywords) {
  const lines = text.split("\n");

  for (const line of lines) {
    const norm = normalizeText(line);
    for (const k of keywords) {
      if (norm.includes(normalizeText(k))) {
        const numMatch = line.match(/[-(]?\d[\d,\.]*\)?/);
        if (numMatch) {
          let raw = numMatch[0].replace(/,/g, "");
          if (raw.includes("(") && raw.includes(")")) {
            raw = "-" + raw.replace(/[()]/g, "");
          }
          return Number(raw);
        }
      }
    }
  }

  return null;
}

/* =========================
   Azure Function
========================= */

module.exports = async function (context, req) {
  try {
    if ((req.method || "").toUpperCase() === "GET") {
      context.res = {
        status: 200,
        body: { message: "API شغال 🚀" },
      };
      return;
    }

    const { fileBase64, fileName = "uploaded.pdf" } = req.body || {};

    if (!fileBase64) {
      context.res = {
        status: 400,
        body: { ok: false, error: "لم يتم إرسال الملف" },
      };
      return;
    }

    const cleaned = fileBase64.includes("base64,")
      ? fileBase64.split("base64,")[1]
      : fileBase64;

    const buffer = Buffer.from(cleaned, "base64");
    const parsed = await pdfParse(buffer);
    const text = (parsed.text || "").replace(/\r/g, "\n");

    /* ===== Slice Sections ===== */

    const incomeStart = findSectionStart(text, SECTION_TITLES.incomeStatement);
    const cashStart = findSectionStart(text, SECTION_TITLES.cashFlow);

    const incomeText = sliceSection(text, incomeStart);
    const cashText = sliceSection(text, cashStart);

    /* ===== Extract Key Numbers ===== */

    const netIncome = extractNumberNear(incomeText, [
      "صافي الربح",
      "صافي الدخل",
      "net income",
    ]);

    const operatingCashFlow = extractNumberNear(cashText, [
      "صافي النقد من الانشطة التشغيلية",
      "صافي التدفقات النقدية من الانشطة التشغيلية",
      "net cash from operating activities",
    ]);

    /* ===== Earnings Quality ===== */

    let earningsQuality = null;
    if (netIncome && operatingCashFlow) {
      earningsQuality = operatingCashFlow / netIncome;
    }

    context.res = {
      status: 200,
      body: {
        ok: true,
        fileName,
        pages: parsed.numpages,
        extracted: {
          netIncome,
          operatingCashFlow,
          earningsQuality,
        },
      },
    };
  } catch (err) {
    context.res = {
      status: 500,
      body: { ok: false, error: err.message },
    };
  }
};
