/**
 * The Help Center's articles (MVP-119, D-185): URL slug → i18n key under `help.articles`. Their text lives in the
 * locale files, Arabic and English, like every UI string.
 */
export const HELP_ARTICLES = {
  'getting-started': 'gettingStarted',
  'invite-team': 'inviteTeam',
  'create-case': 'createCase',
  'parties-conflicts': 'partiesConflicts',
  hearings: 'hearings',
  documents: 'documents',
  tasks: 'tasks',
  'ai-summaries': 'aiSummaries',
  invoicing: 'invoicing',
  'client-portal': 'clientPortal',
  roles: 'roles',
  'data-export': 'dataExport',
  security: 'security',
} as const;

export type HelpSlug = keyof typeof HELP_ARTICLES;
export const HELP_SLUGS = Object.keys(HELP_ARTICLES) as HelpSlug[];
export const isHelpSlug = (value: string | undefined): value is HelpSlug =>
  value !== undefined && value in HELP_ARTICLES;

/**
 * Support contact, set per deployment (`VITE_SUPPORT_EMAIL`, `VITE_SUPPORT_WHATSAPP` in international digits, e.g.
 * 970591234567); a channel left unset is not offered.
 */
export const SUPPORT = {
  email: (import.meta.env['VITE_SUPPORT_EMAIL'] as string | undefined)?.trim() || null,
  whatsapp:
    (import.meta.env['VITE_SUPPORT_WHATSAPP'] as string | undefined)?.replace(/\D/g, '') || null,
};

/** A bug report email with what support needs: the page, the language and the time (never the page's data). */
export function bugReportHref(email: string, subject: string, locale: string): string {
  const body = [
    `Page: ${window.location.pathname}`,
    `Language: ${locale}`,
    `Time: ${new Date().toISOString()}`,
    'Reference (from the error message, if any):',
    '',
  ].join('\n');
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
