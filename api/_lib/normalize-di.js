// api/_lib/normalize-di.js
// تحويل ناتج Azure Document Intelligence (prebuilt-layout) إلى شكل موحّد وخفيف

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function normalizePages(diPages) {
  if (!Array.isArray(diPages)) return [];
  return diPages.map((p) => ({
    pageNumber: p.pageNumber ?? null,
    width: p.width ?? null,
    height: p.height ?? null,
    unit: p.unit ?? null,
    lineCount: Array.isArray(p.lines) ? p.lines.length : null,
    wordCount: Array.isArray(p.words) ? p.words.length : null,
    // تقدر توسّع لاحقاً: lines/words نفسها (حالياً نخليها خفيفة)
  }));
}

function tableToMatrix(t) {
  const rowCount = t?.rowCount || 0;
  const colCount = t?.columnCount || 0;
  const matrix = Array.from({ length: rowCount }, () =>
    Array.from({ length: colCount }, () => "")
  );

  if (Array.isArray(t?.cells)) {
    for (const c of t.cells) {
      const r = c.rowIndex ?? 0;
      const col = c.columnIndex ?? 0;
      if (r < rowCount && col < colCount) {
        const txt = (c.content || "").replace(/\s+/g, " ").trim();
        matrix[r][col] = txt;
      }
    }
  }

  return { rowCount, colCount, matrix };
}

function normalizeTables(diTables, preview = { maxTables: 5, maxRows: 12, maxCols: 8 }) {
  if (!Array.isArray(diTables)) return { count: 0, items: [], preview: [] };

  const items = diTables.map((t, idx) => {
    const base = {
      index: idx,
      rowCount: t.rowCount ?? null,
      columnCount: t.columnCount ?? null,
      // boundingRegions مفيدة لاحقًا للصفحة
      boundingRegions: Array.isArray(t.boundingRegions) ? t.boundingRegions.map(br => pick(br, ["pageNumber"])) : [],
    };

    const { matrix } = tableToMatrix(t);
    return { ...base, matrix }; // matrix كاملة (قد تكون كبيرة لكن عادة مقبولة)
  });

  // Preview خفيف للواجهة
  const pv = items.slice(0, preview.maxTables).map((it) => ({
    index: it.index,
    rowCount: it.rowCount,
    columnCount: it.columnCount,
    sample: it.matrix
      .slice(0, preview.maxRows)
      .map((row) => row.slice(0, preview.maxCols)),
  }));

  return { count: items.length, items, preview: pv };
}

function normalizeAnalyzeResult(analyzeResult) {
  const pages = normalizePages(analyzeResult?.pages);
  const tables = normalizeTables(analyzeResult?.tables);

  // العدّ الصحيح: أعلى رقم صفحة ظاهر
  const pageNumbers = pages.map(p => p.pageNumber).filter(Boolean);
  const pagesCount = pageNumbers.length ? Math.max(...pageNumbers) : 0;

  const content = analyzeResult?.content || "";
  const textLength = content.length;

  return {
    meta: {
      pages: pagesCount,
      tables: tables.count,
      textLength,
    },
    pages,                 // ملخص صفحات
    tablesPreview: tables.preview, // معاينة سريعة
    // لو احتجت لاحقاً:
    // tablesFull: tables.items,
  };
}

module.exports = {
  normalizeAnalyzeResult,
};
