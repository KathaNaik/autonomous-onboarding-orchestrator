/** Test stub: next/font/google is compiled by Next; under Vitest return stable class names. */
const font = (name: string) => () => ({
  className: `font-${name}`,
  variable: `font-${name}-variable`,
  style: { fontFamily: name },
});
export const Public_Sans = font("public-sans");
export const JetBrains_Mono = font("jetbrains-mono");
