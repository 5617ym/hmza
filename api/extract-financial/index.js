// api/extract-financial/index.js
module.exports = async function (context, req) {
  const send = (status, payload) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: payload,
    };
  };

  try {
    const body = req.body || {};
    const normalized = body.normalized || null;
    const period = String(body.period || "annual").toLowerCase();
    const compare = String(body.compare || "none").toLowerCase();
    const fileName = body.fileName || "unknown.pdf";

    // ✅ لا نحتاج blobUrl هنا
    if (!normalized || !normalized.tablesPreview || !Array.isArray(normalized.tablesPreview)) {
      return send(400, {
        ok: false,
        error: "Missing normalized.tablesPreview in request body",
        hint: "Send { normalized: { tablesPreview: [...] } } from /api/analyze output",
      });
    }

    // -----------------------------
    // Helpers
    // -----------------------------
    const norm = (s) => {
      s = String(s || "")
        .replace(/\u0640/g, "") // tatweel
        .replace(/[^\S\r\n]+/g, " ")
        .trim()
        .toLowerCase();

      // توحيد بعض الحروف
      s = s
        .replace(/[أإآ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه");

      return s;
    };

    const toLatinDigits = (s) => {
      return String(s || "")
        .replace(/[٠۰]/g, "0")
        .replace(/[١۱]/g, "1")
        .replace(/[٢۲]/g, "2")
        .replace(/[٣۳]/g, "3")
        .replace(/[٤۴]/g, "4")
        .replace(/[٥۵]/g, "5")
        .replace(/[٦۶]/g, "6")
        .replace(/[٧۷]/g, "7")
        .replace(/[٨۸]/g, "8")
        .replace(/[٩۹]/g, "9");
    };

    const parseNumber = (v) => {
      let s = String(v ?? "").trim();
      if (!s) return null;

      // حول الأرقام العربية
      s = toLatinDigits(s);

      // أقواس = سالب
      const neg = /^\(.*\)$/.test(s);
      s = s.replace(/^\(|\)$/g, "");

      // إزالة عملات/مسافات
      s = s.replace(/[^\d.,\-]/g, "");

      // حالات مثل ٢٫٢١٨,٦٦٢٫٧٣٥ => 2,218,662.735 أو العكس
      // نحاول فهم الفواصل:
      // - إذا فيه "," و ".": نفترض "," آلاف و "." عشرية
      // - إذا فقط ",": إذا تكرر كثير => آلاف، إذا مرة واحدة وقد تكون عشرية
      // - إذا فقط ".": نفس المنطق
      const hasComma = s.includes(",");
      const hasDot = s.includes(".");

      if (hasComma && hasDot) {
        // remove thousands commas
        s = s.replace(/,/g, "");
      } else if (hasComma && !hasDot) {
        // لو أكثر من فاصلة => آلاف
        const commaCount = (s.match(/,/g) || []).length;
        if (commaCount > 1) s = s.replace(/,/g, "");
        else {
          // فاصلة واحدة: إذا بعد الفاصلة 3 أرقام غالباً آلاف، وإلا عشرية
          const parts = s.split(",");
          if (parts[1] && parts[1].length === 3) s = parts.join("");
          else s = parts[0] + "." + (parts[1] || "");
        }
      } else if (!hasComma && hasDot) {
        const dotCount = (s.match(/\./g) || []).length;
        if (dotCount > 1) s = s.replace(/\./g, "");
        // else keep dot as decimal
      }

      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return neg ? -n : n;
    };

    const flattenRows = (t) => {
      const head = Array.isArray(t.sample) ? t.sample : [];
      const tail = Array.isArray(t.sampleTail) ? t.sampleTail : [];
      return [...head, ...tail].map((r) => (Array.isArray(r) ? r : []));
    };

    const joinTableText = (rows) => rows.map((r) => r.join(" | ")).join("\n");

    const findYearColumns = (rows) => {
      const yearHits = { y2024: {}, y2023: {} };

      const hit = (map, c) => (map[c] = (map[c] || 0) + 1);

      for (const r of rows) {
        for (let c = 0; c < r.length; c++) {
          const cell = toLatinDigits(String(r[c] || ""));
          if (cell.includes("2024")) hit(yearHits.y2024, c);
          if (cell.includes("2023")) hit(yearHits.y2023, c);
        }
      }

      const pickMaxKey = (obj) => {
        let best = null;
        let bestV = 0;
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (v > bestV) {
            bestV = v;
            best = Number(k);
          }
        }
        return best;
      };

      return {
        col2024: pickMaxKey(yearHits.y2024),
        col2023: pickMaxKey(yearHits.y2023),
      };
    };

    // -----------------------------
    // Balance sheet table scoring
    // -----------------------------
    const scoreBalanceTable = (t) => {
      const rows = flattenRows(t);
      const joined = norm(joinTableText(rows));

      const strong = [
        "قائمة المركز المالي",
        "قائمة الوضع المالي",
        "statement of financial position",
        "الموجودات",
        "المطلوبات",
        "حقوق الملكيه",
        "حقوق الملكية",
      ];

      const support = [
        "الموجودات غير المتداوله",
        "الموجودات المتداوله",
        "المطلوبات غير المتداوله",
        "المطلوبات المتداوله",
        "اجمالي الموجودات",
        "اجمالي المطلوبات",
        "اجمالي حقوق الملكيه",
      ];

      let score = 0;
      for (const k of strong) if (joined.includes(norm(k))) score += 20;
      for (const k of support) if (joined.includes(norm(k))) score += 6;

      // وجود الثلاثة معاً يعطي تعزيز
      if (joined.includes(norm("الموجودات")) && joined.includes(norm("المطلوبات")) && joined.includes(norm("حقوق"))) {
        score += 10;
      }

      // لو الجدول صغير جداً غالباً ليس قائمة مركز مالي
      if (Number(t.rowCount || 0) < 8) score -= 20;

      return score;
    };

    const tables = normalized.tablesPreview;

    const candidates = tables
      .map((t, idx) => ({
        index: typeof t?.index !== "undefined" ? t.index : idx,
        score: scoreBalanceTable(t),
        pageNumber: t.pageNumber ?? null,
        rowCount: t.rowCount ?? null,
        columnCount: t.columnCount ?? null,
        hasTail: Array.isArray(t.sampleTail) && t.sampleTail.length > 0,
        snippet: (() => {
          const rows = flattenRows(t);
          const first = rows.slice(0, 3).map((r) => r.join(" | ")).join(" / ");
          return first.slice(0, 160);
        })(),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    const best = candidates[0] || null;
    const bestTable =
      best ? tables.find((t, idx) => (typeof t?.index !== "undefined" ? t.index : idx) === best.index) : null;

    if (!bestTable || (best?.score ?? 0) < 20) {
      return send(200, {
        ok: true,
        fileName,
        period,
        compare,
        balancePickInfo: { candidates, picked: null, reason: "No strong balance sheet table detected" },
        balanceSheetLite: {
          totalAssets: null,
          currentAssets: null,
          nonCurrentAssets: null,
          totalLiabilities: null,
          currentLiabilities: null,
          nonCurrentLiabilities: null,
          totalEquity: null,
        },
      });
    }

    const rows = flattenRows(bestTable);
    const { col2024, col2023 } = findYearColumns(rows);

    // -----------------------------
    // Row matching (Totals)
    // -----------------------------
    const findRowByName = (needleList, excludeList = []) => {
      const ex = excludeList.map(norm);
      const nd = needleList.map(norm);

      for (const r of rows) {
        const rowText = norm(r.join(" "));
        if (!rowText) continue;

        // استبعاد كلمات
        if (ex.some((x) => x && rowText.includes(x))) continue;

        // لازم يطابق أحد المطلوب
        if (nd.some((n) => n && rowText.includes(n))) {
          return r;
        }
      }
      return null;
    };

    const readValue = (row, col) => {
      if (!row || col == null) return null;
      return parseNumber(row[col]);
    };

    const pickTwoNumbersFallback = (row) => {
      if (!row) return { v2024: null, v2023: null };
      const nums = row
        .map((c) => parseNumber(c))
        .filter((x) => typeof x === "number" && Number.isFinite(x));

      // لو لقينا رقمين نرجّح أنهم سنتين
      if (nums.length >= 2) return { v2024: nums[0], v2023: nums[1] };
      if (nums.length === 1) return { v2024: nums[0], v2023: null };
      return { v2024: null, v2023: null };
    };

    const extractYearPair = (row) => {
      // الأفضل: اعتماد أعمدة السنة
      if (col2024 != null || col2023 != null) {
        const v2024 = readValue(row, col2024);
        const v2023 = readValue(row, col2023);
        // إذا فشل واحد، جرّب fallback
        if (v2024 == null && v2023 == null) return pickTwoNumbersFallback(row);
        return { v2024, v2023 };
      }
      return pickTwoNumbersFallback(row);
    };

    // ✅ أسماء الإجماليات كما تظهر في قائمتك (مع استبعاد لمنع الالتقاط الخاطئ)
    const totalAssetsRow = findRowByName(
      ["اجمالي الموجودات", "إجمالي الموجودات", "مجموع الموجودات", "Total assets"],
      ["غير المتداوله", "غير المتداولة", "المتداوله", "المتداولة"]
    );

    const currentAssetsRow = findRowByName(
      ["اجمالي الموجودات المتداوله", "إجمالي الموجودات المتداولة", "Total current assets"],
      []
    );

    const nonCurrentAssetsRow = findRowByName(
      ["اجمالي الموجودات غير المتداوله", "إجمالي الموجودات غير المتداولة", "Non-current assets total", "Total non-current assets"],
      []
    );

    const totalLiabilitiesRow = findRowByName(
      ["اجمالي المطلوبات", "إجمالي المطلوبات", "Total liabilities"],
      ["غير المتداوله", "غير المتداولة", "المتداوله", "المتداولة"]
    );

    const currentLiabilitiesRow = findRowByName(
      ["اجمالي المطلوبات المتداوله", "إجمالي المطلوبات المتداولة", "Total current liabilities"],
      []
    );

    const nonCurrentLiabilitiesRow = findRowByName(
      ["اجمالي المطلوبات غير المتداوله", "إجمالي المطلوبات غير المتداولة", "Total non-current liabilities", "Non-current liabilities total"],
      []
    );

    const totalEquityRow = findRowByName(
      ["اجمالي حقوق الملكيه", "إجمالي حقوق الملكية", "Total equity"],
      ["العائده لمساهمي", "غير المسيطره", "غير المسيطرة"] // نستبعد التفصيل ونأخذ الإجمالي
    );

    const a = extractYearPair(totalAssetsRow);
    const ca = extractYearPair(currentAssetsRow);
    const nca = extractYearPair(nonCurrentAssetsRow);
    const l = extractYearPair(totalLiabilitiesRow);
    const cl = extractYearPair(currentLiabilitiesRow);
    const ncl = extractYearPair(nonCurrentLiabilitiesRow);
    const e = extractYearPair(totalEquityRow);

    const balanceSheetLite = {
      totalAssets: a.v2024 ?? null,
      currentAssets: ca.v2024 ?? null,
      nonCurrentAssets: nca.v2024 ?? null,
      totalLiabilities: l.v2024 ?? null,
      currentLiabilities: cl.v2024 ?? null,
      nonCurrentLiabilities: ncl.v2024 ?? null,
      totalEquity: e.v2024 ?? null,
    };

    return send(200, {
      ok: true,
      fileName,
      period,
      compare,
      balancePickInfo: {
        candidates,
        picked: {
          index: best.index,
          score: best.score,
          pageNumber: best.pageNumber,
          rowCount: best.rowCount,
          columnCount: best.columnCount,
          col2024,
          col2023,
        },
        matchedRows: {
          totalAssetsRow: totalAssetsRow ? totalAssetsRow.join(" | ").slice(0, 220) : null,
          currentAssetsRow: currentAssetsRow ? currentAssetsRow.join(" | ").slice(0, 220) : null,
          nonCurrentAssetsRow: nonCurrentAssetsRow ? nonCurrentAssetsRow.join(" | ").slice(0, 220) : null,
          totalLiabilitiesRow: totalLiabilitiesRow ? totalLiabilitiesRow.join(" | ").slice(0, 220) : null,
          currentLiabilitiesRow: currentLiabilitiesRow ? currentLiabilitiesRow.join(" | ").slice(0, 220) : null,
          nonCurrentLiabilitiesRow: nonCurrentLiabilitiesRow ? nonCurrentLiabilitiesRow.join(" | ").slice(0, 220) : null,
          totalEquityRow: totalEquityRow ? totalEquityRow.join(" | ").slice(0, 220) : null,
        },
      },
      balanceSheetLite,
    });
  } catch (e) {
    return send(500, { ok: false, error: e?.message || String(e) });
  }
};
