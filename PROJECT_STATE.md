# PROJECT_STATE.md

CURRENT_PHASE: 2B (Frontend Connection)

CURRENT_TASK:
ربط الواجهة لتبدأ بـ /api/ingest (بدلاً من /api/analyze)
مع دعم "auto-follow" إذا رجّع ingest حقول next/payload.

LAST_TEST:
DevTools Network أظهر أن الواجهة ما زالت تستدعي /api/analyze مباشرة
(initiator: main.js:102) مما أدى إلى 500 + "Empty response body".

LAST_RESULT:
بعد ترقية Document Intelligence إلى S0 أصبح التحليل يرجع صفحات صحيحة (مثال pages=30)،
لكن الواجهة تحتاج تعديل main.js لتستخدم ingest أولاً.

ACTIVE_PROBLEM:
main.js لا يزال يستخدم /api/analyze مباشرة؛ يجب استبدال main.js بالكامل بالكود الجديد
الذي يستدعي /api/ingest ثم يتبع next تلقائياً.

STATUS:
IN_PROGRESS
