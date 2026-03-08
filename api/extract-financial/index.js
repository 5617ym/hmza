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

    const getCell = (row, index) => {
      if (!Array.isArray(row)) return "";
      if (index === null || index === undefined) return "";
      return row[index];
    };

    const rowHasNumericValueAt = (row, colIndex) => {
      if (!Array.isArray(row)) return false;
      if (colIndex === null || colIndex === undefined) return false;
      return parseNumberSmart(row[colIndex]) !== null;
    };

    const detectColumns = (table) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];
      const colCount = Number(table?.columnCount) || 0;
      const cols = [];

      for (let i = 0; i < colCount; i++) {
        const c = {
          col: i,
          years: [],
          hasNote: false
        };

        for (let r = 0; r < Math.min(20, rows.length); r++) {
          const cell = norm(rows?.[r]?.[i]);
          const y = findYear(cell);

          if (y) c.years.push(y);
          if (cell.includes("إيضاح") || cell.includes("ايضاح") || cell.includes("note")) {
            c.hasNote = true;
          }
        }

        c.years = [...new Set(c.years)];
        // detect numeric column density
let numericCount = 0;
for (let r = 0; r < rows.length; r++) {
  if (parseNumberSmart(rows[r]?.[i]) !== null) {
    numericCount++;
  }
}
c.numericDensity = numericCount / Math.max(rows.length, 1);
        cols.push(c);
      }

      return cols;
    };

    const pickLatestColumns = (cols) => {

  const numericCols = cols
    .filter(c => !c.hasNote && (c.numericDensity || 0) > 0.2)
    .sort((a,b) => (b.numericDensity || 0) - (a.numericDensity || 0));

  if (numericCols.length < 2) {
    return { latest:null, previous:null, latestYear:null, previousYear:null };
  }

  return {
    latest: numericCols[0],
    previous: numericCols[1],
    latestYear: null,
    previousYear: null
  };

};
      const usable = cols
  .filter((c) => !c.hasNote)
  .sort((a, b) => (b.numericDensity || 0) - (a.numericDensity || 0));
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

    const tableTextBlob = (table) => {
      return norm(JSON.stringify([
        ...(Array.isArray(table?.sample) ? table.sample : []),
        ...(Array.isArray(table?.sampleTail) ? table.sampleTail : [])
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
        current:
          latestCol !== null && latestCol !== undefined
            ? parseNumberSmart(getCell(row, latestCol))
            : null,
        previous:
          previousCol !== null && previousCol !== undefined
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

    const pushUnique = (arr, text) => {
      if (text && !arr.includes(text)) arr.push(text);
    };

    const normalizeKeyArray = (arr) => (Array.isArray(arr) ? arr : []).map((x) => norm(x));

    const findBestRowForNames = (rows, names, latestCol, options = {}) => {
      const normalizedNames = normalizeKeyArray(names);
      const requireNumeric = options.requireNumeric !== false;
      const exactOnly = options.exactOnly === true;
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
          } else if (!exactOnly && s.includes(n)) {
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
        const names = config.names || [];
        const label = config.label || key;
        const match = findBestRowForNames(rows, names, latestCol, {
          exactOnly: config.exactOnly === true,
          requireNumeric: config.requireNumeric !== false,
          usedRowIndexes
        });

        if (match.index >= 0) usedRowIndexes.add(match.index);
        out[key] = makeValueObject(match.row, label, latestCol, previousCol);
      }

      return out;
    };

    /* =========================
       Filters + profiles
       ========================= */

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

      const hitCount = badWords.reduce((acc, w) => acc + (text.includes(norm(w)) ? 1 : 0), 0);
      return hitCount >= 2;
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

    const OPERATING_INCOME_NAMES = {
      revenue: { label: "الإيرادات", names: ["الإيرادات", "الايرادات", "المبيعات", "revenue", "sales"] },
      costOfRevenue: { label: "تكلفة الإيرادات", names: ["تكلفة الإيرادات", "تكلفة الايرادات", "تكلفة المبيعات", "cost of revenue", "cost of sales"] },
      grossProfit: { label: "مجمل الربح", names: ["مجمل الربح", "إجمالي الربح", "gross profit"] },
      operatingProfit: { label: "الربح التشغيلي", names: ["الربح التشغيلي", "الدخل التشغيلي", "ربح التشغيل", "operating profit", "operating income"] }
    };

    const BANK_INCOME_NAMES = {
      incomeFromInvestmentsAndFinancing: {
        label: "الدخل من الاستثمارات والتمويل",
        names: [
          "الدخل من الاستثمارات والتمويل",
          "دخل من الاستثمارات والتمويل",
          "الدخل من التمويل والاستثمارات",
          "صافي الدخل من الاستثمارات والتمويل",
          "صافي الدخل من التمويل والاستثمارات",
          "استثمار، صافي",
          "استثمار , صافي",
          "استثمار،صافي",
          "استثمار صافي",
          "الاستثمار، صافي",
          "الاستثمار صافي",
          "صافي الاستثمار",
          "دخل الاستثمار، صافي",
          "دخل الاستثمار صافي",
          "إيرادات الاستثمار، صافي",
          "إيرادات الاستثمار صافي",
          "استثمارات بالصافي",
          "استثمارات، بالصافي",
          "income from investments and financing",
          "income from financing and investments",
          "net income from investments and financing",
          "investment net",
          "net investment income",
          "investment income net"
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
          "دخل رسوم خدمات",
          "إيرادات الرسوم",
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
          "مصاريف رسوم خدمات",
          "مصروفات رسوم خدمات",
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
          "دخل رسوم خدمات مصرفية، صافي",
          "دخل رسوم خدمات مصرفية صافي",
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
          "إجمالي دخل العمليات التشغيلية",
          "إجمالي دخل العمولات الخاصة",
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
          "رواتب وبدلات الموظفين",
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
          "مصاريف أخرى",
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
          "مصاريف العمليات قبل انخفاض القيمة",
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
          "مخصص خسائر الائتمان المتوقعة",
          "صافي مخصص الانخفاض",
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
          "إجمالي المصروفات التشغيلية",
          "total operating expenses"
        ]
      },

      netOperatingIncome: {
        label: "صافي دخل العمليات",
        names: [
          "صافي دخل العمليات",
          "صافي الدخل من العمليات",
          "الدخل التشغيلي الصافي",
          "صافي الدخل التشغيلي",
          "net operating income"
        ]
      },

      shareOfResultsAssociates: {
        label: "حصة في خسارة/ربح شركة زميلة",
        names: [
          "حصة في خسارة شركة زميلة ومشروع مشترك",
          "حصة في ربح شركة زميلة ومشروع مشترك",
          "حصة من نتائج شركة زميلة",
          "حصة في نتائج شركة زميلة",
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
          "دخل السنة قبل الزكاة والضريبة",
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
          "صافي دخل السنة بعد الزكاة والضريبة",
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
          "نقد وأرصدة لدى البنوك المركزية",
          "النقد والأرصدة لدى البنوك المركزية",
          "أرصدة لدى البنوك المركزية",
          "نقد وأرصدة لدى البنك المركزي",
          "النقد والأرصدة لدى البنك المركزي",
          "cash and balances with central bank",
          "cash and balances with saudi central bank",
          "cash and balances with central banks"
        ]
      },

      balancesWithBanksAndFinancialInstitutions: {
        label: "أرصدة لدى البنوك والمؤسسات المالية الأخرى، صافي",
        names: [
          "أرصدة لدى البنوك والمؤسسات المالية الأخرى، صافي",
          "أرصدة لدى البنوك والمؤسسات المالية الأخرى صافي",
          "أرصدة لدى البنوك والمؤسسات المالية الأخرى بالصافي",
          "ارصدة لدى البنوك والمؤسسات المالية الاخرى",
          "أرصدة لدى البنوك والمؤسسات المالية الأخرى",
          "مطالبات من البنوك والمؤسسات المالية الأخرى، صافي",
          "مطالبات من البنوك والمؤسسات المالية الأخرى صافي",
          "مطالبات من البنوك والمؤسسات المالية الاخرى",
          "مطالبات من البنوك",
          "أرصدة لدى البنوك",
          "balances with banks and other financial institutions",
          "balances with banks",
          "claims on banks and other financial institutions",
          "claims on banks"
        ]
      },

      investmentsAtFVTPL: {
        label: "استثمارات بالقيمة العادلة",
        names: [
          "استثمارات بالقيمة العادلة خلال قائمة الدخل",
          "استثمارات بالقيمة العادلة",
          "استثمارات بالقيمة العادلة من خلال قائمة الدخل",
          "استثمار بالقيمة العادلة",
          "استثمار، صافي",
          "استثمار صافي",
          "استثمارات بالصافي",
          "investments at fair value through income statement",
          "investments at fair value"
        ]
      },

      investmentsAtFVOCI: {
        label: "استثمارات بالقيمة العادلة من خلال الدخل الشامل الآخر",
        names: [
          "استثمارات بالقيمة العادلة من خلال الدخل الشامل الآخر",
          "استثمارات بالقيمة العادلة خلال الدخل الشامل الآخر",
          "استثمارات بالقيمة العادلة عبر الدخل الشامل الآخر",
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
          "استثمارات بالتكلفة المستنفذة",
          "investments at amortized cost",
          "investments at amortised cost"
        ]
      },

      investmentsInAssociates: {
        label: "استثمار في شركات زميلة ومشروع مشترك",
        names: [
          "استثمار في شركات زميلة ومشروع مشترك",
          "استثمار في شركات زميلة",
          "استثمار في شركة زميلة",
          "استثمار في شركة زميلة ومشروع مشترك",
          "investment in associates and joint venture",
          "investment in associate"
        ]
      },

      derivativeAssets: {
        label: "القيمة العادلة الموجبة للمشتقات",
        names: [
          "القيمة العادلة الموجبة للمشتقات",
          "موجودات مشتقات",
          "القيمة العادلة الموجبة للأدوات المالية المشتقة",
          "positive fair value of derivatives",
          "derivative assets"
        ]
      },

      financingNet: {
        label: "تمويل، صافي",
        names: [
          "تمويل، صافي",
          "تمويل , صافي",
          "تمويل،صافي",
          "تمويل صافي",
          "تمويل بالصافي",
          "التمويل، صافي",
          "التمويل , صافي",
          "التمويل صافي",
          "التمويل بالصافي",
          "صافي التمويل",
          "تمويلات، صافي",
          "تمويلات صافي",
          "تمويل",
          "التمويل",
          "تمويل وسلف بالصافي",
          "تمويل وسلف، بالصافي",
          "تمويل وسلف صافي",
          "تمويل وسلف",
          "financing net",
          "net financing",
          "financings net",
          "net financings",
          "financing",
          "financing and advances net",
          "loans and advances net"
        ]
      },

      propertyAndEquipment: {
        label: "ممتلكات ومعدات وموجودات حق استخدام، صافي",
        names: [
          "ممتلكات ومعدات وموجودات حق استخدام، صافي",
          "ممتلكات ومعدات وموجودات حق استخدام صافي",
          "ممتلكات ومعدات صافي",
          "ممتلكات ومعدات",
          "موجودات حق استخدام",
          "ممتلكات ومعدات وموجودات حق الاستخدام والبرمجيات، صافي",
          "property and equipment",
          "right of use assets"
        ]
      },

      otherAssets: {
        label: "موجودات أخرى",
        names: [
          "موجودات أخرى",
          "أصول أخرى",
          "موجودات اخرى",
          "other assets"
        ]
      },

      totalAssets: {
        label: "إجمالي الموجودات",
        names: [
          "إجمالي الموجودات",
          "اجمالي الموجودات",
          "إجمالي الأصول",
          "مجموع الموجودات",
          "total assets"
        ],
        exactOnly: true
      },

      balancesDueToCentralBankAndBanks: {
        label: "أرصدة للبنك المركزي السعودي والبنوك والمؤسسات المالية الأخرى",
        names: [
          "أرصدة للبنك المركزي السعودي والبنوك والمؤسسات المالية الأخرى",
          "ارصدة للبنك المركزي السعودي والبنوك والمؤسسات المالية الاخرى",
          "أرصدة للبنوك، والبنك المركزي والمؤسسات المالية الأخرى",
          "أرصدة للبنوك والبنك المركزي والمؤسسات المالية الأخرى",
          "مطلوبات للبنوك، والبنك المركزي السعودي والمؤسسات المالية الأخرى",
          "مطلوبات للبنوك والبنك المركزي السعودي والمؤسسات المالية الأخرى",
          "مطالبات للبنوك والبنك المركزي السعودي والمؤسسات المالية الأخرى",
          "balances due to central bank and banks",
          "due to banks and central bank",
          "amounts due to banks and central bank"
        ]
      },

      customerDeposits: {
        label: "ودائع العملاء",
        names: [
          "ودائع العملاء",
          "إيداعات العملاء",
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
          "أدوات الدين والتمويلات لأجل",
          "أدوات الدين والتمويلات لاجل",
          "أدوات الدين لأجل",
          "تمويلات لأجل",
          "صكوك وسندات دين مصدرة وقروض لأجل",
          "صكوك وسندات دين مصدرة",
          "قروض لأجل",
          "صكوك حقوق ملكية",
          "debt securities in issue",
          "sukuk issued",
          "certificates of deposit issued",
          "debt instruments and term financing",
          "term financing",
          "equity sukuk"
        ]
      },

      derivativeLiabilities: {
        label: "القيمة العادلة السالبة للمشتقات",
        names: [
          "القيمة العادلة السالبة للمشتقات",
          "مطلوبات مشتقات",
          "القيمة العادلة السالبة للأدوات المالية المشتقة",
          "negative fair value of derivatives",
          "derivative liabilities"
        ]
      },

      leaseLiabilities: {
        label: "التزامات إيجار",
        names: [
          "التزامات إيجار",
          "التزامات الايجار",
          "مطلوبات إيجار",
          "lease liabilities"
        ]
      },

      otherLiabilities: {
        label: "مطلوبات أخرى",
        names: [
          "مطلوبات أخرى",
          "التزامات أخرى",
          "مطلوبات اخرى",
          "other liabilities"
        ]
      },

      totalLiabilities: {
        label: "إجمالي المطلوبات",
        names: [
          "إجمالي المطلوبات",
          "اجمالي المطلوبات",
          "إجمالي الالتزامات",
          "مجموع المطلوبات",
          "total liabilities"
        ],
        exactOnly: true
      },

      shareCapital: {
        label: "رأس المال",
        names: [
          "رأس المال",
          "راس المال",
          "رأس مال",
          "share capital",
          "capital"
        ]
      },

      treasuryShares: {
        label: "أسهم خزينة",
        names: [
          "أسهم خزينة",
          "اسهم خزينة",
          "أسهم الخزينة",
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
          "احتياطيات اخرى",
          "other reserves"
        ]
      },

      retainedEarnings: {
        label: "أرباح مبقاة",
        names: [
          "أرباح مبقاة",
          "ارباح مبقاة",
          "الأرباح المبقاة",
          "retained earnings"
        ]
      },

      equityAttributableToShareholders: {
        label: "حقوق الملكية العائدة لمساهمي المصرف",
        names: [
          "حقوق الملكية العائدة لمساهمي المصرف",
          "حقوق الملكية العائدة للمساهمين",
          "حقوق الملكية العائدة إلى المساهمين في المصرف",
          "حقوق الملكية العائدة إلى الملاك في المصرف",
          "حقوق الملكية العائدة إلى المساهمين",
          "حقوق الملكية العائدة إلى الملاك",
          "حقوق المساهمين العائدة لمساهمي البنك",
          "حقوق المساهمين العائدة إلى مساهمي البنك",
          "حقوق المساهمين العائدة للمساهمين في البنك",
          "حقوق المساهمين العائدة لمساهمي المصرف",
          "equity attributable to shareholders",
          "equity attributable to owners"
        ]
      },

      tier1Sukuk: {
        label: "صكوك الشريحة الأولى",
        names: [
          "صكوك الشريحة الأولى",
          "صكوك الشريحة الاولى",
          "صكوك حقوق ملكية",
          "صكوك ملكية",
          "additional tier 1 sukuk",
          "tier 1 sukuk",
          "equity sukuk"
        ]
      },

      totalEquity: {
        label: "إجمالي حقوق الملكية",
        names: [
          "إجمالي حقوق الملكية",
          "اجمالي حقوق الملكية",
          "إجمالي حقوق المساهمين",
          "إجمالي حقوق الملكية العائدة إلى الملاك",
          "total equity"
        ],
        exactOnly: true
      }
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
       Table scoring
       ========================= */

    const scoreIncomeTable = (table, statementProfile) => {
      const text = tableTextBlob(table);
      if (isLikelyNotesTable(table)) return -100;

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

      return score;
    };

    const scoreBalanceTable = (table, statementProfile) => {
      const text = tableTextBlob(table);
      if (isLikelyNotesTable(table)) return -100;

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
        if (text.includes("صكوك الشريحة الأولى")) score += 16;
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

      return score;
    };

    const scoreCashFlowTable = (table) => {
      const text = tableTextBlob(table);
      if (isLikelyNotesTable(table)) return -100;

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
       Profile
       ========================= */

    const statementProfile = detectStatementProfile(tablesPreview);

    /* =========================
       Income extraction
       ========================= */

    let incomeExtract = {};
    let incomeYears = { current: null, previous: null };

    const incomeTable = pickBestTable(
      tablesPreview,
      (t) => scoreIncomeTable(t, statementProfile)
    );

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

      if (statementProfile === "bank") {
        const usedRowIndexes = new Set();
        incomeExtract = extractFieldsByMap(rows, BANK_INCOME_NAMES, latestCol, previousCol, { usedRowIndexes });

        if (
          isMissingValueObj(incomeExtract.netIncomeAfterZakat) &&
          !isMissingValueObj(incomeExtract.netIncomeBeforeZakat) &&
          !isMissingValueObj(incomeExtract.zakat)
        ) {
          incomeExtract.netIncomeAfterZakat = {
            label: "صافي دخل السنة بعد الزكاة (مشتق)",
            current:
              incomeExtract.netIncomeBeforeZakat.current !== null &&
              incomeExtract.zakat.current !== null
                ? incomeExtract.netIncomeBeforeZakat.current - incomeExtract.zakat.current
                : null,
            previous:
              incomeExtract.netIncomeBeforeZakat.previous !== null &&
              incomeExtract.zakat.previous !== null
                ? incomeExtract.netIncomeBeforeZakat.previous - incomeExtract.zakat.previous
                : null
          };
        }

        if (
          isMissingValueObj(incomeExtract.totalOperatingExpenses) &&
          !isMissingValueObj(incomeExtract.operatingExpensesBeforeImpairment) &&
          !isMissingValueObj(incomeExtract.netImpairmentChargeForFinancing)
        ) {
          incomeExtract.totalOperatingExpenses = {
            label: "إجمالي مصاريف العمليات (مشتق)",
            current:
              incomeExtract.operatingExpensesBeforeImpairment.current !== null &&
              incomeExtract.netImpairmentChargeForFinancing.current !== null
                ? incomeExtract.operatingExpensesBeforeImpairment.current + incomeExtract.netImpairmentChargeForFinancing.current
                : null,
            previous:
              incomeExtract.operatingExpensesBeforeImpairment.previous !== null &&
              incomeExtract.netImpairmentChargeForFinancing.previous !== null
                ? incomeExtract.operatingExpensesBeforeImpairment.previous + incomeExtract.netImpairmentChargeForFinancing.previous
                : null
          };
        }

        if (
          isMissingValueObj(incomeExtract.netOperatingIncome) &&
          !isMissingValueObj(incomeExtract.totalOperatingIncome) &&
          !isMissingValueObj(incomeExtract.totalOperatingExpenses)
        ) {
          incomeExtract.netOperatingIncome = {
            label: "صافي دخل العمليات (مشتق)",
            current:
              incomeExtract.totalOperatingIncome.current !== null &&
              incomeExtract.totalOperatingExpenses.current !== null
                ? incomeExtract.totalOperatingIncome.current - incomeExtract.totalOperatingExpenses.current
                : null,
            previous:
              incomeExtract.totalOperatingIncome.previous !== null &&
              incomeExtract.totalOperatingExpenses.previous !== null
                ? incomeExtract.totalOperatingIncome.previous - incomeExtract.totalOperatingExpenses.previous
                : null
          };
        }

        if (
          isMissingValueObj(incomeExtract.totalOperatingIncome) &&
          !isMissingValueObj(incomeExtract.incomeFromInvestmentsAndFinancing) &&
          !isMissingValueObj(incomeExtract.feeIncomeNet)
        ) {
          incomeExtract.totalOperatingIncome = {
            label: "إجمالي دخل العمليات (مشتق جزئي)",
            current:
              incomeExtract.incomeFromInvestmentsAndFinancing.current !== null &&
              incomeExtract.feeIncomeNet.current !== null
                ? incomeExtract.incomeFromInvestmentsAndFinancing.current + incomeExtract.feeIncomeNet.current
                : null,
            previous:
              incomeExtract.incomeFromInvestmentsAndFinancing.previous !== null &&
              incomeExtract.feeIncomeNet.previous !== null
                ? incomeExtract.incomeFromInvestmentsAndFinancing.previous + incomeExtract.feeIncomeNet.previous
                : null
          };
        }
      } else {
        const usedRowIndexes = new Set();
        incomeExtract = extractFieldsByMap(rows, OPERATING_INCOME_NAMES, latestCol, previousCol, { usedRowIndexes });
      }
    }

    /* =========================
       Balance extraction
       ========================= */

    let balanceExtract = {};
    let balanceYears = { current: null, previous: null };

    const balanceTable = pickBestTable(
      tablesPreview,
      (t) => scoreBalanceTable(t, statementProfile)
    );

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
        const usedRowIndexes = new Set();
        balanceExtract = extractFieldsByMap(rows, BANK_BALANCE_NAMES, latestCol, previousCol, { usedRowIndexes });

// fallback: إذا لم يتم استخراج شيء من جدول المركز المالي
if (
  isMissingValueObj(balanceExtract.totalAssets) &&
  isMissingValueObj(balanceExtract.customerDeposits) &&
  isMissingValueObj(balanceExtract.financingNet)
) {
  for (const t of tablesPreview) {
    const rowsAlt = mergeTableRows(t);
    if (!rowsAlt.length) continue;

    const colsAlt = detectColumns(t);
    const pickedAlt = pickLatestColumns(colsAlt);

    const latestAlt = pickedAlt.latest?.col ?? null;
    const prevAlt = pickedAlt.previous?.col ?? null;

    const usedAlt = new Set();

    const altExtract = extractFieldsByMap(
      rowsAlt,
      BANK_BALANCE_NAMES,
      latestAlt,
      prevAlt,
      { usedRowIndexes: usedAlt }
    );

    if (
      hasCurrent(altExtract.totalAssets) ||
      hasCurrent(altExtract.customerDeposits) ||
      hasCurrent(altExtract.financingNet)
    ) {
      balanceExtract = altExtract;
      break;
    }
  }
}

if (isMissingValueObj(balanceExtract.totalAssets)) {
  const altTotalAssets = findBestRowForNames(
    rows,
    ["إجمالي المطلوبات وحقوق الملكية", "اجمالي المطلوبات وحقوق الملكية", "total liabilities and equity"],
    latestCol,
    { usedRowIndexes }
  );

  if (altTotalAssets.index >= 0) {
    usedRowIndexes.add(altTotalAssets.index);
    balanceExtract.totalAssets = makeValueObject(
      altTotalAssets.row,
      "إجمالي الموجودات",
      latestCol,
      previousCol
    );
  }
}

        if (
          isMissingValueObj(balanceExtract.totalEquity) &&
          !isMissingValueObj(balanceExtract.equityAttributableToShareholders) &&
          !isMissingValueObj(balanceExtract.tier1Sukuk)
        ) {
          balanceExtract.totalEquity = {
            label: "إجمالي حقوق الملكية (مشتق)",
            current:
              balanceExtract.equityAttributableToShareholders.current !== null &&
              balanceExtract.tier1Sukuk.current !== null
                ? balanceExtract.equityAttributableToShareholders.current + balanceExtract.tier1Sukuk.current
                : null,
            previous:
              balanceExtract.equityAttributableToShareholders.previous !== null &&
              balanceExtract.tier1Sukuk.previous !== null
                ? balanceExtract.equityAttributableToShareholders.previous + balanceExtract.tier1Sukuk.previous
                : null
          };
        }

        if (
          isMissingValueObj(balanceExtract.totalLiabilities) &&
          !isMissingValueObj(balanceExtract.totalAssets) &&
          !isMissingValueObj(balanceExtract.totalEquity)
        ) {
          balanceExtract.totalLiabilities = {
            label: "إجمالي المطلوبات (مشتق)",
            current:
              balanceExtract.totalAssets.current !== null &&
              balanceExtract.totalEquity.current !== null
                ? balanceExtract.totalAssets.current - balanceExtract.totalEquity.current
                : null,
            previous:
              balanceExtract.totalAssets.previous !== null &&
              balanceExtract.totalEquity.previous !== null
                ? balanceExtract.totalAssets.previous - balanceExtract.totalEquity.previous
                : null
          };
        }
      } else {
        const usedRowIndexes = new Set();

        const nonCurrentAssetsMatch = findBestRowForNames(
          rows,
          ["إجمالي الموجودات غير المتداولة", "إجمالي الأصول غير المتداولة"],
          latestCol,
          { exactOnly: true, usedRowIndexes }
        );
        if (nonCurrentAssetsMatch.index >= 0) usedRowIndexes.add(nonCurrentAssetsMatch.index);

        balanceExtract.nonCurrentAssets = makeValueObject(
          nonCurrentAssetsMatch.row,
          "الأصول غير المتداولة",
          latestCol,
          previousCol
        );

        const totalAssetsMatch = findBestRowForNames(
          rows,
          ["إجمالي الموجودات", "إجمالي الأصول", "مجموع الأصول"],
          latestCol,
          { exactOnly: true, usedRowIndexes }
        );
        if (totalAssetsMatch.index >= 0) usedRowIndexes.add(totalAssetsMatch.index);

        balanceExtract.totalAssets = makeValueObject(
          totalAssetsMatch.row,
          "إجمالي الأصول",
          latestCol,
          previousCol
        );

        const totalLiabilitiesMatch = findBestRowForNames(
          rows,
          ["إجمالي المطلوبات", "إجمالي الالتزامات", "مجموع المطلوبات", "مجموع الالتزامات"],
          latestCol,
          { exactOnly: true, usedRowIndexes }
        );
        if (totalLiabilitiesMatch.index >= 0) usedRowIndexes.add(totalLiabilitiesMatch.index);

        balanceExtract.totalLiabilities = makeValueObject(
          totalLiabilitiesMatch.row,
          "إجمالي المطلوبات",
          latestCol,
          previousCol
        );

        const currentLiabilitiesMatch = findBestRowForNames(
          rows,
          ["إجمالي المطلوبات المتداولة", "إجمالي الالتزامات المتداولة"],
          latestCol,
          { exactOnly: true, usedRowIndexes }
        );
        if (currentLiabilitiesMatch.index >= 0) usedRowIndexes.add(currentLiabilitiesMatch.index);

        balanceExtract.currentLiabilities = makeValueObject(
          currentLiabilitiesMatch.row,
          "المطلوبات المتداولة",
          latestCol,
          previousCol
        );

        const nonCurrentLiabilitiesMatch = findBestRowForNames(
          rows,
          ["إجمالي المطلوبات غير المتداولة", "إجمالي الالتزامات غير المتداولة"],
          latestCol,
          { exactOnly: true, usedRowIndexes }
        );
        if (nonCurrentLiabilitiesMatch.index >= 0) usedRowIndexes.add(nonCurrentLiabilitiesMatch.index);

        balanceExtract.nonCurrentLiabilities = makeValueObject(
          nonCurrentLiabilitiesMatch.row,
          "المطلوبات غير المتداولة",
          latestCol,
          previousCol
        );

        const totalEquityMatch = findBestRowForNames(
          rows,
          ["إجمالي حقوق الملكية", "إجمالي حقوق المساهمين", "مجموع حقوق الملكية"],
          latestCol,
          { exactOnly: true, usedRowIndexes }
        );
        if (totalEquityMatch.index >= 0) usedRowIndexes.add(totalEquityMatch.index);

        balanceExtract.totalEquity = makeValueObject(
          totalEquityMatch.row,
          "إجمالي حقوق الملكية",
          latestCol,
          previousCol
        );

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

        if (isMissingValueObj(balanceExtract.nonCurrentLiabilities)) {
          if (
            balanceExtract.totalLiabilities?.current !== null &&
            balanceExtract.currentLiabilities?.current !== null
          ) {
            balanceExtract.nonCurrentLiabilities = {
              label: "المطلوبات غير المتداولة (مشتق)",
              current: balanceExtract.totalLiabilities.current - balanceExtract.currentLiabilities.current,
              previous:
                balanceExtract.totalLiabilities?.previous !== null &&
                balanceExtract.currentLiabilities?.previous !== null
                  ? balanceExtract.totalLiabilities.previous - balanceExtract.currentLiabilities.previous
                  : null
            };
          }
        }

        if (isMissingValueObj(balanceExtract.totalAssets)) {
          if (
            balanceExtract.totalLiabilities?.current !== null &&
            balanceExtract.totalEquity?.current !== null
          ) {
            balanceExtract.totalAssets = {
              label: "إجمالي الأصول (مشتق)",
              current: balanceExtract.totalLiabilities.current + balanceExtract.totalEquity.current,
              previous:
                balanceExtract.totalLiabilities?.previous !== null &&
                balanceExtract.totalEquity?.previous !== null
                  ? balanceExtract.totalLiabilities.previous + balanceExtract.totalEquity.previous
                  : null
            };
          }
        }
      }
    }

    /* =========================
       Cash flow extraction
       ========================= */

    const detectCashTriplet = (rows, latestCol, previousCol) => {
      if (latestCol === null || previousCol === null) return null;

      const numericRows = rows.filter((r) =>
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

    let cashFlowExtract = {};
    let cashFlowYears = { current: null, previous: null };

    const cashTable = pickBestTable(tablesPreview, scoreCashFlowTable);

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

      const endingCashNames = [
        "النقد وما في حكمه في نهاية السنة",
        "النقد والنقد المعادل في نهاية السنة",
        "النقد وما في حكمه في نهاية الفترة",
        "النقد والنقد المعادل في نهاية الفترة"
      ];

      const beginningCashNames = [
        "النقد وما في حكمه في بداية السنة",
        "النقد والنقد المعادل في بداية السنة",
        "النقد وما في حكمه في بداية الفترة",
        "النقد والنقد المعادل في بداية الفترة"
      ];

      const endingCashMatch = findBestRowForNames(rows, endingCashNames, latestCol);
      const beginningCashMatch = findBestRowForNames(rows, beginningCashNames, latestCol);

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
      completeness:
        statementProfile === "bank"
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
       Derived + ratios
       ========================= */

    const derived =
      statementProfile === "bank"
        ? {
            detectedYears: {
              incomeStatement: incomeYears,
              balanceSheet: balanceYears,
              cashFlow: cashFlowYears
            },
            growth: {
              totalOperatingIncomePct: round2(safePercentChange(incomeExtract?.totalOperatingIncome?.current ?? null, incomeExtract?.totalOperatingIncome?.previous ?? null)),
              netOperatingIncomePct: round2(safePercentChange(incomeExtract?.netOperatingIncome?.current ?? null, incomeExtract?.netOperatingIncome?.previous ?? null)),
              netIncomeAfterZakatPct: round2(safePercentChange(incomeExtract?.netIncomeAfterZakat?.current ?? null, incomeExtract?.netIncomeAfterZakat?.previous ?? null)),
              financingNetPct: round2(safePercentChange(balanceExtract?.financingNet?.current ?? null, balanceExtract?.financingNet?.previous ?? null)),
              customerDepositsPct: round2(safePercentChange(balanceExtract?.customerDeposits?.current ?? null, balanceExtract?.customerDeposits?.previous ?? null)),
              totalAssetsPct: round2(safePercentChange(balanceExtract?.totalAssets?.current ?? null, balanceExtract?.totalAssets?.previous ?? null)),
              totalEquityPct: round2(safePercentChange(balanceExtract?.totalEquity?.current ?? null, balanceExtract?.totalEquity?.previous ?? null)),
              endingCashPct: round2(safePercentChange(cashFlowExtract?.endingCash?.current ?? null, cashFlowExtract?.endingCash?.previous ?? null))
            }
          }
        : {
            detectedYears: {
              incomeStatement: incomeYears,
              balanceSheet: balanceYears,
              cashFlow: cashFlowYears
            },
            growth: {
              revenuePct: round2(safePercentChange(incomeExtract?.revenue?.current ?? null, incomeExtract?.revenue?.previous ?? null)),
              grossProfitPct: round2(safePercentChange(incomeExtract?.grossProfit?.current ?? null, incomeExtract?.grossProfit?.previous ?? null)),
              operatingProfitPct: round2(safePercentChange(incomeExtract?.operatingProfit?.current ?? null, incomeExtract?.operatingProfit?.previous ?? null)),
              totalAssetsPct: round2(safePercentChange(balanceExtract?.totalAssets?.current ?? null, balanceExtract?.totalAssets?.previous ?? null)),
              totalEquityPct: round2(safePercentChange(balanceExtract?.totalEquity?.current ?? null, balanceExtract?.totalEquity?.previous ?? null)),
              endingCashPct: round2(safePercentChange(cashFlowExtract?.endingCash?.current ?? null, cashFlowExtract?.endingCash?.previous ?? null))
            }
          };

    const ratios =
      statementProfile === "bank"
        ? {
            banking: {
              financingToDeposits: {
                current: round2(safeRatio(balanceExtract?.financingNet?.current ?? null, balanceExtract?.customerDeposits?.current ?? null)),
                previous: round2(safeRatio(balanceExtract?.financingNet?.previous ?? null, balanceExtract?.customerDeposits?.previous ?? null))
              },
              equityToAssets: {
                current: round2(safeRatio(balanceExtract?.totalEquity?.current ?? null, balanceExtract?.totalAssets?.current ?? null)),
                previous: round2(safeRatio(balanceExtract?.totalEquity?.previous ?? null, balanceExtract?.totalAssets?.previous ?? null))
              },
              depositsToAssets: {
                current: round2(safeRatio(balanceExtract?.customerDeposits?.current ?? null, balanceExtract?.totalAssets?.current ?? null)),
                previous: round2(safeRatio(balanceExtract?.customerDeposits?.previous ?? null, balanceExtract?.totalAssets?.previous ?? null))
              },
              cashToDeposits: {
                current: round2(safeRatio(cashFlowExtract?.endingCash?.current ?? null, balanceExtract?.customerDeposits?.current ?? null)),
                previous: round2(safeRatio(cashFlowExtract?.endingCash?.previous ?? null, balanceExtract?.customerDeposits?.previous ?? null))
              },
              netOperatingIncomeMarginPct: {
                current: round2(safeMarginPct(incomeExtract?.netOperatingIncome?.current ?? null, incomeExtract?.totalOperatingIncome?.current ?? null)),
                previous: round2(safeMarginPct(incomeExtract?.netOperatingIncome?.previous ?? null, incomeExtract?.totalOperatingIncome?.previous ?? null))
              },
              netIncomeMarginPct: {
                current: round2(safeMarginPct(incomeExtract?.netIncomeAfterZakat?.current ?? null, incomeExtract?.totalOperatingIncome?.current ?? null)),
                previous: round2(safeMarginPct(incomeExtract?.netIncomeAfterZakat?.previous ?? null, incomeExtract?.totalOperatingIncome?.previous ?? null))
              }
            }
          }
        : {
            profitability: {
              grossMarginPct: {
                current: round2(safeMarginPct(incomeExtract?.grossProfit?.current ?? null, incomeExtract?.revenue?.current ?? null)),
                previous: round2(safeMarginPct(incomeExtract?.grossProfit?.previous ?? null, incomeExtract?.revenue?.previous ?? null))
              },
              operatingMarginPct: {
                current: round2(safeMarginPct(incomeExtract?.operatingProfit?.current ?? null, incomeExtract?.revenue?.current ?? null)),
                previous: round2(safeMarginPct(incomeExtract?.operatingProfit?.previous ?? null, incomeExtract?.revenue?.previous ?? null))
              }
            },
            liquidity: {
              currentRatio: {
                current: round2(safeRatio(balanceExtract?.currentAssets?.current ?? null, balanceExtract?.currentLiabilities?.current ?? null)),
                previous: round2(safeRatio(balanceExtract?.currentAssets?.previous ?? null, balanceExtract?.currentLiabilities?.previous ?? null))
              },
              cashToCurrentLiabilities: {
                current: round2(safeRatio(cashFlowExtract?.endingCash?.current ?? null, balanceExtract?.currentLiabilities?.current ?? null)),
                previous: round2(safeRatio(cashFlowExtract?.endingCash?.previous ?? null, balanceExtract?.currentLiabilities?.previous ?? null))
              }
            },
            leverage: {
              debtToAssets: {
                current: round2(safeRatio(balanceExtract?.totalLiabilities?.current ?? null, balanceExtract?.totalAssets?.current ?? null)),
                previous: round2(safeRatio(balanceExtract?.totalLiabilities?.previous ?? null, balanceExtract?.totalAssets?.previous ?? null))
              },
              equityRatio: {
                current: round2(safeRatio(balanceExtract?.totalEquity?.current ?? null, balanceExtract?.totalAssets?.current ?? null)),
                previous: round2(safeRatio(balanceExtract?.totalEquity?.previous ?? null, balanceExtract?.totalAssets?.previous ?? null))
              },
              debtToEquity: {
                current: round2(safeRatio(balanceExtract?.totalLiabilities?.current ?? null, balanceExtract?.totalEquity?.current ?? null)),
                previous: round2(safeRatio(balanceExtract?.totalLiabilities?.previous ?? null, balanceExtract?.totalEquity?.previous ?? null))
              }
            }
          };

    /* =========================
       Signals + narrative
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

    if (statementProfile === "bank") {
      pushUnique(insights.summary, "تم اكتشاف الملف كبنك واستخدام منطق استخراج بنكي.");
      pushUnique(executiveSummary, "تم تطبيق ملف تعريف بنكي على القوائم المالية.");

      if (signals.profitability === "strong" || signals.profitability === "good") {
        pushUnique(evaluation.strengths, "الربحية البنكية تبدو جيدة نسبيًا.");
      }
      if (signals.liquidity === "tight") {
        pushUnique(evaluation.watchPoints, "نسبة التمويل إلى الودائع مرتفعة نسبيًا وتحتاج متابعة.");
      }
      if (signals.leverage === "thin_capital") {
        pushUnique(evaluation.risks, "القاعدة الرأسمالية تبدو أضعف نسبيًا وتستحق الحذر.");
      }

      investmentView.businessQuality.signal = signals.profitability;
      investmentView.financialStability.signal = signals.leverage;
      investmentView.growthOutlook.signal = signals.growth;
      investmentView.cashQuality.signal = hasCurrent(cashFlowExtract?.endingCash) ? "available" : null;

      if (signals.profitability === "strong" || signals.profitability === "good") {
        pushUnique(investmentView.overallView, "الصورة الاستثمارية الأولية للبنك تميل للإيجابية.");
        investmentView.investmentView = "positive";
      } else if (signals.profitability === "weak" || signals.leverage === "thin_capital") {
        pushUnique(investmentView.overallView, "الصورة الاستثمارية الحالية تميل للحذر.");
        investmentView.investmentView = "cautious";
      } else {
        pushUnique(investmentView.overallView, "القراءة الاستثمارية الأولية للبنك متوازنة.");
        investmentView.investmentView = "neutral";
      }
    } else {
      pushUnique(insights.summary, "تم اكتشاف الملف كشركة تشغيلية واستخدام منطق الاستخراج التقليدي.");
      pushUnique(executiveSummary, "تم تطبيق ملف تعريف شركة تشغيلية على القوائم المالية.");

      if (signals.liquidity === "strong") {
        pushUnique(evaluation.strengths, "السيولة الجارية تبدو قوية.");
      }
      if (signals.profitability === "weak") {
        pushUnique(evaluation.watchPoints, "الربحية التشغيلية ضعيفة نسبيًا.");
      }
      if (signals.leverage === "high") {
        pushUnique(evaluation.risks, "الاعتماد على المطلوبات مرتفع نسبيًا.");
      }

      investmentView.businessQuality.signal = signals.profitability;
      investmentView.financialStability.signal = signals.leverage;
      investmentView.growthOutlook.signal = signals.growth;
      investmentView.cashQuality.signal = hasCurrent(cashFlowExtract?.endingCash) ? "available" : null;

      if (signals.profitability === "strong" && signals.leverage !== "high") {
        pushUnique(investmentView.overallView, "الصورة الاستثمارية الأولية تبدو إيجابية.");
        investmentView.investmentView = "positive";
      } else if (signals.profitability === "weak" || signals.leverage === "high") {
        pushUnique(investmentView.overallView, "الصورة الاستثمارية الحالية تميل للحذر.");
        investmentView.investmentView = "cautious";
      } else {
        pushUnique(investmentView.overallView, "القراءة الاستثمارية الأولية متوازنة.");
        investmentView.investmentView = "neutral";
      }
    }

    /* =========================
       Meta
       ========================= */

    const extractionStatus =
      statementProfile === "bank"
        ? {
            incomeStatementLite: hasCurrent(incomeExtract?.totalOperatingIncome) || hasCurrent(incomeExtract?.netIncomeAfterZakat),
            balanceSheetLite: hasCurrent(balanceExtract?.totalAssets) || hasCurrent(balanceExtract?.customerDeposits),
            cashFlowLite: hasCurrent(cashFlowExtract?.endingCash)
          }
        : {
            incomeStatementLite: hasCurrent(incomeExtract?.revenue),
            balanceSheetLite: hasCurrent(balanceExtract?.totalAssets),
            cashFlowLite: hasCurrent(cashFlowExtract?.endingCash)
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
