import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

function listJavaScriptFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listJavaScriptFiles(fullPath));
        } else if (entry.name.endsWith('.js')) {
            files.push(fullPath);
        }
    }
    return files;
}

function findWorkerOutputDir() {
    const candidates = [];
    if (!fs.existsSync(DIST_DIR)) return null;

    const stack = [DIST_DIR];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.name === 'wrangler.json') {
                const config = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                if (config.main === 'index.js') {
                    candidates.push(path.dirname(fullPath));
                }
            }
        }
    }

    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) return null;
    throw new Error(`发现多个 Workers 构建产物，无法确定要验证的目标：${candidates.join(', ')}`);
}

const workerDir = findWorkerOutputDir();
assert.ok(
    workerDir,
    '未找到 Workers 构建产物（dist/**/wrangler.json 且 main=index.js）；请先运行 pnpm run build:workers',
);

const entryPath = path.join(workerDir, 'index.js');
assert.ok(fs.existsSync(entryPath), `缺少 Workers 入口：${entryPath}`);

const config = JSON.parse(fs.readFileSync(path.join(workerDir, 'wrangler.json'), 'utf8'));
assert.equal(config.main, 'index.js');
assert.ok(
    config.durable_objects?.bindings?.some((binding) => binding.name === 'INDEX_DO'),
    '构建产物缺少 INDEX_DO Durable Object 绑定',
);
assert.ok(
    config.durable_objects?.bindings?.some((binding) => binding.name === 'USER_DO'),
    '构建产物缺少 USER_DO Durable Object 绑定',
);

const entryCode = fs.readFileSync(entryPath, 'utf8');
assert.match(entryCode, /export\s*\{[\s\S]*as default[\s\S]*\}/);
assert.match(entryCode, /as IndexDO/);
assert.match(entryCode, /as UserDO/);

const bundle = listJavaScriptFiles(workerDir)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

const requiredPatterns = [
    [/const\s+isSurge[\w$]*\s*=\s*true\b/, 'isSurge 未被固定为 true'],
    [/const\s+isNode[\w$]*\s*=\s*false\b/, 'isNode 未被固定为 false'],
    [/__substore_dispatch__/, 'express dispatch 未导出到 globalThis'],
    [/__emitDone__/, 'express 响应未绑定 requestId'],
    [/__substore_get_active_context__/, '请求级上下文桥接缺失'],
    [/__substore_workers_createDynamicFunction__/, 'QuickJS 脚本引擎桥接缺失'],
];
for (const [pattern, message] of requiredPatterns) {
    assert.match(bundle, pattern, message);
}

const forbiddenPatterns = [
    [/peggy\.generate/, '产物中仍包含 peggy.generate（Workers 不支持运行时编译）'],
    [/require\s*\(\s*['"`]fs['"`]\s*\)/, '产物中仍包含 require("fs")'],
    [/require\s*\(\s*['"`]express['"`]\s*\)/, '产物中仍包含 require("express")'],
    [/require\s*\(\s*['"`]undici['"`]\s*\)/, '产物中仍包含 require("undici")'],
];
for (const [pattern, message] of forbiddenPatterns) {
    assert.doesNotMatch(bundle, pattern, message);
}

console.log(`[verify-workers-build] OK -> ${path.relative(ROOT_DIR, workerDir)}`);
