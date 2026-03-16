# PROJECT_STATE.md

PROJECT:
Financial Statement Extraction Engine

LAST_UPDATE:
2026-03-16

CURRENT_ENGINE_VERSION:
extract-financial-v7.5

CURRENT_PHASE:
PHASE 5 – Financial Statement Intelligence Layer

CURRENT_TASK:
تثبيت قراءة المدخلات + تثبيت تشخيص الاستخراج
على ملف جدوى ريت، مع منع اختيار صفحات Cash Flow
الخاطئة عندما لا يوجد مرشح موثوق فعليًا.

بعد سلسلة اختبارات على:

jadwa-reit-layout.json

تم الوصول إلى نتيجة مهمة جدًا:

* مشكلة Input Resolution تم حلها
* meta.pages و meta.tables أصبحت تُقرأ بشكل صحيح
* pageContexts أصبحت تُبنى فعليًا
* selectedPages لم تعد null
* Balance extraction أصبح يعمل
* Income extraction تم تشخيص فشله بدقة
* Cash Flow false positives تم منعها
* النظام أصبح يُرجع cashFlowPage = null
  بدل اختيار صفحة خاطئة ومضللة

التركيز الحالي أصبح على:

* تثبيت السلوك الصحيح عند نقص البيانات الفعلية في payload
* جعل النظام يرفض الاستخراج الخاطئ بدل اختراع نتائج
* توضيح سبب الفشل داخل debug بشكل صريح
* الحفاظ على نجاح Balance extraction
* اعتبار بعض الملفات حالات تشخيصية ناجحة
  حتى لو لم تكتمل جميع القوائم بسبب نقص بيانات المصدر

القوائم المستهدفة:

* Income Statement
* Balance Sheet
* Cash Flow Statement

---

## PHASE HISTORY

PHASE 4A
Multi-Sector Validation

تم اختبار النظام على قطاعات متعددة للتأكد من قدرة
محرك استخراج القوائم المالية على التعامل مع اختلاف
هياكل التقارير المالية.

القطاعات التي تم اختبارها:

* شركة تشغيلية عربية
* شركة تشغيلية إنجليزية
* بنك عربي
* بنك إنجليزي
* شركة تأمين
* صندوق REIT
* شركة صناعية

الشركات المستخدمة في الاختبار:

* جاهز
* المراعي
* مصرف الإنماء
* مصرف الراجحي
* التعاونية
* جدوى ريت
* المتقدمة

النتيجة:

النظام أثبت القدرة على العمل عبر قطاعات متعددة
مع اختلاف كبير في شكل القوائم المالية.

---

PHASE 4B
Extraction Engine Hardening

تم تقوية منطق اختيار الصفحات المالية باستخدام:

Ranking System
+
Penalties
+
Structure Signals

الهدف كان تقليل التقاط:

صفحات الإيضاحات
بدلاً من القوائم المالية الفعلية.

أهم التحسينات:

* تحسين اكتشاف صفحة قائمة الدخل
* تحسين اكتشاف صفحة المركز المالي
* تحسين اكتشاف صفحة التدفقات النقدية
* إضافة penalties للصفحات المتأخرة
* تقليل فوز صفحات الملاحظات
* دعم أفضل لاختلاف القطاع

---

PHASE 5
Financial Statement Intelligence Layer

بدأت هذه المرحلة لإضافة فهم مالي أعمق للنظام
بدلاً من الاعتماد فقط على كلمات عامة.

الطبقات التي تم بناؤها داخل هذه المرحلة:

1️⃣ Sector Detection Layer

يقوم النظام باكتشاف نوع الشركة مثل:

Bank
Insurance
REIT
Operating Company

ثم يغير منطق التحليل بناءً على القطاع.

---

2️⃣ Sector-Aware Statement Ranking

طريقة Ranking للقوائم المالية أصبحت تعتمد على القطاع
وليس فقط الكلمات العامة.

---

3️⃣ Multi-Page Statement Continuation Detection

تم بناء منطق يسمح للنظام باكتشاف:

امتداد القوائم المالية عبر أكثر من صفحة.

بدلاً من إرجاع:

صفحة واحدة فقط

أصبح النظام قادرًا على إرجاع:

Page Range

مثل:

income:
[8,9]

balance:
[95,96]

cashflow:
[14]

---

4️⃣ StatementSelectionResolved Layer

تم إدخال طبقة جديدة داخل المخرجات النهائية للنظام:

statementSelectionResolved

هذه الطبقة تعيد لكل قائمة:

basePage
+
pages
+
pageContexts

مما يسمح للمراحل القادمة من النظام
بالعمل على جميع صفحات القائمة
وليس فقط صفحة البداية.

---

5️⃣ Ranking Stabilization Improvements

تم تنفيذ تحسينات إضافية على Ranking
لتقليل فوز الصفحات العامة أو الصفحات
التي تحتوي كلمات جزئية فقط.

