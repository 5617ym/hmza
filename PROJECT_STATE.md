# PROJECT_STATE.md

CURRENT_PHASE: 3A (Arabic Numbers Normalization)

CURRENT_TASK:
تطبيع (تحويل) الأرقام العربية داخل tablesPreview إلى أرقام قياسية (1234.56)
لجعل البيانات قابلة للحساب والتحليل المالي لاحقاً.

LAST_TEST:
رفع PDF + ضغط "عرض النتائج" في الواجهة.
Network أظهر الطلبات التالية جميعها Status=200:
- /api/upload-url
- PUT blob
- /api/ingest
- /api/analyze
- /api/extract-financial

LAST_RESULT:
- الواجهة تعرض: pages/tables/textLength بشكل صحيح
- /api/extract-financial يعمل (200) عند إرسال normalized بشكل صحيح
- تم حل مشكلة "Missing normalized" ومشكلة 404 الخاصة بالـ extract-financial بعد إضافة function.json

ACTIVE_PROBLEM:
الأرقام داخل الجداول بصيغة عربية (٠١٢٣٤٥٦٧٨٩) وبفواصل عربية/رموز
مثل: "١,٦٢٣,١٦٠٫٩٧١" أو "٢١٠,٧٥٣٫٥٧٠"
ويجب تحويلها إلى رقم قياسي (1623160.971) مع دعم السالب بالأقواس (مثل "(١٢٣)")

NEXT_STEP:
1) إنشاء دالة داخل api/_lib مثل: parseArabicNumber(str)
   - تحويل ٠١٢٣٤٥٦٧٨٩ إلى 0123456789
   - استبدال "٫" إلى "." و"٬" إلى "," وإزالة الفواصل
   - دعم السالب: (123) => -123
2) تطبيق التحويل على جميع القيم الرقمية داخل normalized.tablesPreview[*].sample
3) إرجاع نتيجة extract-financial فيها:
   - meta: { pages, tables, textLength }
   - tablesPreviewNormalized: نفس الجداول لكن الأرقام صارت Numbers
4) اختبار سريع من الواجهة/Console أن القيم أصبحت Numbers وليست Strings

STATUS:
IN_PROGRESS
