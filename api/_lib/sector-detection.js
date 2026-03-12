function detectSector(normalized) {
  const text = (normalized?.fullText || "").toLowerCase();

  let sector = "operating_company";
  let confidence = 0.5;
  let reasons = [];

  if (
    text.includes("bank") ||
    text.includes("مصرف") ||
    text.includes("special commission") ||
    text.includes("customer deposits")
  ) {
    sector = "bank";
    confidence = 0.9;
    reasons.push("bank keywords detected");
  }

  else if (
    text.includes("insurance") ||
    text.includes("التأمين") ||
    text.includes("insurance revenue")
  ) {
    sector = "insurance";
    confidence = 0.9;
    reasons.push("insurance keywords detected");
  }

  else if (
    text.includes("reit") ||
    text.includes("real estate investment trust") ||
    text.includes("rental income")
  ) {
    sector = "reit";
    confidence = 0.9;
    reasons.push("reit keywords detected");
  }

  else {
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
