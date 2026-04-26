/**
 * Re-export of `./z-index.ts` under the alternate camelCase name `zIndex`.
 * The canonical file is `z-index.ts` to avoid import churn across the
 * existing codebase (per `06-integration-plan-mobile.md §2.4`). This file
 * lets new code import from `@/lib/zIndex` without breaking older imports
 * from `@/lib/z-index`.
 */
export { Z, type ZLayer } from "./z-index";
