/** Test stub: next/font/google is compiled by Next; under Vitest return stable class names. */
const font = (name: string) => () => ({
  className: `font-${name}`,
  variable: `font-${name}-variable`,
  style: { fontFamily: name },
});
export const Geist = font("geist");
export const Geist_Mono = font("geist-mono");
