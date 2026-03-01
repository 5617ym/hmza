// api/analyze/index.js
// Azure Document Intelligence (prebuilt-layout)
// Fix: send Buffer (not ArrayBuffer) + Content-Length to ensure full PDF is processed

module.exports = async function (context, req) {
  const send = (status, payload) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: payload,
    };
  };

  try {
    if ((req.method || "").toUpperCase() !== "POST") {
      return send(405, { ok: false, error: "Method not allowed" });
    }

    const { fileName, blobUrl } = req.body || {};
    if (!blobUrl) return send(400, { ok: false, error: "blobUrl مطلوب" });

    const endpoint = process.env.DOCUMENT_INTELLIGENCE_ENDPOINT || "";
    const key = process.env.DOCUMENT_INTELLIGENCE_KEY || "";

    if (!endpoint || !key) {
      return send(500, {
        ok: false,
        error: "DI secrets missing",
        details: {
          hasEndpoint: Boolean(endpoint),
          hasKey: Boolean(key),
          expectedEnv: ["DOCUMENT_INTELLIGENCE_ENDPOINT", "DOCUMENT_INTELLIGENCE_KEY"],
        },
      });
    }

    // 0) Download blob fully as Buffer
    const blobRes = await fetch(blobUrl, { method: "GET" });

    if (!blobRes.ok) {
      const t = await blobRes.text().catch(() => "");
      return send(500, {
        ok: false,
        error: "Blob fetch failed",
        status: blobRes.status,
        body: t.slice(0, 2000),
      });
    }

    const blobContentType = blobRes.headers.get("content-type") || "application/pdf";
    const blobLenHeader = blobRes.headers.get("content-length");
    const headerBytes = blobLenHeader ? Number(blobLenHeader) : null;

    const ab = await blobRes.arrayBuffer();
    const buf = Buffer.from(ab);
    const downloadedBytes = buf.length;

    // Quick signature check (PDF should start with "%PDF")
    const signature = buf.slice(0, 4).toString("utf8");

    // 1) Start DI analyze with raw bytes
    const ep = endpoint.replace(/\/+$/, "");
    const model = "prebuilt-layout";
    const apiVersion = "2023-07-31";
    const analyzeUrl = `${ep}/formrecognizer/documentModels/${model}:analyze?api-version=${apiVersion}`;

    const start = await fetch(analyzeUrl, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": blobContentType,
        "Content-Length": String(downloadedBytes),
      },
      body: buf,
    });

    const startText = await start.text().catch(() => "");
    if (!start.ok) {
      return send(500, {
        ok: false,
        error: "DI start failed",
        status: start.status,
        body: startText.slice(0, 2000),
        debug: {
          blobContentType,
          headerBytes,
          downloadedBytes,
          signature,
        },
      });
    }

    const operationLocation =
      start.headers.get("operation-location") ||
      start.headers.get("Operation-Location");

    if (!operationLocation) {
      return send(500, {
        ok: false,
        error: "Missing operation-location from DI",
        body: startText.slice(0, 2000),
      });
    }

    // 2) Polling
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const maxTries = 60;
    let last = null;

    for (let i = 0; i < maxTries; i++) {
      const r = await fetch(operationLocation, {
        headers: { "Ocp-Apim-Subscription-Key": key },
      });

      const j = await r.json().catch(() => null);
      last = j;

      if (!r.ok) {
        return send(500, {
          ok: false,
          error: "DI poll failed",
          status: r.status,
          body: j || null,
        });
      }

      const st = (j?.status || "").toLowerCase();
      if (st === "succeeded") break;

      if (st === "failed") {
        return send(500, {
          ok: false,
          error: "DI analysis failed",
          details: j,
        });
      }

      await sleep(1000);
    }

    if (!last || (last.status || "").toLowerCase() !== "succeeded") {
      return send(504, {
        ok: false,
        error: "DI timeout",
        details: last,
      });
    }

    const analyzeResult = last.analyzeResult || {};

    const pageNumbers = Array.isArray(analyzeResult.pages)
      ? analyzeResult.pages.map((p) => p.pageNumber).filter((n) => Number.isFinite(n))
      : [];

    const diPagesLen = Array.isArray(analyzeResult.pages) ? analyzeResult.pages.length : 0;
    const pages = pageNumbers.length ? Math.max(...pageNumbers) : diPagesLen;

    const tables = Array.isArray(analyzeResult.tables) ? analyzeResult.tables.length : 0;

    const content = analyzeResult.content || "";
    const textLength = content.length;

    const diWarnings = analyzeResult.warnings || last.warnings || null;

    return send(200, {
      ok: true,
      fileName: fileName || null,
      pages,
      tables,
      textLength,
      sampleText: content.slice(0, 500),

      // Debug (مهمين جدًا الآن)
      blobContentType,
      headerBytes,
      downloadedBytes,
      signature,

      diModel: analyzeResult.modelId || model,
      diApiVersion: analyzeResult.apiVersion || apiVersion,
      diStatus: last.status || null,
      diPagesLen,
      diPageNumbers: pageNumbers,
      diWarnings,
    });
  } catch (err) {
    return send(500, { ok: false, error: err.message || "Unhandled error" });
  }
};
