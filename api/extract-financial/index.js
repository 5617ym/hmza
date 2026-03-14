function statementRankScore(pageCtx, cfg, kind) {
  let score = 0;
  const reasons = [];
  const signals = {};

  if (!pageCtx) {
    return { score, reasons, signals };
  }

  const headerText = getHeaderSearchText(pageCtx);
  const wholeText = getPageStatementText(pageCtx);
  const pageText = normalizeText(
    [pageCtx.text || "", pageCtx.headerText || "", pageCtx.mainTableText || ""].join("\n")
  );

  const firstRowsText = (pageCtx.mainRows || [])
    .slice(0, 6)
    .map((r) => (Array.isArray(r) ? r.join(" | ") : ""))
    .join("\n");

  const titleHitsHeader = countDistinctPhraseHits(
    `${headerText}\n${pageCtx.headerText || ""}\n${pageCtx.mainTableText || ""}`,
    cfg.titles || []
  );

  const titleHitsAll = countDistinctPhraseHits(wholeText, cfg.titles || []);
  const structureHitsAll = countDistinctPhraseHits(wholeText, cfg.structure || []);
  const structureHitsFirstRows = countDistinctPhraseHits(
    `${firstRowsText}\n${pageCtx.mainTableText || ""}`,
    cfg.structure || []
  );
  const negativeHits = countDistinctPhraseHits(wholeText, cfg.negatives || []);

  signals.titleHitsHeader = titleHitsHeader;
  signals.titleHitsAll = titleHitsAll;
  signals.structureHitsAll = structureHitsAll;
  signals.structureHitsFirstRows = structureHitsFirstRows;
  signals.negativeHits = negativeHits;

  const hasNoTitle = titleHitsHeader.length === 0 && titleHitsAll.length === 0;
  const hasNoStructure = structureHitsAll.length === 0 && structureHitsFirstRows.length === 0;
  const structureSupportCount = structureHitsAll.length + structureHitsFirstRows.length;

  // --------------------------------------------------
  // Positive signals
  // --------------------------------------------------

  if (titleHitsHeader.length > 0) {
    const base = titleHitsHeader.length * 90;
    const multiplier = structureHitsAll.length > 0 ? 1 : 0.6;
    const s = Math.round(base * multiplier);
    score += s;
    reasons.push(`titleHeader:+${s}`);
  } else if (titleHitsAll.length > 0) {
    const base = titleHitsAll.length * 40;
    const multiplier = structureHitsAll.length > 0 ? 1 : 0.6;
    const s = Math.round(base * multiplier);
    score += s;
    reasons.push(`titleAll:+${s}`);
  }

  if (structureHitsAll.length > 0) {
    const s = Math.min(structureHitsAll.length, 10) * 16;
    score += s;
    reasons.push(`structureAll:+${s}`);
  }

  if (structureHitsFirstRows.length > 0) {
    const s = Math.min(structureHitsFirstRows.length, 6) * 18;
    score += s;
    reasons.push(`structureFirstRows:+${s}`);
  }

  if (titleHitsHeader.length > 0 && structureSupportCount >= 2) {
    score += 20;
    reasons.push("titleStructureSynergy:+20");
  }

  if (structureSupportCount >= 5 && pageCtx.positionRatio <= 0.35) {
    score += 25;
    reasons.push("strongStructureBonus:+25");
  }

  if (pageCtx.hasYearLikeHeader) {
    const s = structureSupportCount > 0 ? 22 : 10;
    score += s;
    reasons.push(`yearHeader:+${s}`);
  }

  if (pageCtx.years && pageCtx.years.length >= 2) {
    const s = structureSupportCount > 0 ? 14 : 6;
    score += s;
    reasons.push(`yearsDetected:+${s}`);
  } else if (pageCtx.years && pageCtx.years.length === 1) {
    const s = structureSupportCount > 0 ? 5 : 2;
    score += s;
    reasons.push(`singleYearDetected:+${s}`);
  }

  if (pageCtx.numbersCount > 20) {
    const s = structureSupportCount > 0 ? 10 : 4;
    score += s;
    reasons.push(`numbersDensity:+${s}`);
  }

  if (pageCtx.mainRowCount >= 8 && pageCtx.mainRowCount <= 60) {
    const s = structureSupportCount > 0 ? 8 : 3;
    score += s;
    reasons.push(`rowRange:+${s}`);
  }

  if (pageCtx.mainColumnCount >= 3 && pageCtx.mainColumnCount <= 8) {
    const s = structureSupportCount > 0 ? 8 : 3;
    score += s;
    reasons.push(`columnRange:+${s}`);
  }

  if (pageCtx.positionRatio <= 0.30) {
    const s = structureSupportCount > 0 ? 8 : 3;
    score += s;
    reasons.push(`earlyPage:+${s}`);
  } else if (pageCtx.positionRatio >= 0.35) {
    score -= 180;
    reasons.push("latePagePenalty:-180");
  }

  // --------------------------------------------------
  // General penalties
  // --------------------------------------------------

  if (pageCtx.isLikelyIndexPage) {
    score -= 220;
    reasons.push("indexPenalty:-220");
  }

  if (pageCtx.isLikelyStandardsPage) {
    score -= 190;
    reasons.push("standardsPenalty:-190");
  }

  if (pageCtx.isLikelyNarrativePage) {
    score -= 170;
    reasons.push("narrativePenalty:-170");
  }

  if (kind === "income" && pageCtx.isLikelyComprehensiveIncome) {
    score -= 140;
    reasons.push("comprehensiveIncomePenalty:-140");
  }

  if (kind !== "income" && pageCtx.isLikelyComprehensiveIncome) {
    score -= 60;
    reasons.push("crossStatementComprehensivePenalty:-60");
  }

  if (pageCtx.isLikelyEquityStatement) {
    score -= 120;
    reasons.push("equityStatementPenalty:-120");
  }

  if (negativeHits.length > 0) {
    const s = Math.min(negativeHits.length, 8) * 22;
    score -= s;
    reasons.push(`negativeHits:-${s}`);
  }

  // --------------------------------------------------
  // Missing title / structure penalties
  // --------------------------------------------------

  if (hasNoTitle) {
    const penalty = kind === "balance" ? 90 : 170;
    score -= penalty;
    reasons.push(`noTitlePenalty:-${penalty}`);
  }

  if (hasNoTitle && hasNoStructure) {
    const penalty = kind === "balance" ? 140 : 260;
    score -= penalty;
    reasons.push(`noTitleNoStructure:-${penalty}`);
  }

  // صفحة بعنوان فقط بدون structure في cashflow غالبًا ليست القائمة الفعلية
  if (kind === "cashflow" && !hasNoTitle && hasNoStructure) {
    score -= 120;
    reasons.push("cashflowTitleWithoutStructurePenalty:-120");
  }

  // fallback محدود فقط للتدفقات النقدية عندما OCR ضعيف
  if (
    kind === "cashflow" &&
    hasNoTitle &&
    hasNoStructure &&
    pageCtx.mainColumnCount === 3 &&
    pageCtx.mainRowCount >= 40 &&
    (pageCtx.years || []).length >= 2
  ) {
    score += 40;
    reasons.push("cashflowTall3ColFallbackBonus:+40");
  }

  // --------------------------------------------------
  // Audit / auditor narrative penalty
  // --------------------------------------------------

  const auditNarrativeHits =
    pageText.includes("امر المراجعه") ||
    pageText.includes("امور المراجعه") ||
    pageText.includes("كيفيه معالجه هذا الامر اثناء مراجعتنا") ||
    pageText.includes("المراجع") ||
    pageText.includes("تقرير المراجع") ||
    pageText.includes("key audit") ||
    pageText.includes("key audit matters") ||
    pageText.includes("auditor") ||
    pageText.includes("independent auditor");

  if (auditNarrativeHits) {
    score -= 220;
    reasons.push("auditNarrativePenalty:-220");
  }

  return {
    score,
    reasons,
    signals
  };
}
