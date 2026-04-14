import { add } from "./math";

export function outer(): number {
  return add(1, 2);
}

export function shadowed(): number {
  const add = (x: number) => x + 100;
  return add(5);
}
