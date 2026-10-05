import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

/**
 * The secret `token` of an emailed link (reset password, verify email). Read once, then removed from the address bar so
 * it does not stay in the history, a screenshot or a shared URL (D-086). `index.html` sets `Referrer-Policy: no-referrer`.
 */
export function useLinkToken(): string | null {
  const [params, setParams] = useSearchParams();
  const [token] = useState(() => params.get('token'));
  useEffect(() => {
    if (params.has('token')) {
      setParams({}, { replace: true });
    }
  }, [params, setParams]);
  return token;
}
