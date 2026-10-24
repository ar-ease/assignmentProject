export function formatPaise(paise: number): string {
  return `₹${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}
