PROJECT_STATE.md

PROJECT:
Financial Statement Extraction Engine

LAST_UPDATE:
2026-03-13

CURRENT_ENGINE_VERSION:
extract-financial-v6.7

CURRENT_PHASE:
PHASE 5 – Financial Statement Intelligence Layer

CURRENT_TASK:
تصميم وبناء Sector Detection Layer
لتحديد نوع الشركة قبل تطبيق Financial Mapping
داخل extract-financial.

القطاعات المستهدفة في البداية:

bank

insurance

reit

operating_company

PHASE HISTORY

PHASE 4A
Multi-Sector Validation

تم اختبار النظام على قطاعات متعددة للتأكد من قدرة
محرك استخراج القوائم المالية على التعامل مع اختلاف
هياكل التقارير المالية.

القطاعات التي تم اختبارها:

شركة تشغيلية عربية

شركة تشغيلية إنجليزية

بنك عربي

بنك إنجليزي

شركة تأمين

صندوق REIT

شركة صناعية

الشركات المستخدمة في الاختبار:

جاهز

المراعي

مصرف الإنماء

مصرف الراجحي

التعاونية للتأمين

جدوى ريت

المتقدمة للبتروكيماويات

النتيجة:

النظام نجح في اكتشاف صفحات:

Balance Sheet
Income Statement
Cash Flow Statement

ودعم:

العربية

الإنجليزية

تقارير IFRS

تقارير السوق السعودي

STATUS:
Stable

PHASE 4B
Extraction Engine Hardening

هدف المرحلة:

تقوية محرك extract-financial وتحسين
اختيار الصفحات الدلالي (Semantic Page Ranking)
لضمان استقرار الاستخراج عبر تقارير مالية مختلفة.

المشاكل التي تم حلها في هذه المرحلة:

Ranking instability

Ownership tables interference

Dense RTL table confusion

Row extraction instability

Recovery flooding

Bank eligibility failure

Note tables winning

التحسينات التي تمت إضافتها:

Guarded template recovery

Ownership table detection

RTL label detection improvements

Dense table protection logic

Distinct label-column detection

Bank relaxed eligibility path

Strong semantic ranking signals

Note table rejection penalty

Multi-page merge protection

Cross-statement ranking hardening

أهم الإضافات المعمارية:

Bank Title Dense Eligibility Path

يسمح بقبول صفحات القوائم البنكية
حتى عند ضعف anchor coverage إذا كانت:

تحتوي عنوان قائمة قوي

بنية جدول بنكي واضحة

كثافة أرقام عالية

Note Table Strong Penalty

تمت إضافة عقوبة قوية للصفحات
التي تمثل جداول إيضاحات مالية مثل:

Sensitivity tables

Interest rate gaps

Debt maturity schedules

Bond / Sukuk tables

وذلك لمنعها من الفوز في
Statement Page Ranking.

STATUS:
COMPLETED

PHASE 4C
Sector Detection Stabilization

تم إضافة طبقة اكتشاف القطاع داخل النظام
لتمكين المحرك من فهم نوع الشركة قبل
تطبيق منطق التحليل المالي.

الإضافات التي تمت:

Sector Detection Engine

تم إنشاء وحدة:

api/_lib/sector-detection.js

تعتمد على:

keyword scoring

sector profiles

semantic signals داخل النص

القطاعات المدعومة حالياً:

bank

insurance

reit

operating_company

تحسينات مهمة:

Final Sector Resolution

تم إضافة منطق:

detectSector → statementProfile → finalSector

لضمان اختيار القطاع الصحيح.

Clean SectorInfo Output

تم تعديل بنية:

sectorInfo

بحيث تعكس القطاع النهائي الحقيقي
بدلاً من نتيجة الكشف الأولية.

مثال:

sector overridden by statement profile:
operating_company → reit

False Positive Bank Detection Fix

تم اكتشاف أن كلمات مثل:

financing

murabaha

تمويل

كانت تسبب تحويل شركات تشغيلية إلى قطاع البنوك.

تم إصلاح ذلك عبر:

رفع شرط bankHits من 2 إلى 3

إضافة شرط وجود مصطلح بنكي حقيقي مثل:

special commission
customer deposits
loans and advances
cash and balances with central banks
ودائع العملاء

النتيجة:

اختبارات القطاعات أصبحت مستقرة:

جاهز → operating_company ✔
المراعي → operating_company ✔
جدوى ريت → reit ✔
مصرف الإنماء → bank ✔

STATUS:
STABLE

SYSTEM PIPELINE (CURRENT)

upload-url
→ ingest
→ analyze (Azure Document Intelligence)
→ extract-financial

SYSTEM PIPELINE (NEXT ARCHITECTURE)

upload
→ ingest
→ analyze
→ sector-detection
→ extract-financial
→ financial-analysis

ENGINE CAPABILITIES

المحرك الحالي قادر على:

Statement Profile Detection

bank

insurance

reit

operating_company

Sector Detection Engine

Semantic Page Ranking

Table Structure Detection

Row Extraction with Validation

Guarded Recovery

Multi-page Protection

Structured Financial Output

CURRENT STATUS

Architecture:
Stable

Extraction Engine:
Stable

Ranking Engine:
Stable

Row Extraction:
Stable

Sector Detection:
Stable

Multi-sector support:
Validated

NEXT OBJECTIVE

PHASE 5
Financial Statement Intelligence Layer

الهدف:

إضافة طبقة ذكاء مالي للنظام بحيث يصبح
قادرًا على فهم نوع الشركة أولاً
ثم تطبيق Financial Mapping مناسب لكل قطاع.

المرحلة ستشمل:

Sector Detection Layer

اكتشاف نوع الشركة تلقائيًا اعتمادًا على:

اسم الشركة

مصطلحات القوائم المالية

هيكل الميزانية

مصطلحات النشاط

Financial Profiles

إنشاء Profiles مالية لكل قطاع:

profiles/

bankProfile.js
insuranceProfile.js
operatingProfile.js
reitProfile.js

كل Profile سيحتوي:

financialMapping

statementStructure

keywordPatterns

Sector-Specific Financial Mapping

بدلاً من:

Universal Financial Mapping

سيصبح النظام يستخدم:

Sector-Specific Mapping

بناءً على القطاع المكتشف.

LONG TERM VISION

تحويل النظام من:

PDF Financial Extractor

إلى:

Financial Intelligence Engine
