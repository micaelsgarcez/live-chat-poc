/**
 * `vitest.config.ts` is a frozen contract and cannot register a setup file, so
 * the slice's tests apply the D1 schema themselves by importing the migration
 * through Vite's `?raw` loader. Declaring it here keeps the migrations the one
 * source of truth instead of duplicating DDL into a test fixture.
 */
declare module "*.sql?raw" {
  const source: string;
  export default source;
}
