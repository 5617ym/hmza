function normalizeArabic(text) {
  return String(text || "")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

function normalizeText(text) {
  return normalizeArabic(String(text || ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function flattenStringsDeep(value, out = []) {
  if (value == null) return out;

  if (typeof value === "string") {
    out.push(value);
    return out;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      flattenStringsDeep(item, out);
    }
    return out;
  }

  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      flattenStringsDeep(value[key], out);
    }
    return out;
  }

  return out;
}

function collectText(normalized) {
  if (!normalized || typeof normalized !== "object") return "";

  const parts = [];

  // أهم الحقول المباشرة
  if (typeof normalized.fullText === "string") parts.push(normalized.fullText);
  if (typeof normalized.text === "string") parts.push(normalized.text);
  if (typeof normalized.content === "string") parts.push(normalized.content);

  if (normalized.meta && typeof normalized.meta.fileName === "string") {
    parts.push(normalized.meta.fileName);
  }

  // pages / tables / previews / أي نصوص داخل الكائن كاملًا
  flattenStringsDeep(normalized, parts);

  return normalizeText(parts.join(" "));
}

function scoreHits(text, keywords) {
  const hits = [];

  for (const keyword of keywords) {
    const k = normalizeText(keyword);
    if (k && text.includes(k)) {
      hits.push(keyword);
    }
  }

  return hits;
}

function detectSector(normalized) {
  const text = collectText(normalized);

  const bankKeywords = [
    "bank",
    "banks",
    "مصرف",
    "بنك",
    "special commission",
    "special commission income",
    "special commission expense",
    "net special commission income",
    "customer deposits",
    "deposit liabilities",
    "financing",
    "financing and advances",
    "loans and advances",
    "murabaha",
    "islamic financing",
    "ودائع العملاء",
    "التمويل",
    "تمويل",
    "المرابحة",
    "دخل العمولات الخاصة",
    "ايرادات العمولات الخاصة",
    "صافي دخل العمولات الخاصة",
    "البنك المركزي",
    "البنوك المركزية"
  ];

  const insuranceKeywords = [
    "insurance",
    "التامين",
    "التأمين",
    "insurance revenue",
    "insurance service",
    "insurance contract",
    "policyholder",
    "claims",
    "مطالبات",
    "عقود التامين",
    "عقود التأمين",
    "خدمة التامين",
    "خدمة التأمين"
  ];

  const reitKeywords = [
    "reit",
    "real estate investment trust",
    "rental income",
    "property income",
    "investment properties",
    "fund from operations",
    "funds from operations",
    "صندوق استثمار عقاري",
    "ايرادات الايجار",
    "إيرادات الإيجار",
    "العقارات الاستثمارية"
  ];

  const operatingKeywords = [
    "revenue",
    "sales",
    "cost of sales",
    "gross profit",
    "operating profit",
    "operating income",
    "الايرادات",
    "الإيرادات",
    "المبيعات",
    "تكلفه المبيعات",
    "تكلفة المبيعات",
    "اجمالي الربح",
    "إجمالي الربح",
    "الربح التشغيلي"
  ];

  const bankHits = scoreHits(text, bankKeywords);
  const insuranceHits = scoreHits(text, insuranceKeywords);
  const reitHits = scoreHits(text, reitKeywords);
  const operatingHits = scoreHits(text, operatingKeywords);

  let sector = "operating_company";
  let confidence = 0.6;
  let reasons = ["default operating company"];

  // أولوية البنك ثم التأمين ثم الريت
  if (bankHits.length >= 3) {
    sector = "bank";
    confidence = bankHits.length >= 4 ? 0.95 : 0.9;
    reasons = [`bank keywords: ${bankHits.slice(0, 6).join(", ")}`];
  } else if (insuranceHits.length >= 2) {
    sector = "insurance";
    confidence = insuranceHits.length >= 4 ? 0.95 : 0.9;
    reasons = [`insurance keywords: ${insuranceHits.slice(0, 6).join(", ")}`];
  } else if (reitHits.length >= 2) {
    sector = "reit";
    confidence = reitHits.length >= 4 ? 0.95 : 0.9;
    reasons = [`reit keywords: ${reitHits.slice(0, 6).join(", ")}`];
  } else if (operatingHits.length >= 2) {
    sector = "operating_company";
    confidence = 0.75;
    reasons = [`operating keywords: ${operatingHits.slice(0, 6).join(", ")}`];
  }

  return {
    sector,
    confidence,
    reasons
  };
}

module.exports = {
  detectSector
};
