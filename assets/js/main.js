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

// ✅ parser آمن حتى لو السيرفر رجّع نص/فارغ
async function safeJson(res) {
  const txt = await res.text().catch(() => "");
  if (!txt) return { ok: false, error: `Empty response (HTTP ${res.status})` };
  try {
    return JSON.parse(txt);
  } catch (e) {
    return { ok: false, error: "Invalid JSON from server", details: txt.slice(0, 800) };
  }
}

function setStatus(msg, type = "info") {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.className = "";
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

function renderSelectedFiles() {
  if (!fileListEl) return;

  if (!selectedFiles.length) {
    fileListEl.innerHTML = `<div>لم يتم اختيار أي ملف.</div>`;
    return;
  }

  fileListEl.innerHTML = selectedFiles
    .map((f) => `<div>${f.name} - ${f.size.toLocaleString()} bytes</div>`)
    .join("");
}

/* ==============================================
   🚀 upload-url -> PUT -> analyze(blobUrl)
   ============================================== */
async function analyzeSingleFile(file) {
  if (!file) throw new Error("لا يوجد ملف");

  const fileName = file.name;
  const contentType = file.type || "application/octet-stream";

  // 1) طلب uploadUrl + blobUrl
  const r1 = await fetch("/api/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName,
      contentType,
      period: periodEl?.value || null,
      compare: compareEl?.value || null,
    }),
  });

  const j1 = await safeJson(r1);
  if (!r1.ok || !j1?.ok) {
    throw new Error(`upload-url failed: ${JSON.stringify(j1)}`);
  }

  if (!j1.uploadUrl || !j1.blobUrl) {
    throw new Error(`upload-url ناقص (uploadUrl/blobUrl): ${JSON.stringify(j1)}`);
  }

  // 2) رفع الملف إلى Azure Blob
  const put = await fetch(j1.uploadUrl, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": contentType,
    },
    body: file,
  });

  if (!put.ok) {
    const t = await put.text().catch(() => "");
    throw new Error(`PUT failed: ${put.status} ${t}`);
  }

  // 3) تحليل الملف عبر blobUrl
  const r2 = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName,
      blobUrl: j1.blobUrl,
    }),
  });

  const j2 = await safeJson(r2);

  // مفيد للتشخيص في console
  window.lastUploadResult = { upload: j1, analyze: j2 };

  if (!r2.ok || !j2?.ok) {
    throw new Error(`analyze failed: ${JSON.stringify(j2)}`);
  }

  return j2;
}

/* ==============================================
   🎯 Events
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
  setStatus("جاري رفع الملف ثم التحليل...", "info");

  try {
    const data = await analyzeSingleFile(selectedFiles[0]);

    resultsSection?.classList.remove("hidden");
    if (cardsEl) {
      cardsEl.innerHTML = `
        <div>عدد الصفحات: ${data.pages}</div>
        <div>عدد الجداول: ${data.tables}</div>
        <div>طول النص: ${data.textLength}</div>
      `;
    }

    setStatus("تم استخراج البيانات بنجاح ✅", "ok");
  } catch (e) {
    console.error(e);
    setStatus(`حدث خطأ: ${e.message}`, "err");
  } finally {
    btnShow.disabled = false;
  }
});

clearUI();
