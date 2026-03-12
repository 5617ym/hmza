# PROJECT_STATE.md

PROJECT:
Financial Statement Extraction Engine

LAST_UPDATE:
2026-03-12

CURRENT_ENGINE_VERSION:
extract-financial-v6.7

CURRENT_PHASE:
PHASE 5 – Financial Statement Intelligence Layer

CURRENT_TASK:
تصميم وبناء Sector Detection Layer
لتحديد نوع الشركة قبل تطبيق Financial Mapping
داخل extract-financial.

القطاعات المستهدفة في البداية:

1. bank
2. insurance
3. reit
4. operating_company

------------------------------------------------------------
PHASE HISTORY
------------------------------------------------------------

PHASE 4A
Multi-Sector Validation

تم اختبار النظام على قطاعات متعددة للتأكد من قدرة
محرك استخراج القوائم المالية على التعامل مع اختلاف
هياكل التقارير المالية.

القطاعات التي تم اختبارها:

1. شركة تشغيلية عربية
2. شركة تشغيلية إنجليزية
3. بنك عربي
4. بنك إنجليزي
5. شركة تأمين
6. صندوق REIT
7. شركة صناعية

الشركات المستخدمة في الاختبار:

- جاهز
- المراعي
- مصرف الإنماء
- مصرف الراجحي
- التعاونية للتأمين
- جدوى ريت
- المتقدمة للبتروكيماويات

النتيجة:

النظام نجح في اكتشاف صفحات:

Balance Sheet  
Income Statement  
Cash Flow Statement  

ودعم:

- العربية
- الإنجليزية
- تقارير IFRS
- تقارير السوق السعودي

STATUS:
Stable


------------------------------------------------------------
PHASE 4B
Extraction Engine Hardening
------------------------------------------------------------

هدف المرحلة:

تقوية محرك extract-financial وتحسين
اختيار الصفحات الدلالي (Semantic Page Ranking)
لضمان استقرار الاستخراج عبر تقارير مالية مختلفة.

المشاكل التي تم حلها في هذه المرحلة:

1. Ranking instability
2. Ownership tables interference
3. Dense RTL table confusion
4. Row extraction instability
5. Recovery flooding
6. Bank eligibility failure
7. Note tables winning

التحسينات التي تمت إضافتها:

- Guarded template recovery
- Ownership table detection
- RTL label detection improvements
- Dense table protection logic
- Distinct label-column detection
- Bank relaxed eligibility path
- Strong semantic ranking signals
- Note table rejection penalty
- Multi-page merge protection
- Cross-statement ranking hardening

أهم الإضافات المعمارية:

Bank Title Dense Eligibility Path

يسمح بقبول صفحات القوائم البنكية
حتى عند ضعف anchor coverage إذا كانت:

- تحتوي عنوان قائمة قوي
- بنية جدول بنكي واضحة
- كثافة أرقام عالية

Note Table Strong Penalty

تمت إضافة عقوبة قوية للصفحات
التي تمثل جداول إيضاحات مالية مثل:

- Sensitivity tables
- Interest rate gaps
- Debt maturity schedules
- Bond / Sukuk tables

وذلك لمنعها من الفوز في
Statement Page Ranking.

STATUS:
COMPLETED

------------------------------------------------------------

SYSTEM PIPELINE (CURRENT)

upload-url  
→ ingest  
→ analyze (Azure Document Intelligence)  
→ extract-financial  

------------------------------------------------------------

SYSTEM PIPELINE (NEXT ARCHITECTURE)

upload  
→ ingest  
→ analyze  
→ sector-detection  
→ extract-financial  
→ financial-analysis  

------------------------------------------------------------

ENGINE CAPABILITIES

المحرك الحالي قادر على:

1. Statement Profile Detection
   - bank
   - insurance
   - reit
   - operating_company

2. Semantic Page Ranking

3. Table Structure Detection

4. Row Extraction with Validation

5. Guarded Recovery

6. Multi-page Protection

7. Structured Financial Output

------------------------------------------------------------

CURRENT STATUS

Architecture:
Stable

Extraction Engine:
Stable

Ranking Engine:
Stable

Row Extraction:
Stable

Multi-sector support:
Validated

------------------------------------------------------------

NEXT OBJECTIVE

PHASE 5
Financial Statement Intelligence Layer

الهدف:

إضافة طبقة ذكاء مالي للنظام بحيث يصبح
قادرًا على فهم نوع الشركة أولاً
ثم تطبيق Financial Mapping مناسب لكل قطاع.

المرحلة ستشمل:

1. Sector Detection Layer

اكتشاف نوع الشركة تلقائيًا اعتمادًا على:

- اسم الشركة
- مصطلحات القوائم المالية
- هيكل الميزانية
- مصطلحات النشاط

2. Financial Profiles

إنشاء Profiles مالية لكل قطاع:

profiles/

- bankProfile.js
- insuranceProfile.js
- operatingProfile.js
- reitProfile.js

كل Profile سيحتوي:

- financialMapping
- statementStructure
- keywordPatterns

3. Sector-Specific Financial Mapping

بدلاً من:

Universal Financial Mapping

سيصبح النظام يستخدم:

Sector-Specific Mapping

بناءً على القطاع المكتشف.

------------------------------------------------------------

LONG TERM VISION

تحويل النظام من:

PDF Financial Extractor

إلى:

Financial Intelligence Engine
