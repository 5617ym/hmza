console.log("main.js loaded ✅");

document.addEventListener("DOMContentLoaded", () => {

  const fileInput = document.getElementById("fileInput");
  const btnShow = document.getElementById("btnShow");
  const btnClear = document.getElementById("btnClear");
  const status = document.getElementById("status");

  // تعطيل الزر في البداية
  btnShow.disabled = true;

  // عند اختيار ملف → فعل الزر
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      btnShow.disabled = false;
      status.textContent = "تم اختيار ملف ✅";
    } else {
      btnShow.disabled = true;
      status.textContent = "";
    }
  });

  // زر مسح
  if (btnClear) {
    btnClear.addEventListener("click", () => {
      fileInput.value = "";
      btnShow.disabled = true;
      status.textContent = "تم المسح";
    });
  }

  // زر عرض النتائج
  btnShow.addEventListener("click", async () => {

    const file = fileInput.files[0];

    if (!file) {
      alert("اختر ملف أولاً");
      return;
    }

    status.textContent = "جاري رفع الملف...";

    const reader = new FileReader();

    reader.onload = async function () {
      try {

        const base64 = reader.result;

        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            fileName: file.name,
            fileBase64: base64,
          }),
        });

        const result = await response.json();

        console.log("API Response:", result);

        status.textContent = "تم الإرسال بنجاح ✅";

        alert(JSON.stringify(result, null, 2));

      } catch (err) {
        console.error(err);
        status.textContent = "حدث خطأ ❌";
      }
    };

    reader.readAsDataURL(file);

  });

});
