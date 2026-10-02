import { createHash } from 'node:crypto';
export type Mode = 'success' | 'temporary' | 'declined' | 'timeout' | 'unavailable';
export interface PaymentInput { amountCents: number; currency: 'USD' | 'BRL' | 'EUR'; mode?: Mode }
export class DomainError extends Error {
 constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export function fingerprint(input: PaymentInput) {
 return createHash('sha256').update(JSON.stringify({ amountCents: input.amountCents, currency: input.currency, mode: input.mode ?? 'success' })).digest('hex');
}
export function retryDelay(attempt: number, random = Math.random) {
 return Math.min(30000, 250 * 2 ** (attempt - 1)) + Math.floor(random() * 100);
}
export type Outcome = { status: 'succeeded'; reference: string } | { status: 'declined' | 'unknown'; error: string };
