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

      return String(s || "").replace(/[٠-٩]/g, d => map[d] || d);
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

    const detectColumns = (table) => {
      const rows = table.sample || [];
      const colCount = Number(table.columnCount) || 0;
      const cols = [];

      for (let i = 0; i < colCount; i++) {
        const c = {
          col: i,
          years: [],
          hasNote: false
        };

        for (let r = 0; r < Math.min(6, rows.length); r++) {
          const cell = norm(rows?.[r]?.[i]);
          const y = findYear(cell);

          if (y) c.years.push(y);

          if (cell.includes("إيضاح") || cell.includes("ايضاح") || cell.includes("note")) {
            c.hasNote = true;
          }
        }

        c.years = [...new Set(c.years)];
        cols.push(c);
      }

      return cols;
    };

    const pickLatestColumns = (cols) => {
      const usable = cols.filter(c => !c.hasNote);
      const years = [];

      usable.forEach(c => c.years.forEach(y => years.push(y)));

      if (!years.length) {
        return { latest: null, previous: null, latestYear: null, previousYear: null };
      }

      const uniqueYears = [...new Set(years)].sort((a, b) => b - a);
      const maxYear = uniqueYears[0];
      const prevYear = uniqueYears[1] || null;

      const latest = usable.find(c => c.years.includes(maxYear)) || null;
      const previous = prevYear
        ? (usable.find(c => c.years.includes(prevYear)) || null)
        : null;

      return {
        latest,
        previous,
        latestYear: maxYear,
        previousYear: prevYear
      };
    };

    const getCell = (row, index) => {
      if (!Array.isArray(row)) return "";
      if (index === null || index === undefined) return "";
      return row[index];
    };

    const getRowLabelFromRow = (row) => {
      if (!Array.isArray(row) || !row.length) return "";

      const candidates = [];

      for (let i = row.length - 1; i >= 0; i--) {
        const raw = String(row[i] || "").trim();
        const asNumber = parseNumberSmart(raw);

        if (raw && asNumber === null) {
          candidates.push(raw);
        }
      }

      return stripNonTextNoise(candidates[0] || "");
    };

    const rowHasNumericValueAt = (row, colIndex) => {
      if (!Array.isArray(row)) return false;
      if (colIndex === null || colIndex === undefined) return false;
      return parseNumberSmart(row[colIndex]) !== null;
    };

        const findRowByLabel = (rows, names) => {
      for (const r of rows) {
        const label = getRowLabelFromRow(r);
        if (!label) continue;

        for (const n of names) {
          if (label.includes(norm(n))) {
            return r;
          }
        }
      }
      return null;
    };

    const findExactBalanceSheetMatch = (rows, names, latestCol, usedRowIndexes = new Set()) => {
      for (let i = 0; i < rows.length; i++) {
        if (usedRowIndexes.has(i)) continue;

        const row = rows[i];
        const label = getRowLabelFromRow(row);

        if (!label) continue;
        if (!rowHasNumericValueAt(row, latestCol)) continue;

        const s = stripNonTextNoise(label);
        if (names.some(n => s === norm(n))) {
          return { row, index: i };
        }
      }

      return { row: null, index: -1 };
    };

    const findContainsBalanceSheetMatch = (rows, names, latestCol, usedRowIndexes = new Set()) => {
      for (let i = 0; i < rows.length; i++) {
        if (usedRowIndexes.has(i)) continue;

        const row = rows[i];
        const label = getRowLabelFromRow(row);

        if (!label) continue;
        if (!rowHasNumericValueAt(row, latestCol)) continue;

        const s = stripNonTextNoise(label);
        if (names.some(n => s.includes(norm(n)))) {
          return { row, index: i };
        }
      }

      return { row: null, index: -1 };
    };

    const findExactRowMatch = (rows, names, latestCol) => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const label = getRowLabelFromRow(row);

        if (!label) continue;
        if (!rowHasNumericValueAt(row, latestCol)) continue;

        const s = stripNonTextNoise(label);
        if (names.some(n => s === norm(n))) {
          return { row, index: i };
        }
      }

      return { row: null, index: -1 };
    };

    const findContainsRowMatch = (rows, names, latestCol) => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const label = getRowLabelFromRow(row);

        if (!label) continue;
        if (!rowHasNumericValueAt(row, latestCol)) continue;

        const s = stripNonTextNoise(label);
        if (names.some(n => s.includes(norm(n)))) {
          return { row, index: i };
        }
      }

      return { row: null, index: -1 };
    };

    const tableTextBlob = (table) => {
      return norm(JSON.stringify([
        ...(table.sample || []),
        ...(table.sampleTail || [])
      ]));
    };

    const mergeTableRows = (table) => {
      return [
        ...(Array.isArray(table?.sample) ? table.sample : []),
        ...(Array.isArray(table?.sampleTail) ? table.sampleTail : [])
      ];
    };

    const makeValueObject = (row, labelOverride, latestCol, previousCol) => {
      if (!row) return null;

      return {
        label: labelOverride || getRowLabelFromRow(row) || null,
        current: latestCol !== null && latestCol !== undefined
          ? parseNumberSmart(getCell(row, latestCol))
          : null,
        previous: previousCol !== null && previousCol !== undefined
          ? parseNumberSmart(getCell(row, previousCol))
          : null
      };
    };

    const isMissingValueObj = (obj) => {
      return !obj || (obj.current === null && obj.previous === null);
    };

    const hasCurrent = (obj) => !!obj && obj.current !== null && obj.current !== undefined;
    const hasPrevious = (obj) => !!obj && obj.previous !== null && obj.previous !== undefined;

    const safePercentChange = (current, previous) => {
      if (current === null || current === undefined) return null;
      if (previous === null || previous === undefined) return null;
      if (previous === 0) return null;
      return ((current - previous) / Math.abs(previous)) * 100;
    };

    const safeRatio = (numerator, denominator) => {
      if (numerator === null || numerator === undefined) return null;
      if (denominator === null || denominator === undefined) return null;
      if (denominator === 0) return null;
      return numerator / denominator;
    };

    const safeMarginPct = (numerator, denominator) => {
      const ratio = safeRatio(numerator, denominator);
      return ratio === null ? null : ratio * 100;
    };

    const boolOrNull = (value) => {
      if (value === true) return true;
      if (value === false) return false;
      return null;
    };

    const round2 = (n) => {
      if (n === null || n === undefined) return null;
      return Math.round(n * 100) / 100;
    };

    const pctDescriptor = (value, goodThreshold, weakThreshold) => {
      if (value === null || value === undefined) return null;
      if (value >= goodThreshold) return "strong";
      if (value <= weakThreshold) return "weak";
      return "moderate";
    };

    const pushInsight = (arr, text) => {
      if (text && !arr.includes(text)) arr.push(text);
    };

    const pushUnique = (arr, text) => {
      if (text && !arr.includes(text)) arr.push(text);
    };

    const cloneValueObj = (obj) => {
      if (!obj) return null;
      return {
        label: obj.label ?? null,
        current: obj.current ?? null,
        previous: obj.previous ?? null
      };
    };

    const makeNullValueObject = (label) => ({
      label,
      current: null,
      previous: null
    });

    const normalizeKeyArray = (arr) => (Array.isArray(arr) ? arr : []).map(x => norm(x));

    const findBestRowForNames = (rows, names, latestCol, options = {}) => {
      const normalizedNames = normalizeKeyArray(names);
      const requireNumeric = options.requireNumeric !== false;
      const exactOnly = options.exactOnly === true;
      const containsOnly = options.containsOnly === true;
      const usedRowIndexes = options.usedRowIndexes || null;

      let best = { row: null, index: -1, score: -Infinity };

      for (let i = 0; i < rows.length; i++) {
        if (usedRowIndexes && usedRowIndexes.has(i)) continue;

        const row = rows[i];
        const label = getRowLabelFromRow(row);
        if (!label) continue;
        if (requireNumeric && !rowHasNumericValueAt(row, latestCol)) continue;

        const s = stripNonTextNoise(label);

        let score = -Infinity;

        for (const n of normalizedNames) {
          if (!n) continue;

          if (s === n) {
            score = Math.max(score, 100 + n.length);
          } else if (!exactOnly && (s.startsWith(n) || s.endsWith(n))) {
            score = Math.max(score, 85 + n.length);
          } else if (!exactOnly && !containsOnly && s.includes(n)) {
            score = Math.max(score, 70 + n.length);
          } else if (!exactOnly && containsOnly && s.includes(n)) {
            score = Math.max(score, 70 + n.length);
          }
        }

        if (score > best.score) {
          best = { row, index: i, score };
        }
      }

      return best.score > -Infinity ? best : { row: null, index: -1, score: -Infinity };
    };

    const extractFieldsByMap = (rows, fieldMap, latestCol, previousCol, options = {}) => {
      const out = {};
      const usedRowIndexes = options.usedRowIndexes || new Set();

      for (const [key, config] of Object.entries(fieldMap)) {
        const names = Array.isArray(config) ? config : (config.names || []);
        const label = Array.isArray(config) ? key : (config.label || key);
        const matcherOptions = Array.isArray(config) ? {} : {
          exactOnly: config.exactOnly === true,
          containsOnly: config.containsOnly === true,
          requireNumeric: config.requireNumeric !== false,
          usedRowIndexes
        };

        const match = findBestRowForNames(rows, names, latestCol, matcherOptions);

        if (match.index >= 0) usedRowIndexes.add(match.index);

        out[key] = makeValueObject(match.row, label, latestCol, previousCol);
      }

      return out;
    };

    const mergeExtractionStatus = (statementProfile, incomeExtract, balanceExtract, cashFlowExtract) => {
      if (statementProfile === "bank") {
        return {
          incomeStatementLite: hasCurrent(incomeExtract?.totalOperatingIncome) || hasCurrent(incomeExtract?.netIncomeAfterZakat),
          balanceSheetLite: hasCurrent(balanceExtract?.totalAssets) || hasCurrent(balanceExtract?.customerDeposits),
          cashFlowLite: hasCurrent(cashFlowExtract?.endingCash)
        };
      }

      return {
        incomeStatementLite: hasCurrent(incomeExtract?.revenue),
        balanceSheetLite: hasCurrent(balanceExtract?.totalAssets),
        cashFlowLite: hasCurrent(cashFlowExtract?.endingCash)
      };
    };


        /* =========================
       Statement profiles + synonyms
       ========================= */

    const OPERATING_INCOME_NAMES = {
      revenue: ["الإيرادات", "الايرادات", "المبيعات", "Sales", "Revenue"],
      costOfRevenue: ["تكلفة الإيرادات", "تكلفة الايرادات", "تكلفة المبيعات", "Cost of Revenue", "Cost of Sales"],
      grossProfit: ["مجمل الربح", "إجمالي الربح", "Gross Profit"],
      operatingProfit: ["الربح التشغيلي", "الدخل التشغيلي", "ربح التشغيل", "Operating Profit", "Operating Income"]
    };

    const BANK_INCOME_NAMES = {
      incomeFromInvestmentsAndFinancing: {
        label: "الدخل من الاستثمارات والتمويل",
        names: [
          "الدخل من الاستثمارات والتمويل",
          "دخل من الاستثمارات والتمويل",
          "الدخل من التمويل والاستثمارات",
          "income from investments and financing",
          "income from financing and investments"
        ]
      },
      returnsOnInvestmentsHeldForTradingOrFV: {
        label: "عائدات على استثمارات",
        names: [
          "عائدات على استثمارات لأجل",
          "عائدات على استثمارات",
          "عائد على استثمارات",
          "returns on investments",
          "returns on investments held"
        ]
      },
      netIncomeFromInvestmentsAndFinancing: {
        label: "صافي الدخل من الاستثمارات والتمويل",
        names: [
          "صافي الدخل من الاستثمارات والتمويل",
          "صافي الدخل من التمويل والاستثمارات",
          "صافي دخل الاستثمارات والتمويل",
          "net income from investments and financing",
          "net income from financing and investments"
        ]
      },
      feeIncomeGross: {
        label: "دخل رسوم خدمات مصرفية",
        names: [
          "دخل رسوم خدمات مصرفية",
          "إيرادات رسوم خدمات مصرفية",
          "رسوم خدمات مصرفية",
          "banking service fee income",
          "fee income",
          "fees from banking services"
        ]
      },
      feeExpense: {
        label: "مصاريف رسوم خدمات مصرفية",
        names: [
          "مصاريف رسوم خدمات مصرفية",
          "مصروفات رسوم خدمات مصرفية",
          "مصروف رسوم خدمات مصرفية",
          "banking service fee expenses",
          "fee expense"
        ]
      },
      feeIncomeNet: {
        label: "رسوم خدمات مصرفية، صافي",
        names: [
          "رسوم خدمات مصرفية، صافي",
          "رسوم خدمات مصرفية صافي",
          "صافي رسوم خدمات مصرفية",
          "net fee income",
          "banking service fees net"
        ]
      },
      totalOperatingIncome: {
        label: "إجمالي دخل العمليات",
        names: [
          "إجمالي دخل العمليات",
          "اجمالي دخل العمليات",
          "إجمالي دخل التشغيل",
          "إجمالي الإيرادات التشغيلية",
          "total operating income",
          "total operating revenue"
        ]
      },
      salariesAndEmployeeBenefits: {
        label: "رواتب ومصاريف الموظفين",
        names: [
          "رواتب ومصاريف الموظفين",
          "رواتب ومزايا الموظفين",
          "مصاريف الموظفين",
          "salaries and employee benefits",
          "employee expenses"
        ]
      },
      depreciationAndAmortization: {
        label: "استهلاك وإطفاء",
        names: [
          "استهلاك واطفاء",
          "استهلاك وإطفاء",
          "الاستهلاك والإطفاء",
          "depreciation and amortization"
        ]
      },
      otherOperatingExpenses: {
        label: "مصاريف عمومية وإدارية أخرى",
        names: [
          "مصاريف عمومية وإدارية أخرى",
          "مصاريف ادارية وعمومية اخرى",
          "مصروفات عمومية وإدارية أخرى",
          "other general and administrative expenses",
          "other operating expenses"
        ]
      },
      operatingExpensesBeforeImpairment: {
        label: "مصاريف العمليات قبل مخصصات الانخفاض",
        names: [
          "مصاريف العمليات قبل مخصصات الانخفاض في القيمة",
          "مصاريف العمليات قبل مخصصات الانخفاض",
          "إجمالي مصاريف العمليات قبل مخصصات الانخفاض",
          "operating expenses before impairment",
          "total operating expenses before impairment"
        ]
      },
      netImpairmentChargeForFinancing: {
        label: "مخصص الانخفاض في قيمة التمويل، صافي",
        names: [
          "مخصص الانخفاض في قيمة التمويل، صافي",
          "مخصص الانخفاض في قيمة التمويل صافي",
          "مخصص خسائر الائتمان",
          "صافي مخصص خسائر الائتمان",
          "net impairment charge for financing",
          "credit loss provision",
          "expected credit loss provision"
        ]
      },
      totalOperatingExpenses: {
        label: "إجمالي مصاريف العمليات",
        names: [
          "إجمالي مصاريف العمليات",
          "اجمالي مصاريف العمليات",
          "إجمالي المصاريف التشغيلية",
          "total operating expenses"
        ]
      },
      netOperatingIncome: {
        label: "صافي دخل العمليات",
        names: [
          "صافي دخل العمليات",
          "صافي الدخل من العمليات",
          "net operating income"
        ]
      },
      shareOfResultsAssociates: {
        label: "حصة في خسارة/ربح شركة زميلة",
        names: [
          "حصة في خسارة شركة زميلة ومشروع مشترك",
          "حصة في ربح شركة زميلة ومشروع مشترك",
          "حصة من نتائج شركة زميلة",
          "share of results of associate",
          "share of profit of associate",
          "share of loss of associate"
        ]
      },
      netIncomeBeforeZakat: {
        label: "دخل السنة قبل الزكاة",
        names: [
          "دخل السنة قبل الزكاة",
          "صافي دخل السنة قبل الزكاة",
          "الربح قبل الزكاة",
          "صافي الربح قبل الزكاة",
          "income before zakat",
          "profit before zakat"
        ]
      },
      zakat: {
        label: "زكاة السنة",
        names: [
          "زكاة السنة",
          "الزكاة",
          "مصروف الزكاة",
          "zakat",
          "zakat expense"
        ]
      },
      netIncomeAfterZakat: {
        label: "صافي دخل السنة بعد الزكاة",
        names: [
          "صافي دخل السنة بعد الزكاة",
          "صافي الربح بعد الزكاة",
          "صافي دخل السنة",
          "صافي الربح للسنة",
          "net income after zakat",
          "net profit after zakat",
          "net income for the year"
        ]
      }
    };

    const BANK_BALANCE_NAMES = {
      cashAndBalancesWithCentralBank: {
        label: "نقد وأرصدة لدى البنك المركزي السعودي",
        names: [
          "نقد وأرصدة لدى البنك المركزي السعودي",
          "النقد والأرصدة لدى البنك المركزي السعودي",
          "نقد وارصدة لدى البنك المركزي السعودي",
          "cash and balances with central bank",
          "cash and balances with saudi central bank"
        ]
      },
      balancesWithBanksAndFinancialInstitutions: {
        label: "أرصدة لدى البنوك والمؤسسات المالية الأخرى، صافي",
        names: [
          "أرصدة لدى البنوك والمؤسسات المالية الأخرى، صافي",
          "أرصدة لدى البنوك والمؤسسات المالية الأخرى صافي",
          "ارصدة لدى البنوك والمؤسسات المالية الاخرى",
          "balances with banks and other financial institutions",
          "balances with banks"
        ]
      },
      investmentsAtFVTPL: {
        label: "استثمارات بالقيمة العادلة",
        names: [
          "استثمارات بالقيمة العادلة خلال قائمة الدخل",
          "استثمارات بالقيمة العادلة",
          "استثمارات بالقيمة العادلة من خلال قائمة الدخل",
          "investments at fair value through income statement",
          "investments at fair value"
        ]
      },
      investmentsAtFVOCI: {
        label: "استثمارات بالقيمة العادلة من خلال الدخل الشامل الآخر",
        names: [
          "استثمارات بالقيمة العادلة من خلال الدخل الشامل الآخر",
          "استثمارات بالقيمة العادلة خلال الدخل الشامل الآخر",
          "investments at fair value through other comprehensive income",
          "fvoci investments"
        ]
      },
      investmentsAtAmortizedCost: {
        label: "استثمارات بالتكلفة المطفأة، صافي",
        names: [
          "استثمارات بالتكلفة المطفأة، صافي",
          "استثمارات بالتكلفة المطفأة صافي",
          "استثمارات بالتكلفة المستنفذة، صافي",
          "استثمارات بالتكلفة المطفاة",
          "investments at amortized cost",
          "investments at amortised cost"
        ]
      },
      investmentsInAssociates: {
        label: "استثمار في شركات زميلة ومشروع مشترك",
        names: [
          "استثمار في شركات زميلة ومشروع مشترك",
          "استثمار في شركات زميلة",
          "investments in associates and joint venture",
          "investment in associate"
        ]
      },
      derivativeAssets: {
        label: "القيمة العادلة الموجبة للمشتقات",
        names: [
          "القيمة العادلة الموجبة للمشتقات",
          "موجودات مشتقات",
          "positive fair value of derivatives",
          "derivative assets"
        ]
      },
      financingNet: {
        label: "تمويل، صافي",
        names: [
          "تمويل، صافي",
          "تمويل صافي",
          "صافي التمويل",
          "financing net",
          "net financing"
        ]
      },
      propertyAndEquipment: {
        label: "ممتلكات ومعدات وموجودات حق استخدام، صافي",
        names: [
          "ممتلكات ومعدات وموجودات حق استخدام، صافي",
          "ممتلكات ومعدات صافي",
          "موجودات حق استخدام",
          "property and equipment",
          "right of use assets"
        ]
      },
      otherAssets: {
        label: "موجودات أخرى",
        names: [
          "موجودات أخرى",
          "أصول أخرى",
          "other assets"
        ]
      },
      totalAssets: {
        label: "إجمالي الموجودات",
        names: [
          "إجمالي الموجودات",
          "اجمالي الموجودات",
          "إجمالي الأصول",
          "total assets"
        ],
        exactOnly: true
      },

      balancesDueToCentralBankAndBanks: {
        label: "أرصدة للبنك المركزي السعودي والبنوك والمؤسسات المالية الأخرى",
        names: [
          "أرصدة للبنك المركزي السعودي والبنوك والمؤسسات المالية الأخرى",
          "ارصدة للبنك المركزي السعودي والبنوك والمؤسسات المالية الاخرى",
          "balances due to central bank and banks",
          "due to banks and central bank"
        ]
      },
      customerDeposits: {
        label: "ودائع العملاء",
        names: [
          "ودائع العملاء",
          "deposits from customers",
          "customer deposits"
        ],
        exactOnly: true
      },
      debtSecuritiesIssued: {
        label: "صكوك وشهادات إيداع مصدرة",
        names: [
          "صكوك وشهادات إيداع مصدرة",
          "صكوك مصدرة",
          "شهادات إيداع مصدرة",
          "debt securities in issue",
          "sukuk issued",
          "certificates of deposit issued"
        ]
      },
      derivativeLiabilities: {
        label: "القيمة العادلة السالبة للمشتقات",
        names: [
          "القيمة العادلة السالبة للمشتقات",
          "مطلوبات مشتقات",
          "negative fair value of derivatives",
          "derivative liabilities"
        ]
      },
      leaseLiabilities: {
        label: "التزامات إيجار",
        names: [
          "التزامات إيجار",
          "التزامات الايجار",
          "lease liabilities"
        ]
      },
      otherLiabilities: {
        label: "مطلوبات أخرى",
        names: [
          "مطلوبات أخرى",
          "التزامات أخرى",
          "other liabilities"
        ]
      },
      totalLiabilities: {
        label: "إجمالي المطلوبات",
        names: [
          "إجمالي المطلوبات",
          "اجمالي المطلوبات",
          "إجمالي الالتزامات",
          "total liabilities"
        ],
        exactOnly: true
      },

      shareCapital: {
        label: "رأس المال",
        names: [
          "رأس المال",
          "راس المال",
          "share capital",
          "capital"
        ]
      },
      treasuryShares: {
        label: "أسهم خزينة",
        names: [
          "أسهم خزينة",
          "اسهم خزينة",
          "treasury shares"
        ]
      },
      statutoryReserve: {
        label: "احتياطي نظامي",
        names: [
          "احتياطي نظامي",
          "الاحتياطي النظامي",
          "statutory reserve"
        ]
      },
      otherReserves: {
        label: "احتياطيات أخرى",
        names: [
          "احتياطيات أخرى",
          "احتياطات أخرى",
          "other reserves"
        ]
      },
      retainedEarnings: {
        label: "أرباح مبقاة",
        names: [
          "أرباح مبقاة",
          "ارباح مبقاة",
          "retained earnings"
        ]
      },
      equityAttributableToShareholders: {
        label: "حقوق الملكية العائدة لمساهمي المصرف",
        names: [
          "حقوق الملكية العائدة لمساهمي المصرف",
          "حقوق الملكية العائدة للمساهمين",
          "equity attributable to shareholders",
          "equity attributable to owners"
        ]
      },
      tier1Sukuk: {
        label: "صكوك الشريحة الأولى",
        names: [
          "صكوك الشريحة الأولى",
          "صكوك الشريحة الاولى",
          "additional tier 1 sukuk",
          "tier 1 sukuk"
        ]
      },
      totalEquity: {
        label: "إجمالي حقوق الملكية",
        names: [
          "إجمالي حقوق الملكية",
          "اجمالي حقوق الملكية",
          "إجمالي حقوق المساهمين",
          "total equity"
        ],
        exactOnly: true
      }
    };

    const BANK_PROFILE_KEYWORDS = [
      "مصرف",
      "بنك",
      "البنك المركزي",
      "ودائع العملاء",
      "الدخل من الاستثمارات والتمويل",
      "دخل رسوم خدمات مصرفية",
      "إجمالي دخل العمليات",
      "صكوك",
      "شهادات إيداع",
      "تمويل، صافي",
      "تمويل صافي",
      "القيمة العادلة للمشتقات",
      "زكاة",
      "customer deposits",
      "banking services",
      "total operating income",
      "financing net"
    ];

        /* =========================
       Profile detection
       ========================= */

    const detectStatementProfile = (tablesPreview) => {

      let scoreBank = 0;

      for (const table of tablesPreview) {

        const blob = tableTextBlob(table);

        for (const k of BANK_PROFILE_KEYWORDS) {
          if (blob.includes(norm(k))) {
            scoreBank++;
          }
        }
      }

      if (scoreBank >= 4) {
        return "bank";
      }

      return "operating_company";
    };


    /* =========================
       Extractors
       ========================= */

    const extractBankIncomeStatement = (rows, latestCol, previousCol) => {

      const fields = extractFieldsByMap(
        rows,
        BANK_INCOME_NAMES,
        latestCol,
        previousCol
      );

      return {
        incomeFromInvestmentsAndFinancing: fields.incomeFromInvestmentsAndFinancing,
        returnsOnInvestmentsHeldForTradingOrFV: fields.returnsOnInvestmentsHeldForTradingOrFV,
        netIncomeFromInvestmentsAndFinancing: fields.netIncomeFromInvestmentsAndFinancing,

        feeIncomeGross: fields.feeIncomeGross,
        feeExpense: fields.feeExpense,
        feeIncomeNet: fields.feeIncomeNet,

        totalOperatingIncome: fields.totalOperatingIncome,

        salariesAndEmployeeBenefits: fields.salariesAndEmployeeBenefits,
        depreciationAndAmortization: fields.depreciationAndAmortization,
        otherOperatingExpenses: fields.otherOperatingExpenses,

        operatingExpensesBeforeImpairment: fields.operatingExpensesBeforeImpairment,
        netImpairmentChargeForFinancing: fields.netImpairmentChargeForFinancing,

        totalOperatingExpenses: fields.totalOperatingExpenses,

        netOperatingIncome: fields.netOperatingIncome,

        shareOfResultsAssociates: fields.shareOfResultsAssociates,

        netIncomeBeforeZakat: fields.netIncomeBeforeZakat,
        zakat: fields.zakat,

        netIncomeAfterZakat: fields.netIncomeAfterZakat
      };
    };


    const extractBankBalanceSheet = (rows, latestCol, previousCol) => {

      const fields = extractFieldsByMap(
        rows,
        BANK_BALANCE_NAMES,
        latestCol,
        previousCol
      );

      return {
        cashAndBalancesWithCentralBank: fields.cashAndBalancesWithCentralBank,
        balancesWithBanksAndFinancialInstitutions: fields.balancesWithBanksAndFinancialInstitutions,

        investmentsAtFVTPL: fields.investmentsAtFVTPL,
        investmentsAtFVOCI: fields.investmentsAtFVOCI,
        investmentsAtAmortizedCost: fields.investmentsAtAmortizedCost,
        investmentsInAssociates: fields.investmentsInAssociates,

        derivativeAssets: fields.derivativeAssets,

        financingNet: fields.financingNet,

        propertyAndEquipment: fields.propertyAndEquipment,

        otherAssets: fields.otherAssets,

        totalAssets: fields.totalAssets,

        balancesDueToCentralBankAndBanks: fields.balancesDueToCentralBankAndBanks,
        customerDeposits: fields.customerDeposits,
        debtSecuritiesIssued: fields.debtSecuritiesIssued,

        derivativeLiabilities: fields.derivativeLiabilities,
        leaseLiabilities: fields.leaseLiabilities,
        otherLiabilities: fields.otherLiabilities,

        totalLiabilities: fields.totalLiabilities,

        shareCapital: fields.shareCapital,
        treasuryShares: fields.treasuryShares,
        statutoryReserve: fields.statutoryReserve,
        otherReserves: fields.otherReserves,
        retainedEarnings: fields.retainedEarnings,

        equityAttributableToShareholders: fields.equityAttributableToShareholders,

        tier1Sukuk: fields.tier1Sukuk,

        totalEquity: fields.totalEquity
      };
    };


    const extractOperatingIncomeStatement = (rows, latestCol, previousCol) => {

      const revenueMatch = findBestRowForNames(
        rows,
        OPERATING_INCOME_NAMES.revenue,
        latestCol
      );

      const costMatch = findBestRowForNames(
        rows,
        OPERATING_INCOME_NAMES.costOfRevenue,
        latestCol
      );

      const grossMatch = findBestRowForNames(
        rows,
        OPERATING_INCOME_NAMES.grossProfit,
        latestCol
      );

      const opMatch = findBestRowForNames(
        rows,
        OPERATING_INCOME_NAMES.operatingProfit,
        latestCol
      );

      return {
        revenue: makeValueObject(revenueMatch.row, "الإيرادات", latestCol, previousCol),
        costOfRevenue: makeValueObject(costMatch.row, "تكلفة الإيرادات", latestCol, previousCol),
        grossProfit: makeValueObject(grossMatch.row, "مجمل الربح", latestCol, previousCol),
        operatingProfit: makeValueObject(opMatch.row, "الربح التشغيلي", latestCol, previousCol)
      };
    };


    /* =========================
       Router
       ========================= */

    const extractFinancialStatements = (profile, rows, latestCol, previousCol) => {

      if (profile === "bank") {

        return {
          incomeStatementLite: extractBankIncomeStatement(rows, latestCol, previousCol),
          balanceSheetLite: extractBankBalanceSheet(rows, latestCol, previousCol)
        };
      }

      return {
        incomeStatementLite: extractOperatingIncomeStatement(rows, latestCol, previousCol),
        balanceSheetLite: null
      };
    };

        /* =========================
       Table scoring
       ========================= */

    const scoreIncomeTable = (table) => {
      const text = tableTextBlob(table);
      let score = 0;

      if (text.includes("الإيرادات") || text.includes("الايرادات")) score += 8;
      if (text.includes("تكلفة الإيرادات") || text.includes("تكلفة الايرادات")) score += 6;
      if (text.includes("مجمل الربح")) score += 6;
      if (text.includes("الربح التشغيلي")) score += 6;
      if (text.includes("قائمة الدخل")) score += 4;
      if (text.includes("الربح")) score += 2;
      if (text.includes("المراجعة") || text.includes("أمر المراجعة") || text.includes("امر المراجعة")) score -= 10;
      if (text.includes("الموجودات") || text.includes("الأصول")) score -= 4;
      if (text.includes("التدفقات النقدية")) score -= 4;

      return score;
    };

    const pickBestIncomeTable = (tables) => {
      let best = null;
      let bestScore = -Infinity;

      for (const t of tables) {
        const score = scoreIncomeTable(t);
        if (score > bestScore) {
          best = t;
          bestScore = score;
        }
      }

      return bestScore > 0 ? best : null;
    };

    const scoreBalanceTable = (table) => {
      const text = tableTextBlob(table);
      let score = 0;

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

      return score;
    };

    const pickBestBalanceTable = (tables) => {
      let best = null;
      let bestScore = -Infinity;

      for (const t of tables) {
        const score = scoreBalanceTable(t);
        if (score > bestScore) {
          best = t;
          bestScore = score;
        }
      }

      return bestScore > 0 ? best : null;
    };

    const scoreCashFlowTable = (table) => {
      const text = tableTextBlob(table);
      let score = 0;

      if (text.includes("التدفقات النقدية")) score += 12;
      if (text.includes("قائمة التدفقات النقدية")) score += 16;
      if (text.includes("cash flow")) score += 12;
      if (text.includes("النقد وما في حكمه")) score += 10;
      if (text.includes("cash and cash")) score += 10;
      if (text.includes("صافي التغير")) score += 8;
      if (text.includes("net change")) score += 8;

      if (Number(table.columnCount) >= 2 && Number(table.columnCount) <= 4) score += 3;
      if (Number(table.rowCount) >= 15) score += 3;

      if (text.includes("الإيرادات") || text.includes("مجمل الربح")) score -= 5;
      if (text.includes("الموجودات") || text.includes("حقوق الملكية")) score -= 5;

      return score;
    };

    const pickBestCashTable = (tables) => {
      let best = null;
      let bestScore = -Infinity;

      for (const t of tables) {
        const score = scoreCashFlowTable(t);
        if (score > bestScore) {
          best = t;
          bestScore = score;
        }
      }

      return bestScore > 0 ? best : null;
    };

    /* =========================
       Main extraction flow
       ========================= */

    const statementProfile = detectStatementProfile(tablesPreview);

    let incomeExtract = {};
    let balanceExtract = {};
    let cashFlowExtract = {};

    let incomeYears = { current: null, previous: null };
    let balanceYears = { current: null, previous: null };
    let cashFlowYears = { current: null, previous: null };

    const incomeTable = pickBestIncomeTable(tablesPreview);

    if (incomeTable) {
      const cols = detectColumns(incomeTable);
      const picked = pickLatestColumns(cols);

      incomeYears = {
        current: picked.latestYear ?? null,
        previous: picked.previousYear ?? null
      };

      const latestCol = picked.latest?.col ?? null;
      const previousCol = picked.previous?.col ?? null;
      const rows = mergeTableRows(incomeTable);

      const routed = extractFinancialStatements(
        statementProfile,
        rows,
        latestCol,
        previousCol
      );

      incomeExtract = routed.incomeStatementLite || {};
    }

    const balanceTable = pickBestBalanceTable(tablesPreview);

    if (balanceTable) {
      const cols = detectColumns(balanceTable);
      const picked = pickLatestColumns(cols);

      balanceYears = {
        current: picked.latestYear ?? null,
        previous: picked.previousYear ?? null
      };

      const latestCol = picked.latest?.col ?? null;
      const previousCol = picked.previous?.col ?? null;
      const rows = mergeTableRows(balanceTable);

      if (statementProfile === "bank") {
        balanceExtract = extractBankBalanceSheet(rows, latestCol, previousCol);
      } else {
        const usedRowIndexes = new Set();

        const nonCurrentAssetsMatch = findExactBalanceSheetMatch(
          rows,
          ["إجمالي الموجودات غير المتداولة", "إجمالي الأصول غير المتداولة"],
          latestCol,
          usedRowIndexes
        );

        if (nonCurrentAssetsMatch.index >= 0) usedRowIndexes.add(nonCurrentAssetsMatch.index);

        balanceExtract.nonCurrentAssets = makeValueObject(
          nonCurrentAssetsMatch.row,
          "الأصول غير المتداولة",
          latestCol,
          previousCol
        );

        const totalAssetsDirectMatch = findExactBalanceSheetMatch(
          rows,
          ["إجمالي الموجودات", "إجمالي الأصول", "مجموع الأصول"],
          latestCol,
          usedRowIndexes
        );

        if (totalAssetsDirectMatch.index >= 0) usedRowIndexes.add(totalAssetsDirectMatch.index);

        let totalAssetsObj = makeValueObject(
          totalAssetsDirectMatch.row,
          "إجمالي الأصول",
          latestCol,
          previousCol
        );

        if (isMissingValueObj(totalAssetsObj)) {
          const totalAssetsFromAccountingMatch = findContainsBalanceSheetMatch(
            rows,
            ["إجمالي حقوق الملكية والمطلوبات"],
            latestCol,
            usedRowIndexes
          );

          if (totalAssetsFromAccountingMatch.index >= 0) {
            usedRowIndexes.add(totalAssetsFromAccountingMatch.index);

            totalAssetsObj = makeValueObject(
              totalAssetsFromAccountingMatch.row,
              "إجمالي الأصول",
              latestCol,
              previousCol
            );
          }
        }

        balanceExtract.totalAssets = totalAssetsObj;

        if (hasCurrent(balanceExtract.totalAssets) && hasCurrent(balanceExtract.nonCurrentAssets)) {
          balanceExtract.currentAssets = {
            label: "الأصول المتداولة (مشتق)",
            current: balanceExtract.totalAssets.current - balanceExtract.nonCurrentAssets.current,
            previous:
              hasPrevious(balanceExtract.totalAssets) && hasPrevious(balanceExtract.nonCurrentAssets)
                ? balanceExtract.totalAssets.previous - balanceExtract.nonCurrentAssets.previous
                : null
          };
        } else {
          balanceExtract.currentAssets = null;
        }

        const totalLiabilitiesMatch = findExactBalanceSheetMatch(
          rows,
          ["إجمالي المطلوبات", "إجمالي الالتزامات", "مجموع المطلوبات", "مجموع الالتزامات"],
          latestCol,
          usedRowIndexes
        );
        if (totalLiabilitiesMatch.index >= 0) usedRowIndexes.add(totalLiabilitiesMatch.index);

        balanceExtract.totalLiabilities = makeValueObject(
          totalLiabilitiesMatch.row,
          "إجمالي المطلوبات",
          latestCol,
          previousCol
        );

        const currentLiabilitiesMatch = findExactBalanceSheetMatch(
          rows,
          ["إجمالي المطلوبات المتداولة", "إجمالي الالتزامات المتداولة"],
          latestCol,
          usedRowIndexes
        );
        if (currentLiabilitiesMatch.index >= 0) usedRowIndexes.add(currentLiabilitiesMatch.index);

        balanceExtract.currentLiabilities = makeValueObject(
          currentLiabilitiesMatch.row,
          "المطلوبات المتداولة",
          latestCol,
          previousCol
        );

        const nonCurrentLiabilitiesMatch = findExactBalanceSheetMatch(
          rows,
          ["إجمالي المطلوبات غير المتداولة", "إجمالي الالتزامات غير المتداولة"],
          latestCol,
          usedRowIndexes
        );
        if (nonCurrentLiabilitiesMatch.index >= 0) usedRowIndexes.add(nonCurrentLiabilitiesMatch.index);

        balanceExtract.nonCurrentLiabilities = makeValueObject(
          nonCurrentLiabilitiesMatch.row,
          "المطلوبات غير المتداولة",
          latestCol,
          previousCol
        );

        const totalEquityMatch = findExactBalanceSheetMatch(
          rows,
          ["إجمالي حقوق الملكية", "إجمالي حقوق المساهمين", "مجموع حقوق الملكية"],
          latestCol,
          usedRowIndexes
        );
        if (totalEquityMatch.index >= 0) usedRowIndexes.add(totalEquityMatch.index);

        balanceExtract.totalEquity = makeValueObject(
          totalEquityMatch.row,
          "إجمالي حقوق الملكية",
          latestCol,
          previousCol
        );
      }
    }

    /* =========================
       Cash flow
       ========================= */

    const detectCashTriplet = (rows, latestCol, previousCol) => {
      if (latestCol === null || previousCol === null) return null;

      const numericRows = rows.filter(r =>
        rowHasNumericValueAt(r, latestCol) || rowHasNumericValueAt(r, previousCol)
      );

      if (numericRows.length < 3) return null;

      for (let i = numericRows.length - 3; i >= 0; i--) {
        const row1 = numericRows[i];
        const row2 = numericRows[i + 1];
        const row3 = numericRows[i + 2];

        const r1Current = parseNumberSmart(getCell(row1, latestCol));
        const r1Previous = parseNumberSmart(getCell(row1, previousCol));

        const r2Current = parseNumberSmart(getCell(row2, latestCol));
        const r2Previous = parseNumberSmart(getCell(row2, previousCol));

        const r3Current = parseNumberSmart(getCell(row3, latestCol));
        const r3Previous = parseNumberSmart(getCell(row3, previousCol));

        const arithmeticValid =
          r1Current !== null &&
          r1Previous !== null &&
          r2Current !== null &&
          r2Previous !== null &&
          r3Current !== null &&
          r3Previous !== null &&
          (r3Current - r2Current === r1Current) &&
          (r3Previous - r2Previous === r1Previous);

        if (arithmeticValid) {
          return {
            netChange: {
              label: "صافي التغير في النقد (detected)",
              current: r1Current,
              previous: r1Previous
            },
            beginningCash: {
              label: "النقد وما في حكمه في بداية السنة (detected)",
              current: r2Current,
              previous: r2Previous
            },
            endingCash: {
              label: "النقد وما في حكمه في نهاية السنة (detected)",
              current: r3Current,
              previous: r3Previous
            }
          };
        }
      }

      return null;
    };

    const cashTable = pickBestCashTable(tablesPreview);

    if (cashTable) {
      const cols = detectColumns(cashTable);
      const picked = pickLatestColumns(cols);

      cashFlowYears = {
        current: picked.latestYear ?? null,
        previous: picked.previousYear ?? null
      };

      const latestCol = picked.latest?.col ?? null;
      const previousCol = picked.previous?.col ?? null;

      const rows = mergeTableRows(cashTable);

      const endingCashNamesExact = [
        "النقد وما في حكمه في نهاية السنة",
        "النقد والنقد المعادل في نهاية السنة",
        "النقد وما في حكمه في نهاية الفترة",
        "النقد والنقد المعادل في نهاية الفترة"
      ];

      const beginningCashNamesExact = [
        "النقد وما في حكمه في بداية السنة",
        "النقد والنقد المعادل في بداية السنة",
        "النقد وما في حكمه في بداية الفترة",
        "النقد والنقد المعادل في بداية الفترة"
      ];

      const endingCashNamesContains = [
        "في نهاية السنة",
        "في نهاية الفترة"
      ];

      const beginningCashNamesContains = [
        "في بداية السنة",
        "في بداية الفترة"
      ];

      let endingCashMatch = findExactRowMatch(rows, endingCashNamesExact, latestCol);
      if (endingCashMatch.index < 0) {
        endingCashMatch = findContainsRowMatch(rows, endingCashNamesContains, latestCol);
      }

      let beginningCashMatch = findExactRowMatch(rows, beginningCashNamesExact, latestCol);
      if (beginningCashMatch.index < 0) {
        beginningCashMatch = findContainsRowMatch(rows, beginningCashNamesContains, latestCol);
      }

      let endingCashObj = makeValueObject(
        endingCashMatch.row,
        "النقد وما في حكمه في نهاية السنة",
        latestCol,
        previousCol
      );

      let beginningCashObj = makeValueObject(
        beginningCashMatch.row,
        "النقد وما في حكمه في بداية السنة",
        latestCol,
        previousCol
      );

      let netChangeObj = {
        label: "صافي التغير في النقد",
        current: null,
        previous: null
      };

      const detectedCashTriplet = detectCashTriplet(rows, latestCol, previousCol);

      if ((!hasCurrent(endingCashObj) || !hasCurrent(beginningCashObj)) && detectedCashTriplet) {
        beginningCashObj = detectedCashTriplet.beginningCash;
        endingCashObj = detectedCashTriplet.endingCash;
        netChangeObj = detectedCashTriplet.netChange;
      }

      if (netChangeObj.current === null && hasCurrent(endingCashObj) && hasCurrent(beginningCashObj)) {
        netChangeObj.current = endingCashObj.current - beginningCashObj.current;
      }

      if (netChangeObj.previous === null && hasPrevious(endingCashObj) && hasPrevious(beginningCashObj)) {
        netChangeObj.previous = endingCashObj.previous - beginningCashObj.previous;
      }

      cashFlowExtract = {
        endingCash: endingCashObj,
        beginningCash: beginningCashObj,
        netChangeInCash: netChangeObj
      };
    }

    /* =========================
       Checks
       ========================= */

    const accountingEquationCurrent =
      balanceExtract?.totalAssets?.current !== null &&
      balanceExtract?.totalAssets?.current !== undefined &&
      balanceExtract?.totalLiabilities?.current !== null &&
      balanceExtract?.totalLiabilities?.current !== undefined &&
      balanceExtract?.totalEquity?.current !== null &&
      balanceExtract?.totalEquity?.current !== undefined
        ? balanceExtract.totalAssets.current ===
          (balanceExtract.totalLiabilities.current + balanceExtract.totalEquity.current)
        : null;

    const accountingEquationPrevious =
      balanceExtract?.totalAssets?.previous !== null &&
      balanceExtract?.totalAssets?.previous !== undefined &&
      balanceExtract?.totalLiabilities?.previous !== null &&
      balanceExtract?.totalLiabilities?.previous !== undefined &&
      balanceExtract?.totalEquity?.previous !== null &&
      balanceExtract?.totalEquity?.previous !== undefined
        ? balanceExtract.totalAssets.previous ===
          (balanceExtract.totalLiabilities.previous + balanceExtract.totalEquity.previous)
        : null;

    const cashFlowEquationCurrent =
      cashFlowExtract?.endingCash?.current !== null &&
      cashFlowExtract?.endingCash?.current !== undefined &&
      cashFlowExtract?.beginningCash?.current !== null &&
      cashFlowExtract?.beginningCash?.current !== undefined &&
      cashFlowExtract?.netChangeInCash?.current !== null &&
      cashFlowExtract?.netChangeInCash?.current !== undefined
        ? (cashFlowExtract.endingCash.current - cashFlowExtract.beginningCash.current) ===
          cashFlowExtract.netChangeInCash.current
        : null;

    const cashFlowEquationPrevious =
      cashFlowExtract?.endingCash?.previous !== null &&
      cashFlowExtract?.endingCash?.previous !== undefined &&
      cashFlowExtract?.beginningCash?.previous !== null &&
      cashFlowExtract?.beginningCash?.previous !== undefined &&
      cashFlowExtract?.netChangeInCash?.previous !== null &&
      cashFlowExtract?.netChangeInCash?.previous !== undefined
        ? (cashFlowExtract.endingCash.previous - cashFlowExtract.beginningCash.previous) ===
          cashFlowExtract.netChangeInCash.previous
        : null;

    const checks = {
      accountingEquation: {
        current: boolOrNull(accountingEquationCurrent),
        previous: boolOrNull(accountingEquationPrevious)
      },
      cashFlowEquation: {
        current: boolOrNull(cashFlowEquationCurrent),
        previous: boolOrNull(cashFlowEquationPrevious)
      },
      completeness: statementProfile === "bank"
        ? {
            incomeStatementLite: {
              hasIncomeFromInvestmentsAndFinancing: hasCurrent(incomeExtract?.incomeFromInvestmentsAndFinancing),
              hasTotalOperatingIncome: hasCurrent(incomeExtract?.totalOperatingIncome),
              hasNetOperatingIncome: hasCurrent(incomeExtract?.netOperatingIncome),
              hasNetIncomeBeforeZakat: hasCurrent(incomeExtract?.netIncomeBeforeZakat),
              hasNetIncomeAfterZakat: hasCurrent(incomeExtract?.netIncomeAfterZakat)
            },
            balanceSheetLite: {
              hasCashAndBalancesWithCentralBank: hasCurrent(balanceExtract?.cashAndBalancesWithCentralBank),
              hasFinancingNet: hasCurrent(balanceExtract?.financingNet),
              hasCustomerDeposits: hasCurrent(balanceExtract?.customerDeposits),
              hasTotalAssets: hasCurrent(balanceExtract?.totalAssets),
              hasTotalLiabilities: hasCurrent(balanceExtract?.totalLiabilities),
              hasTotalEquity: hasCurrent(balanceExtract?.totalEquity)
            },
            cashFlowLite: {
              hasEndingCash: hasCurrent(cashFlowExtract?.endingCash),
              hasBeginningCash: hasCurrent(cashFlowExtract?.beginningCash),
              hasNetChangeInCash: hasCurrent(cashFlowExtract?.netChangeInCash)
            }
          }
        : {
            incomeStatementLite: {
              hasRevenue: hasCurrent(incomeExtract?.revenue),
              hasCostOfRevenue: hasCurrent(incomeExtract?.costOfRevenue),
              hasGrossProfit: hasCurrent(incomeExtract?.grossProfit),
              hasOperatingProfit: hasCurrent(incomeExtract?.operatingProfit)
            },
            balanceSheetLite: {
              hasTotalAssets: hasCurrent(balanceExtract?.totalAssets),
              hasCurrentAssets: hasCurrent(balanceExtract?.currentAssets),
              hasNonCurrentAssets: hasCurrent(balanceExtract?.nonCurrentAssets),
              hasTotalLiabilities: hasCurrent(balanceExtract?.totalLiabilities),
              hasCurrentLiabilities: hasCurrent(balanceExtract?.currentLiabilities),
              hasNonCurrentLiabilities: hasCurrent(balanceExtract?.nonCurrentLiabilities),
              hasTotalEquity: hasCurrent(balanceExtract?.totalEquity)
            },
            cashFlowLite: {
              hasEndingCash: hasCurrent(cashFlowExtract?.endingCash),
              hasBeginningCash: hasCurrent(cashFlowExtract?.beginningCash),
              hasNetChangeInCash: hasCurrent(cashFlowExtract?.netChangeInCash)
            }
          }
    };

    /* =========================
       Derived
       ========================= */

    const derived = statementProfile === "bank"
      ? {
          detectedYears: {
            incomeStatement: incomeYears,
            balanceSheet: balanceYears,
            cashFlow: cashFlowYears
          },
          growth: {
            totalOperatingIncomePct: round2(safePercentChange(
              incomeExtract?.totalOperatingIncome?.current ?? null,
              incomeExtract?.totalOperatingIncome?.previous ?? null
            )),
            netOperatingIncomePct: round2(safePercentChange(
              incomeExtract?.netOperatingIncome?.current ?? null,
              incomeExtract?.netOperatingIncome?.previous ?? null
            )),
            netIncomeAfterZakatPct: round2(safePercentChange(
              incomeExtract?.netIncomeAfterZakat?.current ?? null,
              incomeExtract?.netIncomeAfterZakat?.previous ?? null
            )),
            financingNetPct: round2(safePercentChange(
              balanceExtract?.financingNet?.current ?? null,
              balanceExtract?.financingNet?.previous ?? null
            )),
            customerDepositsPct: round2(safePercentChange(
              balanceExtract?.customerDeposits?.current ?? null,
              balanceExtract?.customerDeposits?.previous ?? null
            )),
            totalAssetsPct: round2(safePercentChange(
              balanceExtract?.totalAssets?.current ?? null,
              balanceExtract?.totalAssets?.previous ?? null
            )),
            totalEquityPct: round2(safePercentChange(
              balanceExtract?.totalEquity?.current ?? null,
              balanceExtract?.totalEquity?.previous ?? null
            )),
            endingCashPct: round2(safePercentChange(
              cashFlowExtract?.endingCash?.current ?? null,
              cashFlowExtract?.endingCash?.previous ?? null
            ))
          }
        }
      : {
          detectedYears: {
            incomeStatement: incomeYears,
            balanceSheet: balanceYears,
            cashFlow: cashFlowYears
          },
          growth: {
            revenuePct: round2(safePercentChange(
              incomeExtract?.revenue?.current ?? null,
              incomeExtract?.revenue?.previous ?? null
            )),
            grossProfitPct: round2(safePercentChange(
              incomeExtract?.grossProfit?.current ?? null,
              incomeExtract?.grossProfit?.previous ?? null
            )),
            operatingProfitPct: round2(safePercentChange(
              incomeExtract?.operatingProfit?.current ?? null,
              incomeExtract?.operatingProfit?.previous ?? null
            )),
            totalAssetsPct: round2(safePercentChange(
              balanceExtract?.totalAssets?.current ?? null,
              balanceExtract?.totalAssets?.previous ?? null
            )),
            totalEquityPct: round2(safePercentChange(
              balanceExtract?.totalEquity?.current ?? null,
              balanceExtract?.totalEquity?.previous ?? null
            )),
            endingCashPct: round2(safePercentChange(
              cashFlowExtract?.endingCash?.current ?? null,
              cashFlowExtract?.endingCash?.previous ?? null
            ))
          }
        };

    /* =========================
       Ratios
       ========================= */

    const ratios = statementProfile === "bank"
      ? {
          banking: {
            financingToDeposits: {
              current: round2(safeRatio(
                balanceExtract?.financingNet?.current ?? null,
                balanceExtract?.customerDeposits?.current ?? null
              )),
              previous: round2(safeRatio(
                balanceExtract?.financingNet?.previous ?? null,
                balanceExtract?.customerDeposits?.previous ?? null
              ))
            },
            equityToAssets: {
              current: round2(safeRatio(
                balanceExtract?.totalEquity?.current ?? null,
                balanceExtract?.totalAssets?.current ?? null
              )),
              previous: round2(safeRatio(
                balanceExtract?.totalEquity?.previous ?? null,
                balanceExtract?.totalAssets?.previous ?? null
              ))
            },
            depositsToAssets: {
              current: round2(safeRatio(
                balanceExtract?.customerDeposits?.current ?? null,
                balanceExtract?.totalAssets?.current ?? null
              )),
              previous: round2(safeRatio(
                balanceExtract?.customerDeposits?.previous ?? null,
                balanceExtract?.totalAssets?.previous ?? null
              ))
            },
            cashToDeposits: {
              current: round2(safeRatio(
                cashFlowExtract?.endingCash?.current ?? null,
                balanceExtract?.customerDeposits?.current ?? null
              )),
              previous: round2(safeRatio(
                cashFlowExtract?.endingCash?.previous ?? null,
                balanceExtract?.customerDeposits?.previous ?? null
              ))
            },
            netOperatingIncomeMarginPct: {
              current: round2(safeMarginPct(
                incomeExtract?.netOperatingIncome?.current ?? null,
                incomeExtract?.totalOperatingIncome?.current ?? null
              )),
              previous: round2(safeMarginPct(
                incomeExtract?.netOperatingIncome?.previous ?? null,
                incomeExtract?.totalOperatingIncome?.previous ?? null
              ))
            },
            netIncomeMarginPct: {
              current: round2(safeMarginPct(
                incomeExtract?.netIncomeAfterZakat?.current ?? null,
                incomeExtract?.totalOperatingIncome?.current ?? null
              )),
              previous: round2(safeMarginPct(
                incomeExtract?.netIncomeAfterZakat?.previous ?? null,
                incomeExtract?.totalOperatingIncome?.previous ?? null
              ))
            }
          }
        }
      : {
          profitability: {
            grossMarginPct: {
              current: round2(safeMarginPct(
                incomeExtract?.grossProfit?.current ?? null,
                incomeExtract?.revenue?.current ?? null
              )),
              previous: round2(safeMarginPct(
                incomeExtract?.grossProfit?.previous ?? null,
                incomeExtract?.revenue?.previous ?? null
              ))
            },
            operatingMarginPct: {
              current: round2(safeMarginPct(
                incomeExtract?.operatingProfit?.current ?? null,
                incomeExtract?.revenue?.current ?? null
              )),
              previous: round2(safeMarginPct(
                incomeExtract?.operatingProfit?.previous ?? null,
                incomeExtract?.revenue?.previous ?? null
              ))
            }
          },
          liquidity: {
            currentRatio: {
              current: round2(safeRatio(
                balanceExtract?.currentAssets?.current ?? null,
                balanceExtract?.currentLiabilities?.current ?? null
              )),
              previous: round2(safeRatio(
                balanceExtract?.currentAssets?.previous ?? null,
                balanceExtract?.currentLiabilities?.previous ?? null
              ))
            },
            cashToCurrentLiabilities: {
              current: round2(safeRatio(
                cashFlowExtract?.endingCash?.current ?? null,
                balanceExtract?.currentLiabilities?.current ?? null
              )),
              previous: round2(safeRatio(
                cashFlowExtract?.endingCash?.previous ?? null,
                balanceExtract?.currentLiabilities?.previous ?? null
              ))
            }
          },
          leverage: {
            debtToAssets: {
              current: round2(safeRatio(
                balanceExtract?.totalLiabilities?.current ?? null,
                balanceExtract?.totalAssets?.current ?? null
              )),
              previous: round2(safeRatio(
                balanceExtract?.totalLiabilities?.previous ?? null,
                balanceExtract?.totalAssets?.previous ?? null
              ))
            },
            equityRatio: {
              current: round2(safeRatio(
                balanceExtract?.totalEquity?.current ?? null,
                balanceExtract?.totalAssets?.current ?? null
              )),
              previous: round2(safeRatio(
                balanceExtract?.totalEquity?.previous ?? null,
                balanceExtract?.totalAssets?.previous ?? null
              ))
            },
            debtToEquity: {
              current: round2(safeRatio(
                balanceExtract?.totalLiabilities?.current ?? null,
                balanceExtract?.totalEquity?.current ?? null
              )),
              previous: round2(safeRatio(
                balanceExtract?.totalLiabilities?.previous ?? null,
                balanceExtract?.totalEquity?.previous ?? null
              ))
            }
          }
        };

    /* =========================
       Lightweight summaries
       ========================= */

    const signals = {
      profitability: null,
      liquidity: null,
      leverage: null,
      growth: null
    };

    if (statementProfile === "bank") {
      const netIncomeMargin = ratios?.banking?.netIncomeMarginPct?.current ?? null;
      const financingToDeposits = ratios?.banking?.financingToDeposits?.current ?? null;
      const equityToAssets = ratios?.banking?.equityToAssets?.current ?? null;
      const incomeGrowth = derived?.growth?.netIncomeAfterZakatPct ?? null;

      if (netIncomeMargin !== null) {
        if (netIncomeMargin >= 25) signals.profitability = "strong";
        else if (netIncomeMargin >= 15) signals.profitability = "good";
        else if (netIncomeMargin >= 8) signals.profitability = "moderate";
        else signals.profitability = "weak";
      }

      if (financingToDeposits !== null) {
        if (financingToDeposits <= 0.9) signals.liquidity = "comfortable";
        else if (financingToDeposits <= 1.1) signals.liquidity = "acceptable";
        else signals.liquidity = "tight";
      }

      if (equityToAssets !== null) {
        if (equityToAssets >= 0.12) signals.leverage = "strong_capital";
        else if (equityToAssets >= 0.08) signals.leverage = "acceptable_capital";
        else signals.leverage = "thin_capital";
      }

      if (incomeGrowth !== null) {
        if (incomeGrowth > 15) signals.growth = "strong";
        else if (incomeGrowth > 5) signals.growth = "moderate";
        else if (incomeGrowth > 0) signals.growth = "slow";
        else signals.growth = "negative";
      }
    } else {
      const opMargin = ratios?.profitability?.operatingMarginPct?.current ?? null;
      const currentRatio = ratios?.liquidity?.currentRatio?.current ?? null;
      const debtToAssets = ratios?.leverage?.debtToAssets?.current ?? null;
      const revenueGrowth = derived?.growth?.revenuePct ?? null;

      if (opMargin !== null) {
        if (opMargin >= 15) signals.profitability = "strong";
        else if (opMargin >= 8) signals.profitability = "good";
        else if (opMargin >= 4) signals.profitability = "moderate";
        else signals.profitability = "weak";
      }

      if (currentRatio !== null) {
        if (currentRatio >= 2) signals.liquidity = "strong";
        else if (currentRatio >= 1.2) signals.liquidity = "acceptable";
        else signals.liquidity = "weak";
      }

      if (debtToAssets !== null) {
        if (debtToAssets <= 0.35) signals.leverage = "low";
        else if (debtToAssets <= 0.6) signals.leverage = "moderate";
        else signals.leverage = "high";
      }

      if (revenueGrowth !== null) {
        if (revenueGrowth > 15) signals.growth = "strong";
        else if (revenueGrowth > 5) signals.growth = "moderate";
        else if (revenueGrowth > 0) signals.growth = "slow";
        else signals.growth = "negative";
      }
    }

    const insights = {
      profitability: [],
      liquidity: [],
      leverage: [],
      growth: [],
      summary: []
    };

    if (statementProfile === "bank") {
      pushInsight(insights.summary, "تم اكتشاف الملف كبنك واستخدام منطق استخراج بنكي.");
    } else {
      pushInsight(insights.summary, "تم اكتشاف الملف كشركة تشغيلية واستخدام منطق الاستخراج التقليدي.");
    }

    const executiveSummary = [];
    if (statementProfile === "bank") {
      executiveSummary.push("تم تطبيق ملف تعريف بنكي على القوائم المالية.");
    } else {
      executiveSummary.push("تم تطبيق ملف تعريف شركة تشغيلية على القوائم المالية.");
    }

    const evaluation = {
      strengths: [],
      watchPoints: [],
      opportunities: [],
      risks: []
    };

    const investmentView = {
      businessQuality: {
        signal: null,
        points: []
      },
      financialStability: {
        signal: null,
        points: []
      },
      growthOutlook: {
        signal: null,
        points: []
      },
      cashQuality: {
        signal: null,
        points: []
      },
      overallView: [],
      investmentView: null
    };

    /* =========================
       Meta + response
       ========================= */

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
      extractionStatus: mergeExtractionStatus(statementProfile, incomeExtract, balanceExtract, cashFlowExtract),
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



  
