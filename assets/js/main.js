const fileInput = document.querySelector('input[type="file"]');
const showBtn = document.querySelector('.btn-primary');
const clearBtn = document.querySelector('.btn-ghost');

let selectedFiles = [];

/* عند اختيار ملف */
fileInput.addEventListener('change', function () {
    selectedFiles = Array.from(this.files);

    if (selectedFiles.length > 0) {
        console.log("تم اختيار ملفات:");
        selectedFiles.forEach(file => console.log(file.name));
        alert(`تم اختيار ${selectedFiles.length} ملف`);
    }
});

/* عرض النتائج */
showBtn.addEventListener('click', function () {

    if (selectedFiles.length === 0) {
        alert("⚠️ الرجاء اختيار ملف أولاً");
        return;
    }

    alert("✅ تم رفع الملف بنجاح (حالياً محاكاة فقط)");
});

/* مسح */
clearBtn.addEventListener('click', function () {
    fileInput.value = "";
    selectedFiles = [];
    alert("تم مسح الملفات");
});
