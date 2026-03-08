// api/extract-financial/index.js
module.exports = async function (context, req) {
  const send = (status, payload) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: payload
    };
  };

  try {
    const body = req.body || {};
    const normalized = body.normalized;
    const normalizedPrev = body.normalizedPrev || null;

    if (!normalized) {
      return send(400, { ok: false, error: "Missing normalized" });
    }

    const tablesPreview = Array.isArray(normalized.tablesPreview)
      ? normalized.tablesPreview
      : [];

    const pagesMeta = normalized.meta || null;

    /* =========================
       Helpers
       ========================= */

    const toLatinDigits = (s) => {
      const map = {
        "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
        "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9"
      };
      return String(s || "").replace(/[٠-٩]/g, (d) => map[d] || d);
    };

    const normalizeSeparators = (s) => {
      return String(s || "")
        .replace(/٫/g, ".")
        .replace(/[٬،]/g, ",");
    };

    const norm = (s) =>
      toLatinDigits(normalizeSeparators(String(s || "")))
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    const stripNonTextNoise = (s) => {
      return norm(s)
        .replace(/[|ـ\-–—_:;]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    };

    const parseNumberSmart = (raw) => {
      if (raw === null || raw === undefined) return null;

      let s = toLatinDigits(normalizeSeparators(String(raw))).trim();
      if (!s) return null;

      let neg = false;

      if (s.includes("(") && s.includes(")")) {
        neg = true;
        s = s.replace(/[()]/g, "");
      }

      s = s.replace(/[^\d.,\-+]/g, "");
      if (!s) return null;

      const hasDot = s.includes(".");
      const hasComma = s.includes(",");

      const isGroupedThousands = /^\d{1,3}([.,]\d{3})+$/;

      if (isGroupedThousands.test(s)) {
        const n = Number(s.replace(/[.,]/g, ""));
        return Number.isFinite(n) ? (neg ? -n : n) : null;
      }

      if (hasDot && hasComma) {
        const n = Number(s.replace(/,/g, ""));
        return Number.isFinite(n) ? (neg ? -n : n) : null;
      }

      if (!hasDot && hasComma) {
        if (/^\d{1,3}(,\d{3})+$/.test(s)) {
          const n = Number(s.replace(/,/g, ""));
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        }
      }

      const n = Number(s);
      return Number.isFinite(n) ? (neg ? -n : n) : null;
    };

    const findYear = (text) => {
      const s = toLatinDigits(String(text || ""));
      const m = s.match(/\b(20\d{2})\b/);
      return m ? Number(m[1]) : null;
    };

    const mergeTableRows = (table) => {
      return [
        ...(Array.isArray(table?.sample) ? table.sample : []),
        ...(Array.isArray(table?.sampleTail) ? table.sampleTail : [])
      ];
    };

    const tableTextBlob = (table) => {
      return norm(JSON.stringify(mergeTableRows(table)));
    };

    const countNumericCellsInTable = (table) => {
      const rows = mergeTableRows(table);
      let count = 0;

      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          if (parseNumberSmart(cell) !== null) count++;
        }
      }

      return count;
    };

    const countRowsWithAtLeastTwoNumericCells = (table) => {
      const rows = mergeTableRows(table);
      let count = 0;

      for (const row of rows) {
        if (!Array.isArray(row)) continue;

        let numericInRow = 0;
        for (const cell of row) {
          if (parseNumberSmart(cell) !== null) numericInRow++;
        }

        if (numericInRow >= 2) count++;
      }

      return count;
    };

    const detectColumns = (table) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];
      const colCount = Number(table?.columnCount) || 0;
      const cols = [];

      for (let i = 0; i < colCount; i++) {
        const c = {
          col: i,
          years: [],
          hasNote: false,
          numericDensity: 0
        };

        for (let r = 0; r < Math.min(20, rows.length); r++) {
          const cell = norm(rows?.[r]?.[i]);
          const y = findYear(cell);

          if (y) c.years.push(y);

          if (
            cell.includes("إيضاح") ||
            cell.includes("ايضاح") ||
            cell.includes("note")
          ) {
            c.hasNote = true;
          }
        }

        c.years = [...new Set(c.years)];

        let numericCount = 0;
        for (let r = 0; r < rows.length; r++) {
          if (parseNumberSmart(rows?.[r]?.[i]) !== null) {
            numericCount++;
          }
        }

        c.numericDensity = numericCount / Math.max(rows.length, 1);
        cols.push(c);
      }

      return cols;
    };

    const pickLatestColumns = (cols) => {
      if (!Array.isArray(cols) || !cols.length) {
        return { latest: null, previous: null, latestYear: null, previousYear: null };
      }

      const numericCols = cols
        .filter((c) => !c.hasNote && (c.numericDensity || 0) > 0.2)
        .sort((a, b) => a.col - b.col);

      if (numericCols.length >= 2) {
        return {
          latest: numericCols[numericCols.length - 1],
          previous: numericCols[numericCols.length - 2],
          latestYear: null,
          previousYear: null
        };
      }

      const usable = cols.filter((c) => !c.hasNote);
      const years = [];

      usable.forEach((c) => c.years.forEach((y) => years.push(y)));

      if (!years.length) {
        return { latest: null, previous: null, latestYear: null, previousYear: null };
      }

      const uniqueYears = [...new Set(years)].sort((a, b) => b - a);
      const maxYear = uniqueYears[0];
      const prevYear = uniqueYears[1] || null;

      const latest = usable.find((c) => c.years.includes(maxYear)) || null;
      const previous = prevYear
        ? usable.find((c) => c.years.includes(prevYear)) || null
        : null;

      return {
        latest,
        previous,
        latestYear: maxYear,
        previousYear: prevYear
      };
    };

    const isLikelyNotesTable = (table) => {
      const text = tableTextBlob(table);

      const badWords = [
        "السياسة المحاسبية",
        "مراجعتنا",
        "الإيضاحات",
        "الإيضاح",
        "كيف",
        "المخاطر",
        "ضوابط",
        "منهجية",
        "expected credit loss",
        "policy",
        "note",
        "notes",
        "audit",
        "review"
      ];

      const hitCount = badWords.reduce(
        (acc, w) => acc + (text.includes(norm(w)) ? 1 : 0),
        0
      );

      return hitCount >= 2;
    };

    const isLikelyIndexTable = (table) => {
      const text = tableTextBlob(table);
      const rows = mergeTableRows(table);

      const titleHits = [
        "قائمة المركز المالي الموحدة",
        "قائمة الدخل الموحدة",
        "قائمة الدخل الشامل الموحدة",
        "قائمة التغيرات في حقوق الملكية الموحدة",
        "قائمة التدفقات النقدية الموحدة",
        "تقرير مراجعي الحسابات المستقلين"
      ].reduce((acc, x) => acc + (text.includes(norm(x)) ? 1 : 0), 0);

      let statementTitleRows = 0;
      let pageRefRows = 0;

      for (const row of rows) {
        if (!Array.isArray(row)) continue;

        const joined = stripNonTextNoise(row.join(" "));

        if (
          joined.includes("قائمة المركز المالي") ||
          joined.includes("قائمة الدخل") ||
          joined.includes("قائمة الدخل الشامل") ||
          joined.includes("قائمة التدفقات النقدية") ||
          joined.includes("قائمة التغيرات")
        ) {
          statementTitleRows++;
        }

        const numericCells = row.filter((c) => parseNumberSmart(c) !== null).length;
        const textCells = row.filter((c) => {
          const s = String(c || "").trim();
          return s && parseNumberSmart(s) === null;
        }).length;

        if (numericCells === 1 && textCells >= 1) {
          pageRefRows++;
        }
      }

      const numericRows = countRowsWithAtLeastTwoNumericCells(table);
      const numericCells = countNumericCellsInTable(table);

      if (titleHits >= 3 && numericRows <= 3) return true;
      if (statementTitleRows >= 3 && pageRefRows >= 3 && numericRows <= 3) return true;
      if (
        text.includes("تقرير مراجعي الحسابات المستقلين") &&
        titleHits >= 2 &&
        numericCells < 20
      ) {
        return true;
      }

      return false;
    };

    const earlyPageBoost = (pageNumber, bucket = "default") => {
      const p = Number(pageNumber) || 9999;
      let score = 0;

      if (bucket === "cash") {
        if (p <= 20) score += 30;
        else if (p <= 35) score += 10;
        else if (p >= 80) score -= 15;
        return score;
      }

      if (p <= 12) score += 50;
      else if (p <= 20) score += 30;
      else if (p <= 35) score += 10;
      else if (p >= 80) score -= 25;

      return score;
    };

    const detectStatementProfile = (tables) => {
      let bankScore = 0;
      let operatingScore = 0;

      for (const t of tables) {
        const text = tableTextBlob(t);

        if (
          text.includes("مصرف") ||
          text.includes("بنك") ||
          text.includes("البنك المركزي") ||
          text.includes("ودائع العملاء") ||
          text.includes("الدخل من الاستثمارات والتمويل") ||
          text.includes("دخل رسوم خدمات مصرفية") ||
          text.includes("إجمالي دخل العمليات") ||
          text.includes("صكوك") ||
          text.includes("شهادات إيداع") ||
          text.includes("تمويل، صافي") ||
          text.includes("تمويل صافي") ||
          text.includes("تمويل وسلف") ||
          text.includes("استثمارات بالصافي")
        ) {
          bankScore += 8;
        }

        if (
          text.includes("الإيرادات") ||
          text.includes("الايرادات") ||
          text.includes("تكلفة الإيرادات") ||
          text.includes("تكلفة الايرادات") ||
          text.includes("مجمل الربح") ||
          text.includes("الربح التشغيلي")
        ) {
          operatingScore += 6;
        }
      }

      return bankScore >= operatingScore ? "bank" : "operating_company";
    };

    /* =========================
       Empty schemas
       ========================= */

    const makeEmptyOperatingIncome = () => ({
      revenue: null,
      costOfRevenue: null,
      grossProfit: null,
      operatingProfit: null
    });

    const makeEmptyBankIncome = () => ({
      incomeFromInvestmentsAndFinancing: null,
      returnsOnInvestmentsHeldForTradingOrFV: null,
      netIncomeFromInvestmentsAndFinancing: null,
      feeIncomeGross: null,
      feeExpense: null,
      feeIncomeNet: null,
      totalOperatingIncome: null,
      salariesAndEmployeeBenefits: null,
      depreciationAndAmortization: null,
      otherOperatingExpenses: null,
      operatingExpensesBeforeImpairment: null,
      netImpairmentChargeForFinancing: null,
      totalOperatingExpenses: null,
      netOperatingIncome: null,
      shareOfResultsAssociates: null,
      netIncomeBeforeZakat: null,
      zakat: null,
      netIncomeAfterZakat: null
    });

    const makeEmptyOperatingBalance = () => ({
      currentAssets: null,
      nonCurrentAssets: null,
      totalAssets: null,
      currentLiabilities: null,
      nonCurrentLiabilities: null,
      totalLiabilities: null,
      totalEquity: null
    });

    const makeEmptyBankBalance = () => ({
      cashAndBalancesWithCentralBank: null,
      balancesWithBanksAndFinancialInstitutions: null,
      investmentsAtFVTPL: null,
      investmentsAtFVOCI: null,
      investmentsAtAmortizedCost: null,
      investmentsInAssociates: null,
      derivativeAssets: null,
      financingNet: null,
      propertyAndEquipment: null,
      otherAssets: null,
      totalAssets: null,
      balancesDueToCentralBankAndBanks: null,
      customerDeposits: null,
      debtSecuritiesIssued: null,
      derivativeLiabilities: null,
      leaseLiabilities: null,
      otherLiabilities: null,
      totalLiabilities: null,
      shareCapital: null,
      treasuryShares: null,
      statutoryReserve: null,
      otherReserves: null,
      retainedEarnings: null,
      equityAttributableToShareholders: null,
      tier1Sukuk: null,
      totalEquity: null
    });

    const makeEmptyCashFlow = () => ({
      endingCash: null,
      beginningCash: null,
      netChangeInCash: {
        label: "صافي التغير في النقد",
        current: null,
        previous: null
      }
    });

    /* =========================
       Table scoring
       ========================= */

    const scoreIncomeTable = (table, statementProfile) => {
      const text = tableTextBlob(table);
      const numericRows = countRowsWithAtLeastTwoNumericCells(table);
      const numericCells = countNumericCellsInTable(table);

      if (isLikelyNotesTable(table)) return -100;
      if (isLikelyIndexTable(table)) return -150;

      let score = 0;

      if (statementProfile === "bank") {
        if (text.includes("قائمة الدخل")) score += 12;
        if (text.includes("قائمة الدخل الموحدة")) score += 16;
        if (text.includes("الدخل من الاستثمارات والتمويل")) score += 20;
        if (text.includes("صافي الدخل من الاستثمارات والتمويل")) score += 18;
        if (text.includes("استثمار، صافي") || text.includes("استثمارات بالصافي")) score += 18;
        if (text.includes("دخل رسوم خدمات مصرفية")) score += 14;
        if (text.includes("إجمالي دخل العمليات")) score += 22;
        if (text.includes("مصاريف العمليات قبل مخصصات الانخفاض")) score += 18;
        if (text.includes("مخصص الانخفاض في قيمة التمويل")) score += 18;
        if (text.includes("مخصص خسائر الائتمان")) score += 18;
        if (text.includes("صافي دخل العمليات")) score += 18;
        if (text.includes("دخل السنة قبل الزكاة")) score += 20;
        if (text.includes("صافي دخل السنة بعد الزكاة")) score += 22;
        if (text.includes("مصرف") || text.includes("بنك")) score += 4;
        if (text.includes("التدفقات النقدية")) score -= 10;
        if (text.includes("المركز المالي")) score -= 10;
      } else {
        if (text.includes("الإيرادات") || text.includes("الايرادات")) score += 8;
        if (text.includes("تكلفة الإيرادات") || text.includes("تكلفة الايرادات")) score += 6;
        if (text.includes("مجمل الربح")) score += 6;
        if (text.includes("الربح التشغيلي")) score += 6;
        if (text.includes("قائمة الدخل")) score += 4;
        if (text.includes("الربح")) score += 2;
        if (text.includes("الموجودات") || text.includes("الأصول")) score -= 4;
        if (text.includes("التدفقات النقدية")) score -= 4;
      }

      score += earlyPageBoost(table?.pageNumber, "income");

      if (Number(table?.rowCount) >= 10) score += 2;
      if (Number(table?.columnCount) >= 3) score += 2;

      if (numericRows >= 6) score += 12;
      if (numericCells >= 20) score += 8;

      if (numericRows <= 2) score -= 40;
      if (numericCells <= 10) score -= 25;

      return score;
    };

    const scoreBalanceTable = (table, statementProfile) => {
      const text = tableTextBlob(table);
      const numericRows = countRowsWithAtLeastTwoNumericCells(table);
      const numericCells = countNumericCellsInTable(table);

      if (isLikelyNotesTable(table)) return -100;
      if (isLikelyIndexTable(table)) return -150;

      let score = 0;

      if (statementProfile === "bank") {
        if (text.includes("قائمة المركز المالي")) score += 16;
        if (text.includes("قائمة المركز المالي الموحدة")) score += 20;
        if (text.includes("الموجودات")) score += 8;
        if (text.includes("المطلوبات وحقوق الملكية")) score += 14;
        if (text.includes("نقد وأرصدة لدى البنك المركزي السعودي")) score += 18;
        if (text.includes("نقد وأرصدة لدى البنوك المركزية")) score += 18;
        if (text.includes("أرصدة لدى البنوك والمؤسسات المالية الأخرى")) score += 14;
        if (text.includes("مطالبات من البنوك والمؤسسات المالية الأخرى")) score += 14;
        if (text.includes("استثمارات بالقيمة العادلة")) score += 12;
        if (text.includes("استثمارات بالتكلفة")) score += 10;
        if (text.includes("استثمارات بالصافي")) score += 12;
        if (text.includes("تمويل، صافي") || text.includes("تمويل صافي") || text.includes("تمويل وسلف")) score += 20;
        if (text.includes("ودائع العملاء")) score += 22;
        if (text.includes("صكوك وشهادات إيداع مصدرة")) score += 18;
        if (text.includes("صكوك وسندات دين مصدرة")) score += 18;
        if (text.includes("إجمالي الموجودات")) score += 18;
        if (text.includes("إجمالي المطلوبات")) score += 18;
        if (text.includes("إجمالي حقوق الملكية")) score += 18;
        if (text.includes("الإيرادات") || text.includes("مجمل الربح")) score -= 8;
        if (text.includes("التدفقات النقدية")) score -= 10;
      } else {
        if (text.includes("الموجودات")) score += 7;
        if (text.includes("الأصول")) score += 7;
        if (text.includes("المطلوبات")) score += 7;
        if (text.includes("حقوق الملكية")) score += 7;
        if (text.includes("إجمالي الموجودات") || text.includes("إجمالي الأصول")) score += 8;
        if (text.includes("إجمالي المطلوبات")) score += 8;
        if (text.includes("إجمالي حقوق الملكية")) score += 8;
        if (text.includes("قائمة المركز المالي") || text.includes("المركز المالي")) score += 5;
        if (text.includes("الإيرادات") || text.includes("مجمل الربح")) score -= 6;
        if (text.includes("التدفقات النقدية")) score -= 6;
      }

      score += earlyPageBoost(table?.pageNumber, "balance");

      if (Number(table?.rowCount) >= 10) score += 2;
      if (Number(table?.columnCount) >= 3) score += 2;

      if (numericRows >= 6) score += 12;
      if (numericCells >= 20) score += 8;

      if (numericRows <= 2) score -= 40;
      if (numericCells <= 10) score -= 25;

      return score;
    };

    const scoreCashFlowTable = (table) => {
      const text = tableTextBlob(table);
      const numericRows = countRowsWithAtLeastTwoNumericCells(table);
      const numericCells = countNumericCellsInTable(table);

      if (isLikelyNotesTable(table)) return -100;
      if (isLikelyIndexTable(table)) return -150;

      let score = 0;

      if (text.includes("التدفقات النقدية")) score += 16;
      if (text.includes("قائمة التدفقات النقدية")) score += 20;
      if (text.includes("cash flow")) score += 12;
      if (text.includes("النقد وما في حكمه")) score += 12;
      if (text.includes("النقد والنقد المعادل")) score += 12;
      if (text.includes("صافي التغير")) score += 10;
      if (text.includes("net change")) score += 8;

      if (Number(table?.columnCount) >= 2 && Number(table?.columnCount) <= 5) score += 3;
      if (Number(table?.rowCount) >= 12) score += 4;

      score += earlyPageBoost(table?.pageNumber, "cash");

      if (text.includes("الإيرادات") || text.includes("مجمل الربح")) score -= 5;
      if (text.includes("الموجودات") || text.includes("حقوق الملكية")) score -= 5;

      if (numericRows >= 6) score += 12;
      if (numericCells >= 20) score += 8;

      if (numericRows <= 2) score -= 40;
      if (numericCells <= 10) score -= 25;

      return score;
    };

    const pickBestTable = (tables, scorer) => {
      let best = null;
      let bestScore = -Infinity;

      for (const t of tables) {
        const score = scorer(t);
        if (score > bestScore) {
          best = t;
          bestScore = score;
        }
      }

      return bestScore > 0 ? best : null;
    };

    /* =========================
       Phase V2: selection only
       ========================= */

    const statementProfile = detectStatementProfile(tablesPreview);

    const incomeTable = pickBestTable(
      tablesPreview,
      (t) => scoreIncomeTable(t, statementProfile)
    );

    const balanceTable = pickBestTable(
      tablesPreview,
      (t) => scoreBalanceTable(t, statementProfile)
    );

    const cashTable = pickBestTable(
      tablesPreview,
      (t) => scoreCashFlowTable(t)
    );

    const incomeYears = incomeTable
      ? {
          current: pickLatestColumns(detectColumns(incomeTable)).latestYear ?? null,
          previous: pickLatestColumns(detectColumns(incomeTable)).previousYear ?? null
        }
      : { current: null, previous: null };

    const balanceYears = balanceTable
      ? {
          current: pickLatestColumns(detectColumns(balanceTable)).latestYear ?? null,
          previous: pickLatestColumns(detectColumns(balanceTable)).previousYear ?? null
        }
      : { current: null, previous: null };

    const cashFlowYears = cashTable
      ? {
          current: pickLatestColumns(detectColumns(cashTable)).latestYear ?? null,
          previous: pickLatestColumns(detectColumns(cashTable)).previousYear ?? null
        }
      : { current: null, previous: null };

    const incomeExtract =
      statementProfile === "bank"
        ? makeEmptyBankIncome()
        : makeEmptyOperatingIncome();

    const balanceExtract =
      statementProfile === "bank"
        ? makeEmptyBankBalance()
        : makeEmptyOperatingBalance();

    const cashFlowExtract = makeEmptyCashFlow();

    const checks = {
      accountingEquation: {
        current: null,
        previous: null
      },
      cashFlowEquation: {
        current: null,
        previous: null
      },
      completeness:
        statementProfile === "bank"
          ? {
              incomeStatementLite: {
                hasIncomeFromInvestmentsAndFinancing: false,
                hasTotalOperatingIncome: false,
                hasNetOperatingIncome: false,
                hasNetIncomeBeforeZakat: false,
                hasNetIncomeAfterZakat: false
              },
              balanceSheetLite: {
                hasCashAndBalancesWithCentralBank: false,
                hasFinancingNet: false,
                hasCustomerDeposits: false,
                hasTotalAssets: false,
                hasTotalLiabilities: false,
                hasTotalEquity: false
              },
              cashFlowLite: {
                hasEndingCash: false,
                hasBeginningCash: false,
                hasNetChangeInCash: false
              }
            }
          : {
              incomeStatementLite: {
                hasRevenue: false,
                hasCostOfRevenue: false,
                hasGrossProfit: false,
                hasOperatingProfit: false
              },
              balanceSheetLite: {
                hasTotalAssets: false,
                hasCurrentAssets: false,
                hasNonCurrentAssets: false,
                hasTotalLiabilities: false,
                hasCurrentLiabilities: false,
                hasNonCurrentLiabilities: false,
                hasTotalEquity: false
              },
              cashFlowLite: {
                hasEndingCash: false,
                hasBeginningCash: false,
                hasNetChangeInCash: false
              }
            }
    };

    const derived = {
      detectedYears: {
        incomeStatement: incomeYears,
        balanceSheet: balanceYears,
        cashFlow: cashFlowYears
      },
      growth: {}
    };

    const ratios =
      statementProfile === "bank"
        ? { banking: {} }
        : {
            profitability: {},
            liquidity: {},
            leverage: {}
          };

    const signals = {
      profitability: null,
      liquidity: null,
      leverage: null,
      growth: null
    };

    const insights = {
      profitability: [],
      liquidity: [],
      leverage: [],
      growth: [],
      summary: []
    };

    const executiveSummary = [];
    const evaluation = {
      strengths: [],
      watchPoints: [],
      opportunities: [],
      risks: []
    };

    const investmentView = {
      businessQuality: { signal: null, points: [] },
      financialStability: { signal: null, points: [] },
      growthOutlook: { signal: null, points: [] },
      cashQuality: { signal: null, points: [] },
      overallView: [],
      investmentView: null
    };

    pushUnique(insights.summary, "هذه نسخة V2 مخصصة لاختيار الجداول أولًا قبل تفعيل الاستخراج التفصيلي.");
    pushUnique(executiveSummary, "تم تنفيذ مرحلة اختيار الجداول فقط في هذه النسخة.");

    const extractionStatus = {
      incomeStatementLite: false,
      balanceSheetLite: false,
      cashFlowLite: false
    };

    const statements = {
      incomeStatementLite: incomeExtract,
      balanceSheetLite: balanceExtract,
      cashFlowLite: cashFlowExtract
    };

    const meta = {
      source: {
        hasNormalized: !!normalized,
        hasNormalizedPrev: !!normalizedPrev,
        tablesPreviewCount: tablesPreview.length
      },
      pagesMeta,
      statementProfile,
      extractionStatus,
      selectedTables: {
        incomePage: incomeTable?.pageNumber ?? null,
        balancePage: balanceTable?.pageNumber ?? null,
        cashFlowPage: cashTable?.pageNumber ?? null
      },
      summary: {
        currentYearDetected:
          incomeYears.current !== null ||
          balanceYears.current !== null ||
          cashFlowYears.current !== null,
        previousYearDetected:
          incomeYears.previous !== null ||
          balanceYears.previous !== null ||
          cashFlowYears.previous !== null
      }
    };

    return send(200, {
      ok: true,
      financial: {
        pagesMeta,
        statementProfile,
        incomeStatementLite: incomeExtract,
        balanceSheetLite: balanceExtract,
        cashFlowLite: cashFlowExtract,
        statements,
        checks,
        meta,
        derived,
        ratios,
        signals,
        insights,
        executiveSummary,
        evaluation,
        investmentView
      }
    });
  } catch (e) {
    return send(500, {
      ok: false,
      error: e.message || String(e)
    });
  }
};
