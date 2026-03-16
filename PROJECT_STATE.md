# PROJECT_STATE.md

PROJECT:
Financial Statement Extraction Engine

LAST_UPDATE:
2026-03-16

CURRENT_ENGINE_VERSION:
extract-financial-v7.1

CURRENT_PHASE:
PHASE 5 – Financial Statement Intelligence Layer

CURRENT_TASK:
تشخيص وحل مشكلة Input Resolution داخل extract-financial
بعد ظهور أن النظام لا يقرأ normalized payload بشكل صحيح
في بعض الاختبارات، مما أدى إلى:

* meta.pages = 0
* meta.tables = 0
* selectedPages = null
* ranking arrays فارغة
* financialRows فارغة

التركيز الحالي كان على:

* التأكد من مصدر البيانات الداخلة إلى extract-financial
* منع الاعتماد الأعمى على req.body.normalized فقط
* دعم أكثر من شكل محتمل للـ payload
* إضافة طبقة Debug واضحة لمعرفة هل المشكلة من:
  * input payload
  * local test file
  * input envelope
  * normalized resolution

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

لكن هذه الطبقة لم تُعتبر مستقرة بعد
لأن المشكلة الأساسية ظهرت في Input Resolution
قبل الوصول إلى اختبار نهائي موثوق للاستخراج.

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

## LATEST VALIDATION RESULT

آخر عمل اليوم لم يثبت نجاحًا نهائيًا في اختيار الصفحات
أو استخراج البنود على ملف جدوى ريت بعد إدخال
طبقة Input Resolution الجديدة.

آخر نتيجة مهمة أظهرت:

* meta.pages = 0
* meta.tables = 0
* textLength = 0
* selectedPages = null
* ranking arrays فارغة
* stageDiagnostics فارغة
* financialRows فارغة

وهذا أكد أن المشكلة الحالية ليست في Ranking فقط،
وليست في Continuation فقط،
بل في مرحلة أسبق وهي:

Input Resolution / Normalized Payload Resolution

النتيجة المهمة:

تم تحديد أن الأولوية الحالية يجب أن تكون
تثبيت قراءة المدخلات بشكل صحيح أولًا
قبل الحكم على طبقات Ranking أو Financial Row Extraction.

---

## CURRENT_STATUS

المحرك الآن يمتلك فعليًا:

✔ Sector Detection
✔ Sector-Aware Ranking
✔ Continuation Detection
✔ StatementSelectionResolved
✔ بداية طبقة Financial Line Item Extraction
✔ طبقة Input Resolution Debugging
✔ تشخيص أوضح لنقطة الفشل الحالية

لكن ما زال غير محسوم بالكامل في هذه اللحظة:

✖ ثبات قراءة normalized payload في جميع حالات الاختبار
✖ ثبات selectedPages بعد إدخال تعديلات input resolution
✖ ثبات ranking outputs بعد نفس التعديلات
✖ تفعيل Financial Line Item Extraction على مخرجات صحيحة
✖ اعتماد نتيجة نهائية مستقرة على ملف جدوى ريت في آخر اختبار

المعنى العملي:

المعمارية الأساسية قوية،
لكن يوجد اختناق حالي في نقطة ربط المدخلات
قبل انتقال البيانات لباقي الطبقات.

---

## NEXT STEP

الخطوة القادمة:

تثبيت Input Resolution بشكل نهائي
ثم إعادة اختبار نفس ملف:

jadwa-reit-layout.json

بحيث يتحقق التالي أولًا:

* meta.pages > 0
* meta.tables > 0
* pageContexts يتم بناؤها فعليًا
* ranking arrays تحتوي نتائج
* selectedPages لا تكون null

بعد ذلك فقط:

إعادة تقييم
Ranking
+
Continuation Detection
+
Financial Line Item Extraction

على نفس الملف
قبل الانتقال لاختبارات أوسع على ملفات أخرى.

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
* الحفاظ على استقرار المعمارية الحالية

---

## KNOWN RULE

لا يتم تغيير المعمارية العامة.

لا يتم كسر البناء الحالي.

أي تحسين يجب أن يكون:

Layer فوق النظام الحالي

وليس إعادة بناء من الصفر.

الأولوية الحالية ليست إضافة مزيد من الذكاء،
بل تثبيت صحة مرور البيانات
من input
إلى normalized
إلى ranking
إلى extraction.
