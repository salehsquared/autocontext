import { add } from "./math";

export function run(): number {
  const a = add(1, 2);
  const b = add(3, 4);
  const c = add(5, 6);
  return a + b + c;
}
