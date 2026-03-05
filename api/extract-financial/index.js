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
    const period = String(body.period || "annual").toLowerCase(); // annual | quarterly
    const compare = String(body.compare || "none").toLowerCase(); // none | prev
    const fileName = body.fileName || "unknown.pdf";

    if (!normalized || !normalized.tablesPreview || !Array.isArray(normalized.tablesPreview)) {
      return send(400, {
        ok: false,
        error: "Missing normalized.tablesPreview in request body",
        hint: "Send { normalized, period, compare, fileName } from /api/analyze response",
      });
    }

    // -----------------------------
    // Text helpers
    // -----------------------------
    const arDigitMap = {
      "٠": "0",
      "١": "1",
      "٢": "2",
      "٣": "3",
      "٤": "4",
      "٥": "5",
      "٦": "6",
      "٧": "7",
      "٨": "8",
      "٩": "9",
      "۰": "0",
      "۱": "1",
      "۲": "2",
      "۳": "3",
      "۴": "4",
      "۵": "5",
      "۶": "6",
      "۷": "7",
      "۸": "8",
      "۹": "9",
    };

    const toLatinDigits = (s) =>
      String(s || "").replace(/[٠-٩۰-۹]/g, (d) => arDigitMap[d] ?? d);

    const norm = (s) =>
      toLatinDigits(String(s || ""))
        .toLowerCase()
        .replace(/\u200f|\u200e/g, "")
        .replace(/\s+/g, " ")
        .trim();

    // -----------------------------
    // ✅ Strong number parser (fixes 62.585869 bug)
    // -----------------------------
    const parseNumberSmart = (input) => {
      let s = String(input ?? "").trim();
      if (!s) return null;

      // remove parentheses negative: (123) => -123
      let neg = false;
      const paren = s.match(/^\((.*)\)$/);
      if (paren) {
        neg = true;
        s = paren[1];
      }

      s = toLatinDigits(s);

      // unify arabic separators:
      // "٫" (arabic decimal) -> "."
      // "،" (arabic comma) -> ","
      s = s.replace(/٫/g, ".").replace(/،/g, ",");

      // keep only digits, comma, dot, minus
      s = s.replace(/[^\d\.\,\-]/g, "");

      // if there are multiple "-" keep only leading
      s = s.replace(/(?!^)-/g, "");
      if (s.startsWith("-")) {
        neg = true;
        s = s.slice(1);
      }

      // Strategy:
      // 1) If there are both "." and ",":
      //    - Detect which is decimal by last separator position
      //    - BUT if commas appear as 3-digit groups (thousands), treat commas as thousands
      // 2) If only "," exists:
      //    - If it looks like thousands grouping (e.g. 62,585,869) => remove commas
      //    - Else treat comma as decimal (rare)
      // 3) If only "." exists:
      //    - If it looks like thousands grouping (e.g. 1.234.567) => remove dots
      //    - Else treat as decimal

      const looksLikeGroupedThousands = (str, sep) => {
        // e.g. 62,585,869 or 1.234.567
        const parts = str.split(sep);
        if (parts.length <= 1) return false;
        // all groups after first should be exactly 3 digits
        for (let i = 1; i < parts.length; i++) {
          if (parts[i].length !== 3) return false;
        }
        return true;
      };

      const hasComma = s.includes(",");
      const hasDot = s.includes(".");

      let out = s;

      if (hasComma && hasDot) {
        // If commas are thousands grouping, remove commas and keep dot as decimal (or thousands if grouped too)
        if (looksLikeGroupedThousands(out, ",")) {
          out = out.replace(/,/g, "");
          // now maybe dots are thousands too
          if (looksLikeGroupedThousands(out, ".")) out = out.replace(/\./g, "");
        } else if (looksLikeGroupedThousands(out, ".")) {
          out = out.replace(/\./g, "");
          // now comma might be decimal
          out = out.replace(/,/g, ".");
        } else {
          // decide by last separator
          const lastComma = out.lastIndexOf(",");
          const lastDot = out.lastIndexOf(".");
          if (lastComma > lastDot) {
            // comma as decimal
            out = out.replace(/\./g, ""); // dots as thousands
            out = out.replace(/,/g, ".");
          } else {
            // dot as decimal
            out = out.replace(/,/g, ""); // commas as thousands
          }
        }
      } else if (hasComma) {
        if (looksLikeGroupedThousands(out, ",")) {
          out = out.replace(/,/g, "");
        } else {
          // treat comma as decimal
          out = out.replace(/,/g, ".");
        }
      } else if (hasDot) {
        if (looksLikeGroupedThousands(out, ".")) {
          out = out.replace(/\./g, "");
        } // else keep dot as decimal
      }

      if (!out || out === "." || out === "," || out === "-") return null;
      const n = Number(out);
      if (!Number.isFinite(n)) return null;
      return neg ? -n : n;
    };

    // -----------------------------
    // Table scoring: pick best balance sheet table
    // -----------------------------
    const joinRows = (rows) =>
      rows
        .flat()
        .map((x) => String(x || ""))
        .join(" | ");

    const scoreBalanceTable = (tp) => {
      const sample = Array.isArray(tp.sample) ? tp.sample : [];
      const tail = Array.isArray(tp.sampleTail) ? tp.sampleTail : [];
      const joined = norm(joinRows(sample.concat(tail)));

      let score = 0;

      const strong = [
        "قائمة المركز المالي",
        "المركز المالي",
        "قائمة الوضع المالي",
        "statement of financial position",
        "balance sheet",
      ];
      const support = [
        "الموجودات",
        "الأصول",
        "المطلوبات",
        "الالتزامات",
        "حقوق الملكية",
        "اجمالي الموجودات",
        "اجمالي الأصول",
        "اجمالي المطلوبات",
        "اجمالي الالتزامات",
        "اجمالي حقوق الملكية",
      ];

      for (const k of strong) if (joined.includes(norm(k))) score += 30;
      for (const k of support) if (joined.includes(norm(k))) score += 8;

      // Prefer 4 columns (name + two years + note) but allow 3
      const cc = Number(tp.columnCount || 0);
      if (cc === 4) score += 12;
      if (cc === 3) score += 6;

      // Prefer hasTail true (totals often at end)
      const hasTail = tail.length > 0;
      if (hasTail) score += 10;

      return score;
    };

    const candidates = normalized.tablesPreview
      .map((t) => ({
        index: t.index,
        pageNumber: t.pageNumber ?? null,
        rowCount: t.rowCount ?? null,
        columnCount: t.columnCount ?? null,
        hasTail: Array.isArray(t.sampleTail) && t.sampleTail.length > 0,
        score: scoreBalanceTable(t),
        sample: t.sample || [],
        sampleTail: t.sampleTail || [],
        snippet: joinRows((t.sample || []).slice(0, 4)),
      }))
      .sort((a, b) => b.score - a.score);

    const picked = candidates[0] || null;
    if (!picked || picked.score < 20) {
      return send(200, {
        ok: true,
        fileName,
        period,
        compare,
        balancePickInfo: { candidates: candidates.slice(0, 8) },
        balanceSheetLite: {
          totalAssets: null,
          currentAssets: null,
          nonCurrentAssets: null,
          totalLiabilities: null,
          currentLiabilities: null,
          nonCurrentLiabilities: null,
          totalEquity: null,
        },
        warning: "Could not confidently pick a balance sheet table (score too low).",
      });
    }

    const rows = (picked.sample || []).concat(picked.sampleTail || []);
    const safeCell = (r, c) => (rows[r] && typeof rows[r][c] !== "undefined" ? String(rows[r][c] || "") : "");
    const rowCount = rows.length;
    const colCount = Number(picked.columnCount || 0);

    // -----------------------------
    // Find year columns (latest + previous)
    // -----------------------------
    const findYearsInText = (txt) => {
      const t = toLatinDigits(String(txt || ""));
      const years = [];
      const re = /\b(19\d{2}|20\d{2})\b/g;
      let m;
      while ((m = re.exec(t))) years.push(Number(m[1]));
      return years;
    };

    const headerScanRows = Math.min(8, rowCount);
    const colYearHits = Array.from({ length: colCount }, () => []);

    for (let r = 0; r < headerScanRows; r++) {
      for (let c = 0; c < colCount; c++) {
        const ys = findYearsInText(safeCell(r, c));
        if (ys.length) colYearHits[c].push(...ys);
      }
    }

    // Count per column
    const colYear = colYearHits
      .map((arr, c) => {
        const counts = {};
        for (const y of arr) counts[y] = (counts[y] || 0) + 1;
        // pick most frequent year
        let bestY = null;
        let bestK = 0;
        for (const [y, k] of Object.entries(counts)) {
          if (k > bestK) {
            bestK = k;
            bestY = Number(y);
          }
        }
        return { c, year: bestY, hits: bestK };
      })
      .filter((x) => x.year);

    let latestCol = null;
    let prevCol = null;

    if (colYear.length) {
      const sorted = colYear.sort((a, b) => b.year - a.year);
      latestCol = sorted[0]?.c ?? null;
      const latestYear = sorted[0]?.year ?? null;
      prevCol = sorted.find((x) => x.year && x.year < latestYear)?.c ?? null;
    }

    // fallback: assume last numeric columns are years
    if (latestCol === null) {
      latestCol = colCount - 1;
      if (latestCol < 1) latestCol = 1;
    }
    if (prevCol === null && colCount >= 3) {
      prevCol = latestCol - 1;
    }

    // If there is an "إيضاح" column, it is usually between name and years (often col=1 in 4 cols)
    // We'll treat value columns as latestCol/prevCol only.
    const valueCols = {
      latest: latestCol,
      previous: compare === "prev" ? prevCol : null,
    };

    // -----------------------------
    // Row matching
    // -----------------------------
    const rowKey = (r) => norm(safeCell(r, 0));

    const findRowIndexByNames = (names, exclude = []) => {
      const want = names.map(norm);
      const bad = exclude.map(norm);
      let best = { idx: null, score: -1 };

      for (let r = 0; r < rowCount; r++) {
        const k = rowKey(r);
        if (!k) continue;
        let s = 0;

        for (const w of want) if (w && k.includes(w)) s += 20;
        for (const b of bad) if (b && k.includes(b)) s -= 30;

        // small boost if the row has numbers in expected value col
        const v = parseNumberSmart(safeCell(r, valueCols.latest));
        if (v !== null) s += 3;

        if (s > best.score) best = { idx: r, score: s };
      }

      if (best.score < 20) return null;
      return best.idx;
    };

    const getValue = (r, col) => {
      if (r === null || col === null) return null;
      return parseNumberSmart(safeCell(r, col));
    };

    // Names tuned for your PDF style
    const N = {
      totalAssets: ["إجمالي الموجودات", "اجمالي الموجودات", "إجمالي الأصول", "اجمالي الأصول", "Total assets"],
      currentAssets: ["إجمالي الموجودات المتداولة", "اجمالي الموجودات المتداولة", "إجمالي الأصول المتداولة", "Current assets", "Total current assets"],
      nonCurrentAssets: ["إجمالي الموجودات غير المتداولة", "اجمالي الموجودات غير المتداولة", "إجمالي الأصول غير المتداولة", "Non-current assets", "Total non-current assets"],

      totalLiabilities: ["إجمالي المطلوبات", "اجمالي المطلوبات", "إجمالي الالتزامات", "اجمالي الالتزامات", "Total liabilities"],
      currentLiabilities: ["إجمالي المطلوبات المتداولة", "اجمالي المطلوبات المتداولة", "إجمالي الالتزامات المتداولة", "Current liabilities", "Total current liabilities"],
      nonCurrentLiabilities: ["إجمالي المطلوبات غير المتداولة", "اجمالي المطلوبات غير المتداولة", "إجمالي الالتزامات غير المتداولة", "Non-current liabilities", "Total non-current liabilities"],

      totalEquity: ["إجمالي حقوق الملكية", "اجمالي حقوق الملكية", "Total equity", "Equity attributable"],
    };

    // Exclusions to avoid confusing sections
    const EX = {
      // avoid lines like "إجمالي الموجودات غير المتداولة" when searching totalAssets (and vice versa)
      totalAssets: ["غير المتداولة", "المتداولة"],
      currentAssets: ["غير المتداولة"],
      nonCurrentAssets: ["المتداولة"],

      totalLiabilities: ["غير المتداولة", "المتداولة", "وحقوق"],
      currentLiabilities: ["غير المتداولة"],
      nonCurrentLiabilities: ["المتداولة"],

      totalEquity: ["إجمالي المطلوبات", "إجمالي الالتزامات", "والمطلوبات"],
    };

    const idxTotalAssets = findRowIndexByNames(N.totalAssets, EX.totalAssets);
    const idxCurrentAssets = findRowIndexByNames(N.currentAssets, EX.currentAssets);
    const idxNonCurrentAssets = findRowIndexByNames(N.nonCurrentAssets, EX.nonCurrentAssets);

    const idxTotalLiab = findRowIndexByNames(N.totalLiabilities, EX.totalLiabilities);
    const idxCurrentLiab = findRowIndexByNames(N.currentLiabilities, EX.currentLiabilities);
    const idxNonCurrentLiab = findRowIndexByNames(N.nonCurrentLiabilities, EX.nonCurrentLiabilities);

    const idxTotalEq = findRowIndexByNames(N.totalEquity, EX.totalEquity);

    const balanceSheetLite = {
      totalAssets: getValue(idxTotalAssets, valueCols.latest),
      currentAssets: getValue(idxCurrentAssets, valueCols.latest),
      nonCurrentAssets: getValue(idxNonCurrentAssets, valueCols.latest),

      totalLiabilities: getValue(idxTotalLiab, valueCols.latest),
      currentLiabilities: getValue(idxCurrentLiab, valueCols.latest),
      nonCurrentLiabilities: getValue(idxNonCurrentLiab, valueCols.latest),

      totalEquity: getValue(idxTotalEq, valueCols.latest),
    };

    const balanceSheetLitePrev =
      compare === "prev"
        ? {
            totalAssets: getValue(idxTotalAssets, valueCols.previous),
            currentAssets: getValue(idxCurrentAssets, valueCols.previous),
            nonCurrentAssets: getValue(idxNonCurrentAssets, valueCols.previous),

            totalLiabilities: getValue(idxTotalLiab, valueCols.previous),
            currentLiabilities: getValue(idxCurrentLiab, valueCols.previous),
            nonCurrentLiabilities: getValue(idxNonCurrentLiab, valueCols.previous),

            totalEquity: getValue(idxTotalEq, valueCols.previous),
          }
        : null;

    return send(200, {
      ok: true,
      fileName,
      period,
      compare,
      balancePickInfo: {
        picked: {
          index: picked.index,
          score: picked.score,
          pageNumber: picked.pageNumber,
          rowCount: picked.rowCount,
          columnCount: picked.columnCount,
          hasTail: picked.hasTail,
        },
        candidates: candidates.slice(0, 8),
        detectedColumns: valueCols,
      },
      balanceSheetLite,
      balanceSheetLitePrev,
    });
  } catch (e) {
    return send(500, { ok: false, error: e?.message || String(e) });
  }
};
