import crypto from 'crypto';

export function generateOrderId(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}