أهم ما تم تحسينه:

* تقوية noTitle penalty
* تقوية noTitleNoStructure penalty
* تحسين حل التعارض بين Income و Balance
* تقوية negativeHits penalty
* تقليل تأثير years + numbers فقط
* إضافة حماية خاصة لصفحات Cash Flow
* إضافة fallback محدود لصفحات Cash Flow الطويلة

---

6️⃣ Audit Narrative Protection

تم إضافة حماية خاصة لمنع الصفحات الخاصة بالمراجعة مثل:

Key Audit Matters
أمور المراجعة الرئيسية
تقرير المراجع

من الفوز في Ranking.

تم إضافة penalty:

auditNarrativePenalty

الذي يمنع هذه الصفحات من الفوز حتى لو
احتوت على كلمات مثل "قائمة الدخل".

---

7️⃣ Continuation Threshold Stabilization

تم رفع حد قبول الصفحة التالية داخل:

detectStatementContinuation()

من:

nextEval.score >= 55

إلى:

nextEval.score >= 65

الهدف:

تقليل ضم الصفحات الضعيفة
التي قد تبدو مشابهة جزئيًا
لكنها ليست استمرارًا فعليًا للقائمة.

---

8️⃣ Financial Line Item Extraction Preparation

تم البدء في بناء طبقة استخراج البنود المالية نفسها،
وليس فقط اختيار صفحات القوائم.

تم العمل على:

* collectNumericRows
* repairMissingLabelsFromPageText
* extractRowsFromPageContext
* dedupeExtractedRows
* buildExtractionDiagnostics

الهدف كان:

استخراج صفوف القوائم المالية مع:

label
+
note
+
currentYear
+
previousYear
+
source
+
rawRow

---

9️⃣ Input Resolution Hardening

أثناء اختبار ملف:

jadwa-reit-layout.json

ظهر أن النظام في بعض الحالات يرجع:

* pages = 0
* tables = 0
* selectedPages = null
* ranking = []
* stageDiagnostics = []
* financialRows = []

رغم أن ملف الاختبار نفسه يحتوي فعليًا على:

* pages = 34
* tables = 32
* textLength = 77227

لذلك تم إدخال طبقة جديدة لفهم المدخلات بشكل أكثر احترافية:

* isPlainObject
* isNonEmptyObject
* looksLikeNormalizedPayload
* extractNormalizedCandidate
* resolveInputEnvelope
* readLocalTestPayload

الهدف من هذه الطبقة:

حل مشكلة أن extract-financial كان أحيانًا
يفترض شكلًا واحدًا فقط للمدخلات،
بينما الواقع أن الـ payload قد يصل بأكثر من شكل مثل:

* req.body.normalized
* req.body
* local file envelope
* local raw normalized
* data.normalized
* payload.normalized
* result.normalized

---

🔟 Debug Input Resolution Layer

تم إضافة debug واضح إلى المخرجات النهائية
حتى نعرف بدقة أين الخلل عند كل اختبار.

الطبقة الجديدة داخل debug:

inputResolution

وتعرض:

* source
* localTestPath
* localFileExists
* reqBodyKeys
* envelopeKeys
* normalizedKeys
* resolvedPagesCount
* resolvedTablesCount

الهدف:

منع العمل الأعمى
وجعل أي فشل لاحق واضح المصدر:
هل المشكلة من الكود؟
أم من شكل payload؟
أم من الملف المحلي؟
أم من طريقة الاستدعاء؟

---

1️⃣1️⃣ Missing Label Diagnostics Layer

بعد نجاح قراءة المدخلات واختيار الصفحات،
ظهر أن بعض الصفحات المالية الصحيحة
قد لا تحتوي على labels داخل الـ payload نفسه.

تمت إضافة طبقة تشخيص جديدة داخل:

debug.stageDiagnostics.[statement].perPage[].missingLabelDiagnostics

هذه الطبقة توضح:

* likelyMissingLabelsInPayload
* acceptableTextCandidatesCount
* noteLikeOrRejectedRawLabelsCount
* acceptedLabelCountAfterRepair
* reason

أهم فائدة:

منع الفشل الصامت في extraction،
وجعل النظام يصرح بوضوح عندما تكون
المشكلة من نقص بيانات المصدر نفسها
وليس من منطق الاستخراج فقط.

---

1️⃣2️⃣ Cash Flow False Positive Prevention

خلال اختبار جدوى ريت،
ظهر أن النظام قد يختار صفحات خاطئة كـ Cash Flow
مثل:

* Asset Rollforward pages
* Index pages
* Single numeric column pages
* صفحات رقمية عامة بلا structure خاص بالتدفقات

لذلك تم تنفيذ طبقات حماية إضافية مثل:

* assetRollforwardPenalty
* حمايات ضد index / الفهرس / الصفحة
* منع قبول single_numeric_column كـ cashflow
  بدون أدلة قوية
