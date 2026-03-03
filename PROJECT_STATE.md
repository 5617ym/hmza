# PROJECT_STATE.md

CURRENT_PHASE: 3B (Extract Financial - Stable Income Statement) ✅ مكتملة تقنياً

CURRENT_TASK:
تثبيت مسار استخراج قائمة الدخل من tablesPreview داخل /api/extract-financial مع:
- اختيار أحدث سنة تلقائياً عند "بدون مقارنة"
- تفضيل 3 أشهر إذا كان التقرير ربعياً
- دعم المقارنة داخل نفس الملف (أحدث سنة + السنة السابقة)
- تطبيع الأرقام العربية وتحويلها إلى Numbers حقيقية

LAST_TEST:
رفع ملف PDF (جاهز) + الضغط على "عرض النتائج"
المسار الكامل اشتغل بنجاح:
upload-url → ingest → analyze → extract-financial
جميع الطلبات Status=200

LAST_RESULT:
- pages / tables / textLength تظهر بشكل صحيح
- اختيار الأعمدة يعمل:
  - latest=2024
  - previous=2023 (عند المقارنة)
- تطبيع الأرقام العربية تم بنجاح (مثال: "٢٫٢١٨,٦٦٢٫٧٣٥")
- current أصبح رقم صحيح: 2218662735
- extract-financial يرجع بيانات منظمة داخل incomeStatementLite
- selectionPolicy يعكس اختيار المستخدم (noCompare / compare / 2 files)

ACTIVE_PROBLEM:
لا يوجد خطأ تقني حاليًا في مسار extract-financial.
ملاحظات غير مؤثرة:
- favicon.ico يظهر 404 (غير مؤثر)

DECISION:
إغلاق المرحلة 3B (Definition of Done تحقق ✅)

NEXT_STEP:
الانتقال إلى المرحلة 4 (اختيار مسار واحد فقط وعدم التشعب):
B) استخراج قائمة المركز المالي (Balance Sheet) بنفس المنهجية
- تشغيل DIAG لاختيار أفضل جدول ميزانية
- تثبيت استخراج أصول/التزامات/حقوق ملكية
- دعم نفس سياسة المقارنة (بدون مقارنة / مقارنة داخل نفس الملف / ملفين)

STATUS:
READY_FOR_NEXT_PHASE
