function _clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

export function add(a: number, b: number): number {
  return _clamp(a + b);
}

export function multiply(a: number, b: number): number {
  return a * b;
}
