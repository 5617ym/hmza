console.log("main.js loaded ✅");

const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const btnShow = document.getElementById("btnShow");
const btnClear = document.getElementById("btnClear");
const statusEl = document.getElementById("status");
const resultsSection = document.getElementById("results");
const cardsEl = document.getElementById("cards");

const periodEl = document.getElementById("period");
const compareEl = document.getElementById("compare");

let selectedFiles = [];

function setStatus(msg, type = "info") {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.className = "status";
  if (type === "ok") statusEl.classList.add("ok");
  if (type === "warn") statusEl.classList.add("warn");
  if (type === "err") statusEl.classList.add("err");
}

function clearUI() {
  selectedFiles = [];
  if (fileInput) fileInput.value = "";
  if (fileListEl) fileListEl.innerHTML = "";
  if (cardsEl) cardsEl.innerHTML = "";
  resultsSection?.classList.add("hidden");
  if (btnShow) btnShow.disabled = true;
  setStatus("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderSelectedFiles() {
  if (!fileListEl) return;

  if (!selectedFiles.length) {
    fileListEl.innerHTML = `<div>لم يتم اختيار أي ملف.</div>`;
    return;
  }

  fileListEl.innerHTML = selectedFiles
    .map(
      (f) =>
        `<div>${escapeHtml(f.name)} - ${Number(f.size || 0).toLocaleString()} bytes</div>`
    )
    .join("");
}

async function safeJson(res) {
  const txt = await res.text().catch(() => "");
  if (!txt) return { ok: false, error: "Empty response body" };
  try {
    return JSON.parse(txt);
  } catch (e) {
    return { ok: false, error: "Invalid JSON from server", raw: txt.slice(0, 1500) };
  }
}

/* =========================================================
   🚀 Upload → PUT → Ingest (router) → Next (analyze/...)
   ========================================================= */

async function callJson(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const j = await safeJson(r);
  if (!r.ok || !j?.ok) {
    throw new Error(`${url} failed: ${JSON.stringify(j)}`);
  }
  return j;
}

async function analyzeSingleFile(file) {
  // (A) طلب uploadUrl + blobUrl
  const j1 = await callJson("/api/upload-url", {
    fileName: file.name,
    contentType: file.type || "application/pdf",
    period: periodEl?.value || null,
    compare: compareEl?.value || null,
  });

  console.log("UPLOAD-URL RESPONSE:", j1);

  if (!j1.uploadUrl || !j1.blobUrl) {
    throw new Error(`upload-url missing uploadUrl/blobUrl: ${JSON.stringify(j1)}`);
  }

  // (B) رفع الملف إلى Azure Blob
  const put = await fetch(j1.uploadUrl, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });

  if (!put.ok) {
    const t = await put.text().catch(() => "");
    throw new Error(`PUT failed: ${put.status} ${t}`);
  }

  // (C) ✅ Router: /api/ingest
  const ingestPayload = {
    fileName: file.name,
    blobUrl: j1.blobUrl,
    contentType: file.type || "",
    period: periodEl?.value || null,
    compare: compareEl?.value || null,
  };

  const j2 = await callJson("/api/ingest", ingestPayload);
  console.log("INGEST RESPONSE:", j2);

  // (D) إذا رجع next + payload → نستدعي next تلقائيًا
  if (j2.next) {
    const nextUrl = j2.next; // مثال: "/api/analyze"
    const nextPayload = j2.payload || ingestPayload;

    const j3 = await callJson(nextUrl, nextPayload);
    console.log("NEXT RESPONSE:", j3);

    return j3; // هذا هو الناتج النهائي للواجهة
  }

  // لو ingest صار يرجّع النتائج مباشرة مستقبلاً
  return j2;
}

/* ==============================================
   🎯  Events
   ============================================== */

fileInput?.addEventListener("change", () => {
  selectedFiles = Array.from(fileInput.files || []);
  renderSelectedFiles();

  if (selectedFiles.length) {
    btnShow.disabled = false;
    setStatus(`تم اختيار ${selectedFiles.length} ملف ✅`, "ok");
  } else {
    btnShow.disabled = true;
    setStatus("لم يتم اختيار ملف.", "warn");
  }
});

btnClear?.addEventListener("click", () => {
  clearUI();
});

btnShow?.addEventListener("click", async () => {
  if (!selectedFiles.length) {
    setStatus("اختر ملف أولاً.", "warn");
    return;
  }

  btnShow.disabled = true;
  setStatus("جاري رفع الملف ثم التحليل عبر ingest...", "info");

  try {
    const data = await analyzeSingleFile(selectedFiles[0]);

    resultsSection?.classList.remove("hidden");

    const pages = data.pages ?? data.pageCount ?? 0;
    const tables = data.tables ?? data.tableCount ?? 0;
    const textLength = data.textLength ?? (data.text ? data.text.length : 0);

    cardsEl.innerHTML = `
      <div class="card">عدد الصفحات: <b>${pages}</b></div>
      <div class="card">عدد الجداول: <b>${tables}</b></div>
      <div class="card">طول النص: <b>${textLength}</b></div>
      <div class="card">
        <div class="muted small">Raw JSON (مختصر):</div>
        <pre class="small" style="white-space:pre-wrap;max-height:220px;overflow:auto;margin:8px 0 0;">${escapeHtml(
          JSON.stringify(data, null, 2).slice(0, 2500)
        )}</pre>
      </div>
    `;

    setStatus("تم استخراج البيانات بنجاح ✅", "ok");
  } catch (e) {
    console.error(e);
    setStatus(`حدث خطأ: ${e.message}`, "err");
  } finally {
    btnShow.disabled = false;
  }
});

clearUI();
