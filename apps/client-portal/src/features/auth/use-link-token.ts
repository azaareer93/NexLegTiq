import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

/**
 * The secret `token` of an emailed link (reset password, verify email). Read once, then removed from the address bar so
 * it is not in a screenshot, a copied URL or a later Referer (D-086; `index.html` also sets `no-referrer`). The browser's
 * history database may still hold the visited URL: what protects the token is that it is single use and short-lived.
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