* منع قبول labels الرقمية كسلاسل نصية
* تحويل النتيجة إلى:

cashFlowPage = null

عندما لا يوجد مرشح موثوق فعليًا

الهدف:

أن يكون النظام صادقًا،
فيرفض القوائم الخاطئة
بدل أن يُرجع استخراجًا مضللًا.

---

## LATEST VALIDATION RESULT

آخر اختبار مهم على ملف:

jadwa-reit-layout.json

أظهر ما يلي:

* meta.pages = 34
* meta.tables = 32
* textLength = 77227
* inputResolution يعمل بشكل صحيح
* selectedPages أصبحت:
  * incomePage = 8
  * balancePage = 7
  * cashFlowPage = null

* statementSelectionResolved يعمل
* Balance extraction يعمل فعليًا
* financialRows.balance غير فارغة
* financialRows.income = []
* financialRows.cashflow = []

لكن الأهم:

### Income
تم إثبات أن الصفحة المختارة صحيحة تقريبًا،
لكن الـ payload لا يحتوي على labels فعلية لبنود قائمة الدخل،
لذلك أصبح النظام يوضح صراحة:

reason = income_labels_missing_from_payload

### Cash Flow
تم منع النظام من اختيار صفحات خاطئة
كقائمة تدفقات نقدية.

والنتيجة النهائية أصبحت:

* cashFlowPage = null
* financialRows.cashflow = []

وهذه نتيجة صحيحة وأفضل من استخراج خاطئ.

---

## CURRENT_STATUS

المحرك الآن يمتلك فعليًا:

✔ Sector Detection
✔ Sector-Aware Ranking
✔ Continuation Detection
✔ StatementSelectionResolved
✔ Input Resolution Debugging
✔ Missing Label Diagnostics
✔ Cash Flow False Positive Prevention
✔ Balance extraction working
✔ سلوك أكثر صدقًا عند نقص البيانات أو غياب مرشح موثوق

لكن ما زال غير محسوم بالكامل في هذه اللحظة:

✖ Income extraction على الملفات التي لا تحتوي labels داخل payload
✖ Cash Flow extraction على هذا الملف تحديدًا لعدم وجود مرشح موثوق
✖ تعميم نفس الاستقرار على ملفات اختبار إضافية
✖ توسيع hardening على حالات sector-specific الأكثر صعوبة

المعنى العملي:

المعمارية الأساسية أصبحت أقوى وأكثر نضجًا،
وتم تجاوز اختناق Input Resolution بالكامل،
لكن ما تبقى الآن هو hardening أوسع
على ملفات جديدة وحالات edge cases إضافية.

---

## NEXT STEP

الخطوة القادمة:

الانتقال من ملف جدوى ريت إلى ملفات اختبار جديدة
مع الحفاظ على نفس البناء الحالي.

الهدف من الخطوة التالية:

* التأكد أن نجاح Input Resolution ثابت
* التأكد أن Balance extraction ثابت عبر ملفات أخرى
* اختبار هل مشكلة Income labels
  خاصة بجدوى ريت فقط
  أم متكررة في ملفات مشابهة
* اختبار Cash Flow على ملف يحتوي قائمة تدفقات
  أوضح وأكثر اكتمالًا
* توسيع hardening تدريجيًا
  بدون كسر السلوك الصحيح الحالي

---

## DEFINITION OF DONE

تعتبر هذه المرحلة مكتملة عندما يصبح النظام قادرًا على:

* قراءة normalized payload بشكل صحيح من جميع مصادر الإدخال المعتمدة
* اكتشاف القطاع
* اختيار نوع القوائم حسب القطاع
* تحديد صفحة بداية القائمة
* اكتشاف امتداد القائمة عبر الصفحات
* إرجاع Page Range للقائمة
* تقليل فوز الصفحات العامة في Ranking
* منع صفحات Audit Narrative من الفوز
* منع ضم صفحة قائمة أخرى كاستمرار خاطئ
* بناء statementSelectionResolved بشكل صحيح
* تشغيل Financial Line Item Extraction على صفحات مالية صحيحة
* إرجاع financialRows غير فارغة عند وجود بيانات مالية فعلية
* التصريح بوضوح عند غياب labels أو غياب مرشح موثوق
* الحفاظ على استقرار المعمارية الحالية

---

## KNOWN RULE

لا يتم تغيير المعمارية العامة.

لا يتم كسر البناء الحالي.

أي تحسين يجب أن يكون:

Layer فوق النظام الحالي

وليس إعادة بناء من الصفر.

الأولوية الحالية لم تعد Input Resolution،
لأنها حُسمت في هذا الملف،
بل أصبحت:

* hardening أوسع
* تحسين robustness
* وتوسيع التغطية على ملفات اختبار إضافية

مع الحفاظ على الصدق التشخيصي
بدل استخراج نتائج خاطئة.
