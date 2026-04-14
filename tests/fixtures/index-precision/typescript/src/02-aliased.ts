import { add as plus, multiply as times } from "./math";

export function run(): number {
  return plus(1, 2) + times(3, 4);
}
