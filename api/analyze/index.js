// api/analyze/index.js
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
    const blobUrl = body.blobUrl || body.url || body.fileUrl || null;
    const fileName = body.fileName || "unknown.pdf";

    if (!blobUrl || typeof blobUrl !== "string") {
      return send(400, { ok: false, error: "Missing blobUrl in request body" });
    }

    const DI_ENDPOINT =
      process.env.DI_ENDPOINT ||
      process.env.DOCUMENT_INTELLIGENCE_ENDPOINT ||
      process.env.FORM_RECOGNIZER_ENDPOINT;

    const DI_KEY =
      process.env.DI_KEY ||
      process.env.DOCUMENT_INTELLIGENCE_KEY ||
      process.env.FORM_RECOGNIZER_KEY;

    if (!DI_ENDPOINT || !DI_KEY) {
      return send(500, {
        ok: false,
        error:
          "Missing DI_ENDPOINT/DI_KEY in environment. Set DI_ENDPOINT and DI_KEY in Azure Function App settings.",
      });
    }

    const diModel = "prebuilt-layout";
    const diApiVersion = "2023-07-31";

    const base = String(DI_ENDPOINT).replace(/\/+$/, "");

    const makeAnalyzeUrl = (prefix) =>
      `${base}/${prefix}/documentModels/${encodeURIComponent(
        diModel
      )}:analyze?api-version=${encodeURIComponent(diApiVersion)}`;

    const startAnalyze = async (prefix) => {
      const analyzeUrl = makeAnalyzeUrl(prefix);

      const res = await fetch(analyzeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": DI_KEY,
        },
        body: JSON.stringify({ urlSource: blobUrl }),
      });

      const opLoc =
        res.headers.get("operation-location") ||
        res.headers.get("Operation-Location") ||
        null;

      const txt = await res.text().catch(() => "");

      return { prefix, res, opLoc, txt };
    };

    // ✅ جرّب المسار الجديد أولاً ثم القديم تلقائياً
    let started = await startAnalyze("documentintelligence");
    if (!started.res.ok || !started.opLoc) {
      // إذا 404 أو ما في operation-location -> جرّب formrecognizer
      const maybe404 = started.res.status === 404 || /Resource not found/i.test(started.txt || "");
      if (maybe404 || !started.opLoc) {
        started = await startAnalyze("formrecognizer");
      }
    }

    if (!started.res.ok || !started.opLoc) {
      return send(500, {
        ok: false,
        error: "Failed to start Document Intelligence analyze",
        status: started.res.status,
        details: (started.txt || "").slice(0, 1500),
        hasOperationLocation: Boolean(started.opLoc),
        triedPrefix: started.prefix,
        hint:
          "If still 404, your DI_ENDPOINT is wrong. It must look like https://<name>.cognitiveservices.azure.com (no extra path).",
      });
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const maxWaitMs = 120000;
    const pollEveryMs = 1200;
    const startedAt = Date.now();

    let diJson = null;
    let diStatus = "running";

    while (Date.now() - startedAt < maxWaitMs) {
      const pollRes = await fetch(started.opLoc, {
        method: "GET",
        headers: { "Ocp-Apim-Subscription-Key": DI_KEY },
      });

      const pollTxt = await pollRes.text().catch(() => "");
      try {
        diJson = pollTxt ? JSON.parse(pollTxt) : null;
      } catch {
        diJson = { status: "invalid_json", raw: pollTxt?.slice(0, 1500) };
      }

      diStatus = String(diJson?.status || "").toLowerCase();
      if (diStatus === "succeeded" || diStatus === "failed") break;

      await sleep(pollEveryMs);
    }

    if (!diJson) return send(500, { ok: false, error: "No DI response (empty)" });

    if (String(diJson?.status || "").toLowerCase() !== "succeeded") {
      return send(500, {
        ok: false,
        error: "Document Intelligence analysis did not succeed",
        diStatus: diJson?.status || null,
        details: diJson,
      });
    }

    const analyzeResult = diJson?.analyzeResult || {};
    const diWarnings = analyzeResult?.warnings ?? null;

    const pages = Array.isArray(analyzeResult.pages) ? analyzeResult.pages : [];
    const normPages = pages.map((p) => ({
      pageNumber: p.pageNumber ?? null,
      width: p.width ?? null,
      height: p.height ?? null,
      unit: p.unit ?? null,
      lineCount: Array.isArray(p.lines) ? p.lines.length : p.lineCount ?? null,
      wordCount: Array.isArray(p.words) ? p.words.length : p.wordCount ?? null,
    }));

    const tables = Array.isArray(analyzeResult.tables) ? analyzeResult.tables : [];

    const buildMatrix = (table) => {
      const rowCount = Number(table?.rowCount || 0);
      const colCount = Number(table?.columnCount || 0);
      const matrix = Array.from({ length: rowCount }, () =>
        Array.from({ length: colCount }, () => "")
      );

      const cells = Array.isArray(table?.cells) ? table.cells : [];
      for (const cell of cells) {
        const r = Number(cell?.rowIndex ?? -1);
        const c = Number(cell?.columnIndex ?? -1);
        if (r >= 0 && r < rowCount && c >= 0 && c < colCount) {
          const content = cell?.content ?? "";
          if (!matrix[r][c] || String(content).length > String(matrix[r][c]).length) {
            matrix[r][c] = String(content);
          }
        }
      }
      return matrix;
    };

    const takeHead = (rows, n) => rows.slice(0, Math.min(n, rows.length));
    const takeTail = (rows, n) => rows.slice(Math.max(0, rows.length - n));

    const previewHeadRows = 12;
    const previewTailRows = 12;

    const tablesPreview = tables.map((t, idx) => {
      const rowCount = Number(t?.rowCount || 0);
      const columnCount = Number(t?.columnCount || 0);
      const pageNumber =
        (Array.isArray(t?.boundingRegions) && t.boundingRegions[0]?.pageNumber) || null;

      const matrix = buildMatrix(t);
      const sample = takeHead(matrix, previewHeadRows);
      const sampleTail = rowCount > previewHeadRows ? takeTail(matrix, previewTailRows) : [];

      return {
        index: typeof t?.index !== "undefined" ? t.index : idx,
        rowCount,
        columnCount,
        pageNumber,
        sample,
        sampleTail, // ✅ هذا مهم للـ totals اللي آخر الجدول
      };
    });

    let textLength = 0;
    if (typeof analyzeResult.content === "string") {
      textLength = analyzeResult.content.length;
    } else {
      let total = 0;
      for (const p of pages) {
        const lines = Array.isArray(p?.lines) ? p.lines : [];
        for (const ln of lines) total += String(ln?.content || "").length;
      }
      textLength = total;
    }

    const normalized = {
      meta: {
        pages: normPages.length,
        tables: tables.length,
        textLength,
      },
      pages: normPages,
      tablesPreview,
    };

    return send(200, {
      ok: true,
      fileName,
      diModel,
      diApiVersion,
      diStatus: "succeeded",
      diWarnings,
      diRouteUsed: started.prefix, // ✅ يوضح أي مسار اشتغل عندك
      normalized,
    });
  } catch (e) {
    return send(500, { ok: false, error: e?.message || String(e) });
  }
};
