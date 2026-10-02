import type { Mode, Outcome } from './domain.js';
export interface ProviderPayment { id: string; amount_cents: number; currency: string; mode: Mode }
export interface PaymentProvider { execute(payment: ProviderPayment): Promise<Outcome> }
export class HttpPaymentProvider implements PaymentProvider {
 constructor(private baseUrl: string, private timeoutMs = 300) {
  const url = new URL(baseUrl);
  if (!['http:','https:'].includes(url.protocol) || timeoutMs < 1) throw new Error('Invalid provider configuration');
 }
 private async request(path: string, init?: RequestInit) {
  return fetch(new URL(path, this.baseUrl), { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
 }
 private async receipt(response: Response): Promise<Outcome> {
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('reference' in body) || typeof body.reference !== 'string' || !body.reference)
   return { status: 'unknown', error: 'Malformed provider response' };
  return { status: 'succeeded', reference: body.reference };
 }
 async execute(payment: ProviderPayment): Promise<Outcome> {
  try {
   // Reconcile first: the previous POST may have charged despite losing its response.
   const lookup = await this.request(`/charges/${payment.id}`);
   if (lookup.ok) return await this.receipt(lookup);
   if (lookup.status !== 404) return { status: 'unknown', error: `Provider lookup HTTP ${lookup.status}` };
   const response = await this.request('/charges', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': payment.id },
    body: JSON.stringify({ amountCents: payment.amount_cents, currency: payment.currency, mode: payment.mode })
   });
   if (response.ok) return await this.receipt(response);
   if (response.status === 422) return { status: 'declined', error: 'Provider declined payment' };
   return { status: 'unknown', error: `Provider charge HTTP ${response.status}` };
  } catch (error) {
   return { status: 'unknown', error: error instanceof Error ? error.message : 'Provider request failed' };
  }
 }
}
