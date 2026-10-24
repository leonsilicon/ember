// GLSL sources, imported as strings (see turbopack.rules in next.config.ts).
declare module '*.vert' {
  const source: string;
  export default source;
}

declare module '*.frag' {
  const source: string;
  export default source;
}
