import { AdminPaymentSchema, PaymentReceiptSchema } from '@nexlegtiq/shared-contracts';
import type {
  AdminPayment,
  PaymentReceipt,
  RecordPaymentRequest,
} from '@nexlegtiq/shared-contracts';
import { z } from 'zod';

import type { ApiClient } from './api-client.js';

const PaymentsSchema = z.array(AdminPaymentSchema);

/** Platform admin: an office's manual payments and their receipts (MVP-170). */
export function adminPaymentsApi(client: ApiClient) {
  const payment = (id: string) => `admin/payments/${encodeURIComponent(id)}`;
  const office = (id: string) => `admin/offices/${encodeURIComponent(id)}/payments`;
  return {
    list: (officeId: string, signal?: AbortSignal): Promise<AdminPayment[]> =>
      client.request({ method: 'GET', path: office(officeId), signal }, PaymentsSchema),
    record: (officeId: string, body: RecordPaymentRequest): Promise<AdminPayment> =>
      client.request({ method: 'POST', path: office(officeId), body }, AdminPaymentSchema),
    void: (id: string, reason: string): Promise<AdminPayment> =>
      client.request(
        { method: 'POST', path: `${payment(id)}/void`, body: { reason } },
        AdminPaymentSchema,
      ),
    /** READY with a short-lived link, or RENDERING (202) — ask again shortly. */
    receipt: (id: string): Promise<PaymentReceipt> =>
      client.request({ method: 'GET', path: `${payment(id)}/receipt` }, PaymentReceiptSchema),
  };
}
