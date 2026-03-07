# PROJECT_STATE.md

CURRENT_PHASE: 3B (Extract Financial - Income Statement Stable + Balance Sheet Improving)

CURRENT_TASK:
تثبيت مسار استخراج قائمة الدخل والمحافظة على استقراره،
ثم تحسين استخراج قائمة المركز المالي بدون كسر البناء الحالي،
مع بدء تجهيز خطوة دمج sample + sampleTail لرفع دقة الالتقاط.

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
- extract-financial يستخرج balanceSheetLite جزئياً بنجاح
- تم الوصول لاستخراج منطقي جيد في الميزانية:
  - totalLiabilities
  - totalEquity
  - nonCurrentAssets
  - currentLiabilities
- تم تفعيل اشتقاقات مساعدة لتعويض القيم الناقصة:
  - totalAssets = totalLiabilities + totalEquity
  - currentAssets = totalAssets - nonCurrentAssets
  - nonCurrentLiabilities = totalLiabilities - currentLiabilities

ACTIVE_PROBLEM:

استخراج قائمة المركز المالي لم يصل بعد لمرحلة "مستقر تماماً" لأن الالتقاط ما زال يعتمد على sample/sampleTail بشكل جزئي،
وبعض البنود قد تُلتقط بصياغة غير مثالية أو من صف قريب بدلاً من صف الإجمالي النهائي في بعض التقارير.

المشكلة الحالية ليست في Azure ولا في analyze،
بل في منطق extract-financial نفسه، تحديداً في:

1) دقة اختيار صفوف الميزانية
2) الاعتماد على label matching فقط
3) الحاجة لدمج sample + sampleTail بشكل أقوى ومنهجي
4) الحاجة لتحسين اكتشاف الصف الإجمالي الحقيقي لكل بند
5) تجنب أي تعديل يكسر استقرار قائمة الدخل الحالية

IMPORTANT_NOTE:

تم الاتفاق على عدم التشعب أو إعادة تغيير المنطق المستقر لقائمة الدخل.
الأولوية الآن هي البناء الصحيح والمحافظة على الاستقرار،
وأي تطوير جديد يجب أن يكون محافظاً على ما يعمل بالفعل.

NEXT_STEP (غداً):

1) تنفيذ خطوة sample + sampleTail merge بشكل منظم داخل extract-financial
2) تحسين قراءة صفوف الميزانية من الجدول الصحيح بدون كسر incomeStatementLite
3) تثبيت منطق التقاط:
   - totalAssets
   - currentAssets
   - nonCurrentAssets
   - totalLiabilities
   - currentLiabilities
   - nonCurrentLiabilities
   - totalEquity
4) بعد استقرار الميزانية ننتقل للخطوة التالية:
   - cashFlowLite

STATUS:
IN_PROGRESS
