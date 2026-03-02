# PROJECT_STATE.md

CURRENT_PHASE: 3B (Extract Financial - Stable Income Statement)

CURRENT_TASK:
تثبيت مسار استخراج قائمة الدخل من tablesPreview داخل /api/extract-financial
مع:

- اختيار أحدث سنة تلقائياً عند "بدون مقارنة"
- تفضيل 3 أشهر إذا كان التقرير ربعياً
- دعم المقارنة (أحدث سنة + السنة السابقة)
- تطبيع الأرقام العربية وتحويلها إلى Numbers حقيقية

LAST_TEST:
رفع ملف PDF (جاهز) + الضغط على "عرض النتائج".

تم تنفيذ المسار الكامل بنجاح:
upload-url → ingest → analyze → extract-financial

جميع الطلبات Status=200.

LAST_RESULT:
- pages / tables / textLength تظهر بشكل صحيح
- تم اختيار الأعمدة: latest=2024 و previous=2023
- تم حل مشكلة الأرقام العربية (مثل "٢٫٢١٨,٦٦٢٫٧٣٥")
- current أصبح رقم صحيح: 2218662735
- extract-financial يرجع بيانات منظمة داخل incomeStatementLite

ACTIVE_PROBLEM:
لا يوجد خطأ تقني حاليًا في مسار extract-financial.

ملاحظات:
- favicon.ico يظهر 404 (غير مؤثر)
- لم يتم بعد حساب نسب مالية (هوامش/نمو)

NEXT_STEP:
الانتقال إلى المرحلة 4:

أحد الخيارات التالية:
A) إضافة حساب النسب المالية داخل extract-financial (Margins + Growth)
B) استخراج قائمة المركز المالي بنفس المنهجية
C) تحسين الواجهة لعرض النتائج بشكل احترافي

STATUS:
IN_PROGRESS
