---
name: rtl-i18n
description: Arabic/English localization and RTL rules for NexLegTiq UI and emails/PDFs — key naming, MSA glossary use, logical CSS, bidi isolation, formatting of dates/numbers/currency, and verification steps. Use for any change that adds or edits user-visible text or layout.
---
# RTL & i18n checklist

1. **Keys**: `packages/shared-i18n/src/locales/{ar,en}/<namespace>.json`; key = `feature.section.item` (e.g. `cases.list.empty.title`).
   Enum labels: `enums.<enumName>.<VALUE>`. Errors: `errors.<CODE>`. Add to **both** locales in the same change.
2. **Arabic copy**: formal MSA, legal terms from `docs/context/glossary.md`, no transliterated English, gender-neutral imperative forms
   for buttons (e.g. «إنشاء ملف», «حفظ», «إلغاء»). Pluralization via i18next plural keys (`_zero, _one, _two, _few, _many, _other` for ar).
3. **Layout**: logical properties (`margin-inline-start`, `inset-inline-end`, `text-align: start`), flex `gap`, no fixed text widths;
   AntD components handle direction via `ConfigProvider` — don't override with physical styles.
4. **Bidi**: wrap file numbers, phone numbers, emails, URLs, amounts, and mixed-script names in `<Ltr>`/`<bdi>`; tables with numeric
   columns align `end`.
5. **Icons**: arrows/chevrons/back/undo mirror in RTL (`<DirectionalIcon>`); checkmarks, play, logos don't.
6. **Formatting**: `useFormat()` in components (`date`, `dateTime`, `time`, `relative`, `number`, `money`), or `formatDate(value,
   { locale, timeZone, digits })` / `formatMoney(decimalString, currency, opts)` from `shared-utils`: dd/MM/yyyy, ص/م, MSA months,
   Western digits unless the user prefers Arabic-Indic, money as decimal strings with half-even rounding (D-092). Formatted
   money and long dates are already in the reading direction: `<Bdi>` at most, never `<Ltr>`.
7. **Emails/PDFs**: templates per locale (`templates/<name>.<locale>.hbs`), `dir` on root, Arabic font embedded (Amiri).
   The UI uses IBM Plex Sans Arabic, self-hosted by shared-ui (D-088).
8. **Verify**: Storybook Language toolbar (Arabic RTL / English LTR) and a11y panel; render tests inside `<NexProvider userLocale="ar">`
   (stories are also run as tests in both languages with axe); Cypress journey in `ar`; screenshot both in the PR.
