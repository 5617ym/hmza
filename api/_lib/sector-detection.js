function collectText(normalized) {
  let parts = [];

  if (!normalized || typeof normalized !== "object") {
    return "";
  }

  if (typeof normalized.fullText === "string") {
    parts.push(normalized.fullText);
  }

  if (typeof normalized.text === "string") {
    parts.push(normalized.text);
  }

  const pages = Array.isArray(normalized.pages) ? normalized.pages : [];

  for (const page of pages) {
    if (typeof page?.text === "string") {
      parts.push(page.text);
    }

    if (Array.isArray(page?.lines)) {
      for (const line of page.lines) {
        if (typeof line?.content === "string") {
          parts.push(line.content);
        }
      }
    }
  }

  return parts.join(" ").toLowerCase();
}

function detectSector(normalized) {
  const text = collectText(normalized);

  let sector = "operating_company";
  let confidence = 0.5;
  let reasons = [];

  // ---------------------------
  // BANK DETECTION
  // ---------------------------

  const bankKeywords = [
    "bank",
    "مصرف",
    "بنك",
    "special commission",
    "customer deposits",
    "financing",
    "murabaha",
    "islamic financing",
    "loans and advances",
    "deposit liabilities",
    "ودائع العملاء",
    "التمويل",
    "المرابحة"
  ];

  const bankHits = bankKeywords.filter(k => text.includes(k));

  if (bankHits.length >= 2) {
    sector = "bank";
    confidence = 0.9;
    reasons.push("bank keywords: " + bankHits.join(", "));
  }

  // ---------------------------
  // INSURANCE DETECTION
  // ---------------------------

  const insuranceKeywords = [
    "insurance",
    "التأمين",
    "insurance revenue",
    "insurance service",
    "claims",
    "policyholder",
    "insurance contract",
    "مطالبات",
    "عقود التأمين"
  ];

  const insuranceHits = insuranceKeywords.filter(k => text.includes(k));

  if (insuranceHits.length >= 2) {
    sector = "insurance";
    confidence = 0.9;
    reasons.push("insurance keywords: " + insuranceHits.join(", "));
  }

  // ---------------------------
  // REIT DETECTION
  // ---------------------------

  const reitKeywords = [
    "reit",
    "real estate investment trust",
    "rental income",
    "property income",
    "investment properties",
    "fund from operations",
    "صندوق استثمار عقاري",
    "إيرادات الإيجار",
    "العقارات الاستثمارية"
  ];

  const reitHits = reitKeywords.filter(k => text.includes(k));

  if (reitHits.length >= 2) {
    sector = "reit";
    confidence = 0.9;
    reasons.push("reit keywords: " + reitHits.join(", "));
  }

  // ---------------------------
  // DEFAULT OPERATING COMPANY
  // ---------------------------

  if (reasons.length === 0) {
    sector = "operating_company";
    confidence = 0.6;
    reasons.push("default operating company");
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
