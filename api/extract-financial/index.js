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

    // ✅ مرونة استقبال البيانات (مثل analyze)
    const blobUrl =
      body.blobUrl ||
      body.url ||
      body.fileUrl ||
      body?.payload?.blobUrl ||
      body?.payload?.url ||
      body?.payload?.fileUrl ||
      null;

    const normalized =
      body.normalized ||
      body?.payload?.normalized ||
      null;

    const fileName = body.fileName || body?.payload?.fileName || "unknown.pdf";

    const period = body.period || body?.payload?.period || null; // (سنوي/ربع سنوي..)
    const compareMode = body.compareMode || body?.payload?.compareMode || "بدون مقارنة";

    if (!blobUrl) {
      return send(400, {
        ok: false,
        error: "Missing blobUrl in request body",
        hint: "Send { blobUrl, normalized } OR { payload: { blobUrl, normalized } }",
        gotKeys: Object.keys(body),
      });
    }

    if (!normalized || typeof normalized !== "object") {
      return send(400, {
        ok: false,
        error: "Missing normalized in request body",
        hint: "Send analyze normalized output back to extract-financial",
        gotKeys: Object.keys(body),
      });
    }

    const tablesPreview = Array.isArray(normalized?.tablesPreview)
      ? normalized.tablesPreview
      : [];

    if (!tablesPreview.length) {
      return send(400, {
        ok: false,
        error: "normalized.tablesPreview is empty",
        hint: "Make sure /api/analyze returns normalized.tablesPreview",
      });
    }

    // -------------------------
    // Helpers
    // -------------------------
    const norm = (s) => {
      const x = String(s ?? "")
        .toLowerCase()
        .replace(/[إأآا]/g, "ا")
        .replace(/[ى]/g, "ي")
        .replace(/[ة]/g, "ه")
        .replace(/[ؤئ]/g, "ء")
        .replace(/[\u064B-\u065F]/g, "") // تشكيل
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      return x;
    };

    const toLatinDigits = (s) =>
      String(s ?? "")
        .replace(/[٠]/g, "0")
        .replace(/[١]/g, "1")
        .replace(/[٢]/g, "2")
        .replace(/[٣]/g, "3")
        .replace(/[٤]/g, "4")
        .replace(/[٥]/g, "5")
        .replace(/[٦]/g, "6")
        .replace(/[٧]/g, "7")
        .replace(/[٨]/g, "8")
        .replace(/[٩]/g, "9")
        .replace(/[٫]/g, ".")
        .replace(/[٬]/g, ",");

    const toNumber = (raw) => {
      let s = toLatinDigits(raw).trim();
      if (!s) return null;

      // سلبي بين قوسين
      let neg = false;
      if (/^\(.*\)$/.test(s)) {
        neg = true;
        s = s.slice(1, -1);
      }

      // إزالة أي شيء غير رقم/نقطة/فاصلة/إشارة
      s = s.replace(/[^0-9.,\-]/g, "");

      // إزالة الفواصل كآلاف
      // إذا كان عندنا نقطة كعشري: نحذف الفواصل
      // إذا ما عندنا نقطة: نحذف الفواصل أيضاً (أغلب تقاريرنا آلاف)
      s = s.replace(/,/g, "");

      if (!s || s === "-" || s === ".") return null;

      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return neg ? -n : n;
    };

    const flattenRows = (rows) =>
      (Array.isArray(rows) ? rows : []).map((r) =>
        Array.isArray(r) ? r.map((c) => String(c ?? "")) : [String(r ?? "")]
      );

    const joinTableText = (t) => {
      const rows = [
        ...flattenRows(t?.sample),
        ...flattenRows(t?.sampleTail),
      ];
      return rows.map((r) => r.join(" | ")).join(" \n ");
    };

    const getAllRows = (t) => {
      // نستخدم الـ preview فقط (head + tail)
      const head = flattenRows(t?.sample);
      const tail = flattenRows(t?.sampleTail);
      return [...head, ...tail];
    };

    const extractYearsFromRow = (row) => {
      const text = toLatinDigits(row.join(" "));
      const matches = text.match(/\b(19|20)\d{2}\b/g) || [];
      const years = matches
        .map((y) => Number(y))
        .filter((y) => y >= 1990 && y <= 2100);
      return years;
    };

    const pickYearColumns = (rows) => {
      // نحاول العثور على صف Header فيه سنوات
      // ثم نحدد الأعمدة التي تحتوي سنة
      let best = { years: [], colYears: {} };

      for (const row of rows) {
        const years = extractYearsFromRow(row);
        if (years.length >= 1) {
          // أي خلية تحتوي سنة -> نربطها بالعمود
          const colYears = {};
          for (let i = 0; i < row.length; i++) {
            const cell = toLatinDigits(row[i]);
            const m = cell.match(/\b(19|20)\d{2}\b/);
            if (m) colYears[i] = Number(m[0]);
          }
          const uniqueYears = Array.from(new Set(Object.values(colYears)));
          if (uniqueYears.length > best.years.length) {
            best = { years: uniqueYears, colYears };
          }
        }
      }

      const yearsSorted = [...best.years].sort((a, b) => a - b);
      const latest = yearsSorted.length ? yearsSorted[yearsSorted.length - 1] : null;
      const previous = yearsSorted.length >= 2 ? yearsSorted[yearsSorted.length - 2] : null;

      // عكس mapping: year -> column index
      const yearToCol = {};
      for (const [ci, y] of Object.entries(best.colYears || {})) {
        yearToCol[y] = Number(ci);
      }

      return { latest, previous, yearToCol };
    };

    // -------------------------
    // Balance sheet table picking
    // -------------------------
    const scoreBalanceTable = (t) => {
      const joined = norm(joinTableText(t));

      const strong = [
        "قائمه المركز المالي",
        "قائمه الوضع المالي",
        "statement of financial position",
        "balance sheet",
        "الموجودات",
        "المطلوبات",
        "حقوق الملكيه",
      ];

      const support = [
        "غير متداوله",
        "متداوله",
        "اجمالي الموجودات",
        "اجمالي المطلوبات",
        "اجمالي حقوق الملكيه",
      ];

      let score = 0;
      for (const k of strong) if (joined.includes(norm(k))) score += 20;
      for (const k of support) if (joined.includes(norm(k))) score += 6;

      // تعزيز: وجود الموجودات + المطلوبات + حقوق الملكية معاً
      const hasA = joined.includes(norm("الموجودات"));
      const hasL = joined.includes(norm("المطلوبات"));
      const hasE = joined.includes(norm("حقوق الملكيه")) || joined.includes(norm("حقوق الملكية"));
      if (hasA && hasL && hasE) score += 15;

      // تقليل: جداول ذات طابع إيضاحات/نصوص
      if (joined.includes(norm("ايضاح")) || joined.includes(norm("إيضاح"))) score -= 6;

      return score;
    };

    const candidates = tablesPreview
      .map((t) => {
        const rows = getAllRows(t);
        const { latest, previous, yearToCol } = pickYearColumns(rows);
        return {
          index: t.index,
          pageNumber: t.pageNumber ?? null,
          rowCount: t.rowCount ?? null,
          columnCount: t.columnCount ?? null,
          hasTail: Array.isArray(t.sampleTail) && t.sampleTail.length > 0,
          score: scoreBalanceTable(t),
          years: { latest, previous, yearToCol },
          snippet: joinTableText(t).slice(0, 220),
        };
      })
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];

    // لو ما لقينا مرشح جيد
    if (!best || best.score < 20) {
      return send(200, {
        ok: true,
        fileName,
        blobUrl,
        period,
        compareMode,
        note: "No strong balance sheet table detected from tablesPreview.",
        balanceSheetLite: {
          totalAssets: null,
          currentAssets: null,
          nonCurrentAssets: null,
          totalLiabilities: null,
          currentLiabilities: null,
          nonCurrentLiabilities: null,
          totalEquity: null,
        },
        balancePickInfo: { candidates: candidates.slice(0, 6) },
      });
    }

    const pickedTable = tablesPreview.find((t) => String(t.index) === String(best.index));

    // -------------------------
    // Extract totals from picked table
    // -------------------------
    const rows = getAllRows(pickedTable);

    const pickColFor = (year) => {
      if (!year) return null;
      const col = best.years?.yearToCol?.[year];
      return typeof col === "number" ? col : null;
    };

    const latestYear = best.years.latest;
    const prevYear = compareMode && norm(compareMode) !== norm("بدون مقارنه") ? best.years.previous : null;

    const latestCol = pickColFor(latestYear);
    const prevCol = pickColFor(prevYear);

    // إذا ما عرفنا عمود السنة، نحاول تخمينه:
    // كثير من القوائم: العمودين الأخيرين أرقام السنوات
    const fallbackNumericCol = (row) => {
      // نرجع آخر خلية فيها رقم
      for (let i = row.length - 1; i >= 0; i--) {
        if (toNumber(row[i]) !== null) return i;
      }
      return null;
    };

    const findRowValue = (wantKeys) => {
      const keysN = wantKeys.map(norm);

      let bestHit = null;

      for (const row of rows) {
        const rowText = norm(row.join(" "));
        if (!rowText) continue;

        const hit = keysN.some((k) => rowText.includes(k));
        if (!hit) continue;

        // محاولة أخذ قيمة latest/previous
        let vLatest = null;
        let vPrev = null;

        const lc = latestCol ?? fallbackNumericCol(row);
        if (lc !== null && lc >= 0 && lc < row.length) vLatest = toNumber(row[lc]);

        if (prevCol !== null && prevCol >= 0 && prevCol < row.length) vPrev = toNumber(row[prevCol]);

        // إذا latestCol ما جاء رقم، جرّب عمود ثاني قبل الأخير
        if (vLatest === null) {
          const alt = row.length >= 2 ? row.length - 2 : null;
          if (alt !== null) vLatest = toNumber(row[alt]);
        }

        // سجل أفضل تطابق
        if (vLatest !== null || vPrev !== null) {
          bestHit = {
            rowText: row.join(" | ").slice(0, 280),
            latest: vLatest,
            previous: vPrev,
          };
          // أول نتيجة جيدة تكفي غالباً
          break;
        }
      }

      return bestHit;
    };

    // مفاتيح البحث (كما في صورتك)
    const hitTotalAssets = findRowValue(["إجمالي الموجودات", "اجمالي الموجودات", "total assets", "اجمالي الاصول", "إجمالي الأصول"]);
    const hitTotalLiab = findRowValue(["إجمالي المطلوبات", "اجمالي المطلوبات", "total liabilities", "اجمالي الالتزامات", "إجمالي الالتزامات"]);
    const hitTotalEquity = findRowValue(["إجمالي حقوق الملكية", "اجمالي حقوق الملكيه", "total equity", "حقوق الملكية", "حقوق الملكيه"]);

    // (اختياري) التقسيمات — قد لا تكون موجودة كصف إجمالي منفصل دائماً
    const hitCurrentAssets = findRowValue(["إجمالي الموجودات المتداولة", "اجمالي الموجودات المتداوله", "current assets"]);
    const hitNonCurrentAssets = findRowValue(["إجمالي الموجودات غير المتداولة", "اجمالي الموجودات غير المتداوله", "non-current assets"]);
    const hitCurrentLiab = findRowValue(["إجمالي المطلوبات المتداولة", "اجمالي المطلوبات المتداوله", "current liabilities"]);
    const hitNonCurrentLiab = findRowValue(["إجمالي المطلوبات غير المتداولة", "اجمالي المطلوبات غير المتداوله", "non-current liabilities"]);

    const balanceSheetLite = {
      totalAssets: hitTotalAssets?.latest ?? null,
      currentAssets: hitCurrentAssets?.latest ?? null,
      nonCurrentAssets: hitNonCurrentAssets?.latest ?? null,
      totalLiabilities: hitTotalLiab?.latest ?? null,
      currentLiabilities: hitCurrentLiab?.latest ?? null,
      nonCurrentLiabilities: hitNonCurrentLiab?.latest ?? null,
      totalEquity: hitTotalEquity?.latest ?? null,
    };

    // للتأكد: إذا إجمالي الموجودات/المطلوبات/حقوق الملكية كلها null
    // نرجع تشخيص واضح
    const coreAllNull =
      balanceSheetLite.totalAssets === null &&
      balanceSheetLite.totalLiabilities === null &&
      balanceSheetLite.totalEquity === null;

    return send(200, {
      ok: true,
      fileName,
      blobUrl,
      period,
      compareMode,

      // ✅ النتيجة
      balanceSheetLite,

      // ✅ تشخيص مفيد
      balancePickInfo: {
        picked: best,
        yearsDetected: {
          latestYear,
          prevYear,
          latestCol,
          prevCol,
          yearToCol: best.years.yearToCol || {},
        },
        hits: {
          totalAssets: hitTotalAssets,
          totalLiabilities: hitTotalLiab,
          totalEquity: hitTotalEquity,
          currentAssets: hitCurrentAssets,
          nonCurrentAssets: hitNonCurrentAssets,
          currentLiabilities: hitCurrentLiab,
          nonCurrentLiabilities: hitNonCurrentLiab,
        },
        warning: coreAllNull
          ? "Picked a balance table but totals not found from preview rows; may need larger tail or UI sending full table."
          : null,
        topCandidates: candidates.slice(0, 6),
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e?.message || String(e) });
  }
};
