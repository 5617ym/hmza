// عناصر الصفحة
const netProfitEl = document.getElementById("netProfit");
const cashFlowEl  = document.getElementById("cashFlow");
const btnAnalyze  = document.getElementById("btnAnalyze");
const resultEl    = document.getElementById("result");

const btnDemo     = document.getElementById("btnDemo");
const btnClear    = document.getElementById("btnClear");

const fileInput   = document.getElementById("fileInput");
const fileListEl  = document.getElementById("fileList");

// أدوات مساعدة
function fmtNumber(n){
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("ar-SA");
}

function bytesToSize(bytes){
  if (!Number.isFinite(bytes)) return "";
  const units = ["B","KB","MB","GB"];
  let i = 0;
  let v = bytes;
  while(v >= 1024 && i < units.length-1){
    v /= 1024; i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function stars(count){
  // count من 1 إلى 4
  return "⭐".repeat(count);
}

// تحليل جودة الربح
function analyzeProfitQuality(){
  const profit = parseFloat(netProfitEl.value);
  const cash   = parseFloat(cashFlowEl.value);

  if (!Number.isFinite(profit) || !Number.isFinite(cash) || profit === 0){
    resultEl.innerHTML = `⚠️ <span class="muted">أدخل أرقام صحيحة (صافي الربح لا يكون صفر).</span>`;
    return;
  }

  const ratio = (cash / profit) * 100;
  const ratioText = ratio.toFixed(1);

  // تصنيف بسيط (قابل للتعديل لاحقًا)
  if (ratio >= 100){
    resultEl.innerHTML = `<span class="r-good">جودة ربح ممتازة ${stars(4)}</span> — نسبة التحويل: <b>${ratioText}%</b>`;
  } else if (ratio >= 80){
    resultEl.innerHTML = `<span class="r-good">جودة جيدة ${stars(3)}</span> — نسبة التحويل: <b>${ratioText}%</b>`;
  } else if (ratio >= 60){
    resultEl.innerHTML = `<span class="r-warn">جودة متوسطة ${stars(2)}</span> — نسبة التحويل: <b>${ratioText}%</b>`;
  } else {
    resultEl.innerHTML = `<span class="r-bad">تحذير: جودة ضعيفة ${stars(2)}</span> — نسبة التحويل: <b>${ratioText}%</b>`;
  }
}

// تعبئة مثال
function fillDemo(){
  netProfitEl.value = 1000000;
  cashFlowEl.value  = 920000;
  analyzeProfitQuality();
}

// مسح
function clearAll(){
  netProfitEl.value = "";
  cashFlowEl.value  = "";
  resultEl.innerHTML = "";
  fileInput.value = "";
  fileListEl.innerHTML = "";
}

// عرض الملفات المرفوعة
function renderFiles(files){
  if (!files || files.length === 0){
    fileListEl.innerHTML = "";
    return;
  }

  const html = Array.from(files).map(f => {
    return `
      <div class="file-item">
        <div>
          <div class="file-name">📄 ${f.name}</div>
          <div class="file-size">${bytesToSize(f.size)} • ${f.type || "نوع غير معروف"}</div>
        </div>
        <div class="pill pill-good">تم الرفع</div>
      </div>
    `;
  }).join("");

  fileListEl.innerHTML = html;
}

// Events
btnAnalyze?.addEventListener("click", analyzeProfitQuality);
btnDemo?.addEventListener("click", fillDemo);
btnClear?.addEventListener("click", clearAll);

fileInput?.addEventListener("change", (e) => {
  renderFiles(e.target.files);
});
