import { add } from "./math";

export function run(): string {
  const label = "add and multiply";
  return `${label}: ${add(1, 2)}`;
}
