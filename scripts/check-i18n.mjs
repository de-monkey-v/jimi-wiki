// 4개 로케일 메시지 파일의 키 정합성 검사.
// ko(기준)에 있는 모든 leaf 키가 en/ja/zh에도 있어야 하고, 반대로 잉여 키도 리포트한다.
// CI에서 `pnpm check:i18n` 로 실행 — 누락 키가 있으면 exit 1.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["ko", "en", "ja", "zh"];
const BASE = "ko";

function load(loc) {
  return JSON.parse(readFileSync(join(root, "messages", `${loc}.json`), "utf8"));
}

// 중첩 객체를 "a.b.c" leaf 경로 집합으로 평탄화
function leafPaths(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) leafPaths(v, path, out);
    else out.add(path);
  }
  return out;
}

const data = Object.fromEntries(LOCALES.map((l) => [l, load(l)]));
const base = leafPaths(data[BASE]);

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if ([".ts", ".tsx"].includes(extname(entry.name))) out.push(path);
  }
  return out;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current) || ts.isAsExpression(current))
  ) current = current.expression;
  return current;
}

function literalNamespace(node) {
  const expr = unwrapExpression(node);
  if (!expr || !ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) return null;
  if (expr.expression.text !== "getTranslations" && expr.expression.text !== "useTranslations") return null;
  const arg = expr.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

function promiseAllItems(node) {
  const expr = unwrapExpression(node);
  if (!expr || !ts.isCallExpression(expr) || expr.arguments.length !== 1) return null;
  if (!ts.isPropertyAccessExpression(expr.expression) || expr.expression.name.text !== "all") return null;
  const owner = expr.expression.expression;
  if (!ts.isIdentifier(owner) || owner.text !== "Promise") return null;
  const arg = expr.arguments[0];
  return ts.isArrayLiteralExpression(arg) ? arg.elements : null;
}

// 로케일간 키 동일성만으로는 "모든 언어에 같은 키가 빠진" 오류를 찾지 못한다.
// TypeScript AST로 getTranslations/useTranslations binding과 문자열 literal t("key") 호출을 연결해
// 소스가 실제 사용하는 namespace/key도 모든 locale에 있는지 검사한다.
function collectUsedMessagePaths() {
  const used = new Map();
  const record = (path, file, node) => {
    if (!used.has(path)) used.set(path, `${file}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
  };

  const visit = (node, env, file) => {
    if (ts.isFunctionLike(node)) {
      const local = new Map(env);
      if (node.body) visit(node.body, local, file);
      return;
    }
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const local = new Map(env);
      node.forEachChild((child) => visit(child, local, file));
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visit(node.initializer, env, file);
      if (ts.isIdentifier(node.name)) {
        const namespace = literalNamespace(node.initializer);
        if (namespace) {
          env.set(node.name.text, namespace);
          record(namespace, file, node);
        }
      } else if (ts.isArrayBindingPattern(node.name)) {
        const items = promiseAllItems(node.initializer);
        if (items) {
          node.name.elements.forEach((binding, index) => {
            if (!ts.isBindingElement(binding) || !ts.isIdentifier(binding.name)) return;
            const namespace = literalNamespace(items[index]);
            if (namespace) {
              env.set(binding.name.text, namespace);
              record(namespace, file, binding);
            }
          });
        }
      }
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const namespace = env.get(node.expression.text);
      const key = node.arguments[0];
      if (namespace && key && ts.isStringLiteralLike(key)) record(`${namespace}.${key.text}`, file, node);
    }
    node.forEachChild((child) => visit(child, env, file));
  };

  for (const file of sourceFiles(join(root, "src"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
      extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    visit(source, new Map(), file);
  }
  return used;
}

let failed = false;
for (const loc of LOCALES) {
  if (loc === BASE) continue;
  const keys = leafPaths(data[loc]);
  const missing = [...base].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !base.has(k));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`\n[${loc}] ${missing.length} missing, ${extra.length} extra vs ${BASE}`);
    if (missing.length) console.error("  missing:", missing.slice(0, 40).join(", ") + (missing.length > 40 ? " …" : ""));
    if (extra.length) console.error("  extra:  ", extra.slice(0, 40).join(", ") + (extra.length > 40 ? " …" : ""));
  }
}

for (const [path, location] of collectUsedMessagePaths()) {
  for (const loc of LOCALES) {
    const keys = leafPaths(data[loc]);
    const existsAsNamespace = [...keys].some((key) => key === path || key.startsWith(`${path}.`));
    if (!existsAsNamespace) {
      failed = true;
      console.error(`\n[${loc}] used message path missing: ${path} (${location})`);
    }
  }
}

if (failed) {
  console.error("\ni18n key check FAILED — 로케일 간 키가 일치하지 않습니다.");
  process.exit(1);
}
console.log(`i18n key check OK — ${base.size} keys × ${LOCALES.length} locales 정합.`);
