# PROJECT_STATE.md

CURRENT_PHASE: 3B (Extract Financial - Income Statement Stable + Balance Sheet Stable)

CURRENT_TASK:
المحافظة على استقرار استخراج قائمة الدخل وقائمة المركز المالي،
ثم الانتقال إلى بناء cashFlowLite بشكل متدرج وصحي
بدون كسر ما استقر في extract-financial.

المسار الحالي للنظام:

upload-url
→ ingest
→ analyze (Azure Document Intelligence - prebuilt-layout)
→ extract-financial

تم اختبار المسار كاملاً مع ملف PDF حقيقي بنجاح.

LAST_TEST:
رفع ملف:
"جاهز سنوي حالي #####.pdf"

النتائج في Network:

upload-url → 200
blob upload → 201
ingest → 200
analyze → 200
extract-financial → 200

LAST_RESULT:

- analyze يعمل الآن بشكل صحيح
- normalized.tablesPreview يتم إرجاعه بنجاح
- قائمة الدخل أصبحت مستقرة وتقرأ من الجدول الصحيح
- الأعمدة تم اكتشافها بشكل صحيح:
  latest = 2024
  previous = 2023
- parseNumberSmart يعمل بشكل صحيح مع الأرقام العربية والفواصل المختلطة
- extract-financial يستخرج incomeStatementLite بنجاح
- extract-financial يستخرج balanceSheetLite بنجاح
- تم تثبيت منطق الميزانية بنتائج محاسبية متماسكة:
  - nonCurrentAssets = 551,480,387
  - totalAssets = 1,770,075,646
  - currentAssets = 1,218,595,259
  - totalLiabilities = 520,635,218
  - currentLiabilities = 458,049,349
  - nonCurrentLiabilities = 62,585,869
  - totalEquity = 1,249,440,428
- تم استخدام اشتقاقات مساعدة صحيحة عند الحاجة:
  - totalAssets = totalLiabilities + totalEquity
  - currentAssets = totalAssets - nonCurrentAssets
  - nonCurrentLiabilities = totalLiabilities - currentLiabilities
- تم تأكيد أن المعادلة المحاسبية متماسكة
- تم الحفاظ على استقرار incomeStatementLite بدون كسر

ACTIVE_PROBLEM:

قائمة المركز المالي أصبحت مستقرة عملياً في هذا الملف الاختباري،
لكن cashFlowLite ما زال يرجع null
ويحتاج بناء منطق التقاط مستقل ومتدرج.

المشكلة الحالية ليست في Azure ولا في analyze،
بل في منطق extract-financial نفسه، تحديداً في:

1) تحديد الجدول الصحيح للتدفقات النقدية بثبات
2) التقاط صف النقد في نهاية السنة
3) التقاط صف النقد في بداية السنة
4) اشتقاق netChangeInCash بشكل صحيح
5) المحافظة على استقرار incomeStatementLite و balanceSheetLite

IMPORTANT_NOTE:

تم الاتفاق على عدم التشعب أو إعادة تغيير المنطق المستقر لقائمة الدخل والميزانية.
الأولوية الآن هي البناء الصحيح والمحافظة على الاستقرار،
وأي تطوير جديد يجب أن يكون محافظاً على ما يعمل بالفعل.

NEXT_STEP (غداً):

1) بناء cashFlowLite بشكل متدرج وصحي داخل extract-financial
2) تثبيت منطق التقاط:
   - endingCash
   - beginningCash
   - netChangeInCash
3) استخدام exact match أولاً ثم fallback منطقي عند الحاجة
4) اختبار نفس ملف PDF الحقيقي للتأكد من عدم كسر:
   - incomeStatementLite
   - balanceSheetLite

STATUS:
IN_PROGRESS
