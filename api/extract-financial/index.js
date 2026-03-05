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
    const period = String(body.period || "annual").toLowerCase(); // annual | quarterly (مستقبلاً)
    const compare = String(body.compare || "none").toLowerCase(); // none | yoy

    if (!normalized || typeof normalized !== "object") {
      return send(400, { ok: false, error: "Missing normalized in request body" });
    }

    const tablesPreview = Array.isArray(normalized.tablesPreview) ? normalized.tablesPreview : [];
    if (!tablesPreview.length) {
      return send(200, {
        ok: true,
        period,
        compare,
        balancePickInfo: { candidates: [], picked: null },
        balanceSheetLite: {
          totalAssets: null,
          currentAssets: null,
          nonCurrentAssets: null,
          totalLiabilities: null,
          currentLiabilities: null,
          nonCurrentLiabilities: null,
          totalEquity: null,
        },
        note: "No tablesPreview received.",
      });
    }

    // ----------------------------
    // Helpers: normalize text
    // ----------------------------
    const norm = (s) =>
      String(s || "")
        .replace(/\u0640/g, "") // tatweel
        .replace(/[إأآ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    // Arabic digits -> latin digits
    const toLatinDigits = (s) =>
      String(s || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

    // ----------------------------
    // ✅ Robust number parsing (fixes 62,585,869 -> 62585869)
    // Handles:
    // - Arabic thousands: ٬
    // - Arabic decimal: ٫
    // - English thousands: ,
    // - English decimal: .
    // - spaces, NBSP
    // ----------------------------
    const parseNumberLoose = (value) => {
      let s = String(value ?? "").trim();
      if (!s) return null;

      // remove common junk
      s = s.replace(/\u00A0/g, " "); // nbsp
      s = toLatinDigits(s);
      s = s.replace(/[()]/g, ""); // ignore parentheses here; handle negative below if needed

      // detect negative in formats like (123) or -123
      const isNeg = /^\s*\(.*\)\s*$/.test(String(value ?? "").trim()) || /^\s*-/.test(s);

      // keep only digits and separators
      s = s.replace(/[^0-9.,٬٫-]/g, "");
      s = s.replace(/^-+/, ""); // remove leading '-' after isNeg capture

      // normalize arabic separators
      s = s.replace(/٬/g, ","); // thousands
      s = s.replace(/٫/g, "."); // decimal

      if (!s) return null;

      // If both ',' and '.' exist, decide decimal separator by LAST occurrence
      const lastComma = s.lastIndexOf(",");
      const lastDot = s.lastIndexOf(".");
      if (lastComma !== -1 && lastDot !== -1) {
        const decimalSep = lastDot > lastComma ? "." : ",";
        const thousandSep = decimalSep === "." ? "," : ".";
        s = s.split(thousandSep).join(""); // remove thousands
        if (decimalSep === ",") s = s.replace(/,/g, ".");
      } else if (lastComma !== -1) {
        // only comma exists: usually thousands in financials
        // BUT if it looks like decimal (e.g. 12,5) we treat it as decimal.
        // heuristic: if comma has 1-2 digits after it -> decimal, else thousands
        const parts = s.split(",");
        const tail = parts[parts.length - 1] || "";
        if (tail.length >= 1 && tail.length <= 2) {
          s = parts.slice(0, -1).join("") + "." + tail;
        } else {
          s = s.replace(/,/g, "");
        }
      } else if (lastDot !== -1) {
        // only dot exists: could be decimal OR thousands
        // heuristic: if dot has 1-2 digits after -> decimal, else thousands
        const parts = s.split(".");
        const tail = parts[parts.length - 1] || "";
        if (tail.length >= 1 && tail.length <= 2) {
          // decimal dot, keep as is but remove any stray commas (none)
        } else {
          s = s.replace(/\./g, "");
        }
      }

      if (!/^\d+(\.\d+)?$/.test(s)) return null;

      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return isNeg ? -n : n;
    };

    const rowJoin = (row) => (Array.isArray(row) ? row.filter(Boolean).join(" | ") : "");

    const extractYearsFromRow = (row) => {
      const text = rowJoin(row);
      const latin = toLatinDigits(text);
      const years = [];
      const re = /20\d{2}/g;
      let m;
      while ((m = re.exec(latin))) years.push(Number(m[0]));
      return years;
    };

    const isMostlyNumber = (cell) => {
      const n = parseNumberLoose(cell);
      return typeof n === "number" && Number.isFinite(n);
    };

    // pick numeric columns for a specific row (ignore first column which is label typically)
    const getRowNumericByCol = (row) => {
      const out = [];
      for (let c = 0; c < row.length; c++) {
        const raw = row[c];
        const n = parseNumberLoose(raw);
        if (n !== null) out.push({ c, n, raw: String(raw ?? "") });
      }
      return out;
    };

    // ----------------------------
    // Balance sheet table scoring
    // ----------------------------
    const scoreBalanceTable = (t) => {
      const rows = []
        .concat(Array.isArray(t.sample) ? t.sample : [])
        .concat(Array.isArray(t.sampleTail) ? t.sampleTail : []);
      const joined = norm(rows.map(rowJoin).join(" "));

      const strong = [
        "قائمه المركز المالي",
        "قائمة المركز المالي",
        "المركز المالي",
        "statement of financial position",
        "statement of financial",
        "financial position",
        "assets",
        "liabilities",
        "equity",
        "الموجودات",
        "الاصول",
        "المطلوبات",
        "الالتزامات",
        "حقوق الملكيه",
        "حقوق الملكية",
      ].map(norm);

      let score = 0;
      for (const k of strong) if (joined.includes(k)) score += 20;

      // bonus if looks like it has years
      let hasYear = false;
      for (const r of rows) {
        const yrs = extractYearsFromRow(r);
        if (yrs.length) {
          hasYear = true;
          break;
        }
      }
      if (hasYear) score += 10;

      // bonus if table looks wide enough (>=3 columns) and has totals words near end
      if (Number(t.columnCount || 0) >= 3) score += 6;
      if (joined.includes(norm("اجمالي"))) score += 6;

      return score;
    };

    const candidates = tablesPreview
      .map((t) => ({
        index: t.index,
        pageNumber: t.pageNumber ?? null,
        rowCount: t.rowCount ?? null,
        columnCount: t.columnCount ?? null,
        hasTail: Array.isArray(t.sampleTail) && t.sampleTail.length > 0,
        score: scoreBalanceTable(t),
        snippet: (() => {
          const rows = []
            .concat(Array.isArray(t.sample) ? t.sample : [])
            .concat(Array.isArray(t.sampleTail) ? t.sampleTail : []);
          const s = rows.map(rowJoin).join(" | ");
          return s.slice(0, 220);
        })(),
      }))
      .sort((a, b) => b.score - a.score);

    const picked = candidates[0] || null;

    if (!picked || picked.score < 20) {
      return send(200, {
        ok: true,
        period,
        compare,
        balancePickInfo: { candidates, picked: picked || null },
        balanceSheetLite: {
          totalAssets: null,
          currentAssets: null,
          nonCurrentAssets: null,
          totalLiabilities: null,
          currentLiabilities: null,
          nonCurrentLiabilities: null,
          totalEquity: null,
        },
        note: "No strong balance sheet table found.",
      });
    }

    const table = tablesPreview.find((t) => String(t.index) === String(picked.index)) || null;
    const rows = []
      .concat(Array.isArray(table?.sample) ? table.sample : [])
      .concat(Array.isArray(table?.sampleTail) ? table.sampleTail : []);

    // ----------------------------
    // Determine year columns (best effort)
    // ----------------------------
    const yearToCol = new Map(); // year -> col index
    // scan first ~8 rows for headers containing years
    for (let i = 0; i < Math.min(8, rows.length); i++) {
      const r = rows[i] || [];
      const years = extractYearsFromRow(r);
      if (!years.length) continue;

      // map years to the columns where they appear
      for (let c = 0; c < r.length; c++) {
        const cell = toLatinDigits(String(r[c] ?? ""));
        const m = cell.match(/20\d{2}/);
        if (m) {
          const y = Number(m[0]);
          if (!yearToCol.has(y)) yearToCol.set(y, c);
        }
      }
    }

    const yearsFound = Array.from(yearToCol.keys()).sort((a, b) => a - b);
    const latestYear = yearsFound.length ? yearsFound[yearsFound.length - 1] : null;
    const prevYear = yearsFound.length >= 2 ? yearsFound[yearsFound.length - 2] : null;

    const pickCols = (() => {
      // If we found year columns, use them
      if (latestYear && yearToCol.has(latestYear)) {
        const latestCol = yearToCol.get(latestYear);
        const prevCol = prevYear && yearToCol.has(prevYear) ? yearToCol.get(prevYear) : null;
        return { latestYear, prevYear, latestCol, prevCol };
      }

      // Fallback: choose the last 2 numeric columns by scanning a totals-like row
      // This is a best-effort fallback if headers not captured in preview.
      let best = null;
      for (const r of rows.slice(-10)) {
        const joined = norm(rowJoin(r));
        if (!joined.includes(norm("اجمالي"))) continue;
        const nums = getRowNumericByCol(r).sort((a, b) => a.c - b.c);
        if (nums.length >= 2) {
          best = { latestCol: nums[nums.length - 1].c, prevCol: nums[nums.length - 2].c };
          break;
        }
      }
      if (best) return { latestYear: null, prevYear: null, ...best };
      return { latestYear: null, prevYear: null, latestCol: null, prevCol: null };
    })();

    const getValueFromRow = (row, which) => {
      if (!Array.isArray(row)) return null;

      // prefer year columns if we have them
      if (which === "latest" && pickCols.latestCol != null) {
        return parseNumberLoose(row[pickCols.latestCol]);
      }
      if (which === "previous" && pickCols.prevCol != null) {
        return parseNumberLoose(row[pickCols.prevCol]);
      }

      // fallback: last numeric cell
      const nums = getRowNumericByCol(row);
      if (!nums.length) return null;
      return nums[nums.length - 1].n;
    };

    // ----------------------------
    // Row matching with scoring (less fragile than strict include/exclude)
    // ----------------------------
    const rowScore = (row, includes, excludes) => {
      const text = norm(rowJoin(row));
      let s = 0;

      for (const k of includes) {
        const kk = norm(k);
        if (!kk) continue;
        if (text.includes(kk)) s += 20;
      }

      // soft penalty for excludes (NOT hard-block)
      for (const x of excludes) {
        const xx = norm(x);
        if (!xx) continue;
        if (text.includes(xx)) s -= 8;
      }

      // bonus if row has numbers
      const nums = getRowNumericByCol(row);
      if (nums.length >= 1) s += 4;
      if (nums.length >= 2) s += 3;

      return s;
    };

    const findBestRow = (includes, excludes = []) => {
      let best = null;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const score = rowScore(r, includes, excludes);
        if (!best || score > best.score) best = { i, row: r, score };
      }
      // require minimal confidence
      if (!best || best.score < 18) return null;
      return best;
    };

    // ----------------------------
    // Targets
    // ----------------------------
    const targets = {
      totalAssets: {
        includes: ["اجمالي الموجودات", "اجمالي الاصول", "مجموع الموجودات", "مجموع الاصول", "total assets"],
        excludes: ["المتداوله", "غير المتداوله", "current", "non-current"],
      },
      currentAssets: {
        includes: ["اجمالي الموجودات المتداوله", "اجمالي الاصول المتداوله", "مجموع الموجودات المتداوله", "current assets"],
        excludes: ["غير المتداوله", "non-current"],
      },
      nonCurrentAssets: {
        includes: ["اجمالي الموجودات غير المتداوله", "اجمالي الاصول غير المتداوله", "non-current assets", "non current assets"],
        excludes: ["المتداوله", "current"],
      },
      totalLiabilities: {
        includes: ["اجمالي المطلوبات", "اجمالي الالتزامات", "total liabilities"],
        excludes: ["المتداوله", "غير المتداوله", "current", "non-current", "حقوق الملكيه", "and equity", "shareholders"],
      },
      currentLiabilities: {
        includes: ["اجمالي المطلوبات المتداوله", "اجمالي الالتزامات المتداوله", "current liabilities"],
        excludes: ["غير المتداوله", "non-current"],
      },
      nonCurrentLiabilities: {
        includes: ["اجمالي المطلوبات غير المتداوله", "اجمالي الالتزامات غير المتداوله", "non-current liabilities", "non current liabilities"],
        excludes: ["المتداوله", "current"],
      },
      totalEquity: {
        includes: ["اجمالي حقوق الملكيه", "حقوق الملكيه العائده", "total equity", "total shareholders' equity", "shareholders' equity"],
        excludes: ["المتداوله", "غير المتداوله", "current", "non-current", "المطلوبات", "الالتزامات", "liabilities"],
      },
    };

    const matchedRows = {};
    for (const key of Object.keys(targets)) {
      matchedRows[key] = findBestRow(targets[key].includes, targets[key].excludes);
    }

    // ----------------------------
    // Build output (none vs yoy)
    // ----------------------------
    const outLite = {
      totalAssets: null,
      currentAssets: null,
      nonCurrentAssets: null,
      totalLiabilities: null,
      currentLiabilities: null,
      nonCurrentLiabilities: null,
      totalEquity: null,
    };

    for (const key of Object.keys(outLite)) {
      const hit = matchedRows[key];
      if (!hit) continue;

      if (compare === "yoy") {
        outLite[key] = {
          latest: getValueFromRow(hit.row, "latest"),
          previous: getValueFromRow(hit.row, "previous"),
        };
      } else {
        outLite[key] = getValueFromRow(hit.row, "latest");
      }
    }

    // ----------------------------
    // Optional sanity check:
    // If totalAssets missing but we have totalLiabilities + totalEquity, try derive
    // ----------------------------
    const tryNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

    if (compare !== "yoy") {
      const A = tryNumber(outLite.totalAssets);
      const L = tryNumber(outLite.totalLiabilities);
      const E = tryNumber(outLite.totalEquity);
      if (A == null && L != null && E != null) {
        outLite.totalAssets = L + E; // fallback derive
      }
    }

    return send(200, {
      ok: true,
      fileName: String(body.fileName || "unknown.pdf"),
      period,
      compare,
      pickedYear: pickCols.latestYear,
      previousYear: pickCols.prevYear,
      balancePickInfo: {
        candidates: candidates.slice(0, 8),
        picked,
        matchedRows: Object.fromEntries(
          Object.entries(matchedRows).map(([k, v]) => [
            k,
            v
              ? {
                  rowIndex: v.i,
                  score: v.score,
                  rowText: rowJoin(v.row).slice(0, 220),
                }
              : null,
          ])
        ),
      },
      balanceSheetLite: outLite,
    });
  } catch (e) {
    return send(500, { ok: false, error: e?.message || String(e) });
  }
};
