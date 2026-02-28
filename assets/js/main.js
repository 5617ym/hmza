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

// يضمن قراءة JSON حتى لو السيرفر رجّع HTML/نص
async function safeJson(res) {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text || "{}");
  } catch (e) {
    throw new Error(`Response is not JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
}

/* ==============================================
   🚀 رفع الملف إلى Blob ثم تحليل عبر blobUrl
   ============================================== */
async function analyzeSingleFile(file) {
  // 1) طلب uploadUrl + blobUrl
  const r1 = await fetch("/api/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/pdf",
      period: periodEl?.value || null,
      compare: compareEl?.value || null,
    }),
  });

  const j1 = await safeJson(r1);
  window.lastUploadResult = j1;
  console.log("UPLOAD-URL:", j1);

  if (!r1.ok || !j1?.ok || !j1.uploadUrl || !j1.blobUrl) {
    throw new Error(`upload-url failed: ${JSON.stringify(j1)}`);
  }

  // 2) رفع الملف إلى Azure Blob
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

  // 3) تحليل الملف عبر /api/analyze
  const r2 = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      blobUrl: j1.blobUrl,
    }),
  });

  const data = await safeJson(r2);
  window.lastAnalyzeResult = data;
  console.log("ANALYZE:", data);

  if (!r2.ok) {
    throw new Error(`analyze http ${r2.status}: ${JSON.stringify(data)}`);
  }

  return data;
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

    if (!data?.ok) {
      setStatus(`الـ API رجّع خطأ: ${data?.error || "غير معروف"}`, "err");
      return;
    }

    // لا نسمح بـ undefined يظهر للمستخدم
    const pages = Number.isFinite(data.pages) ? data.pages : 0;
    const tables = Number.isFinite(data.tables) ? data.tables : 0;
    const textLength = Number.isFinite(data.textLength) ? data.textLength : 0;

    resultsSection?.classList.remove("hidden");
    if (cardsEl) {
      cardsEl.innerHTML = `
        <div>عدد الصفحات: ${pages}</div>
        <div>عدد الجداول: ${tables}</div>
        <div>طول النص: ${textLength}</div>
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
