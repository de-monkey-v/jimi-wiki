import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
    "scripts/server-only-shim.cjs",
    // Claude Code 작업 디렉터리(세션 worktree 등) — 앱 소스가 아님. lint 대상에서 제외.
    ".claude/**",
  ]),
]);

export default eslintConfig;
