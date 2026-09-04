/**
 * Minimal class-name joiner.
 *
 * Kept dependency-free on purpose: `clsx` + `tailwind-merge` would be two
 * packages to solve a problem (conflicting Tailwind classes) this codebase
 * avoids by not passing conflicting classes. Bklit chart components import
 * `cn` from here; they only need it to concatenate, not to de-dupe.
 */
export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (value: ClassValue): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else {
      out.push(String(value));
    }
  };
  inputs.forEach(walk);
  return out.join(" ");
}
