import { runCompute } from "../commands/compute";

export function handle(a: number, b: number): number {
  return runCompute(a, b);
}
