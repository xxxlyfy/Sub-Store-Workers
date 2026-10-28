import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SUB_STORE_PATH, subStoreTransformPlugin } from '../vite.substore-transform.js';

const BACKEND_DIR = SUB_STORE_PATH;
const HAS_SUBSTORE_SOURCE = fs.existsSync(
    path.join(BACKEND_DIR, 'src/vendor/open-api.js'),
);

function normalizeId(filePath) {
    return filePath.replace(/\\/g, '/');
}

function transformSource(code, filePath, plugin = subStoreTransformPlugin()) {
    const context = {
        error(message) {
            throw new Error(message);
        },
    };
    const result = plugin.transform.call(context, code, normalizeId(filePath));
    return result?.code ?? code;
}

function transformBackendFile(relativePath, plugin = subStoreTransformPlugin()) {
    const filePath = path.join(BACKEND_DIR, relativePath);
    const code = fs.readFileSync(filePath, 'utf8');
    return transformSource(code, filePath, plugin);
}

const skipWithoutSource = HAS_SUBSTORE_SOURCE
    ? false
    : 'sub-store/backend 不存在；先运行 pnpm run fetch:substore';

test('open-api 当前上游的 isSurge/isNode 环境检测会被覆盖', { skip: skipWithoutSource }, () => {
    const code = transformBackendFile('src/vendor/open-api.js');

    assert.match(code, /const isSurge = true;/);
    assert.match(code, /const isNode = false;/);
    assert.doesNotMatch(code, /const isSurge = typeof \$httpClient/);
    assert.doesNotMatch(code, /eval\s*\(\s*`typeof\s+process/);
    assert.match(code, /__SUB_STORE_WORKERS_PATCH__REQUEST_CACHE_ISOLATION__/);
});

test('isSurge 判断式新增环境项后仍然能被覆盖（不绑定旧表达式）', { skip: skipWithoutSource }, () => {
    const filePath = path.join(BACKEND_DIR, 'src/vendor/open-api.js');
    const source = fs.readFileSync(filePath, 'utf8');
    const futureSource = source.replace(
        /const isSurge = [^;\n]*;/,
        "const isSurge = typeof $httpClient !== 'undefined' && !isLoon && !isEgern && !isLanceX;",
    );
    assert.notEqual(futureSource, source);

    const code = transformSource(futureSource, filePath);
    assert.match(code, /const isSurge = true;/);
});

test('isSurge 改成无法识别的多行声明时构建显式失败，而不是静默跳过', { skip: skipWithoutSource }, () => {
    const filePath = path.join(BACKEND_DIR, 'src/vendor/open-api.js');
    const source = fs.readFileSync(filePath, 'utf8');
    const unsupportedSource = source.replace(
        /const isSurge = [^;\n]*;/,
        "const isSurge =\n    typeof $httpClient !== 'undefined' &&\n    !isLoon;",
    );
    assert.notEqual(unsupportedSource, source);

    assert.throws(
        () => transformSource(unsupportedSource, filePath),
        /未找到 open-api\.js 的单行 isSurge 声明/,
    );
});

test('express 补丁绑定 requestId，并保留 next() 的 request 分发', { skip: skipWithoutSource }, () => {
    const code = transformBackendFile('src/vendor/express.js');

    assert.match(code, /__SUB_STORE_WORKERS_PATCH__REQUEST_DONE_DISPATCH__/);
    assert.match(code, /__SUB_STORE_WORKERS_PATCH__DISPATCH_EXPORT__/);
    assert.match(code, /function Response\(corsHeaders = \{\}, requestId\) \{/);
    assert.match(code, /Response\(cors\.headers, request\.__requestId\)/);
    assert.match(code, /dispatch\(request, i \+ 1\);/);
    assert.match(code, /__emitDone__\(requestId, response\);/);
    assert.match(code, /__emitDone__\(requestId, \{ response \}\);/);
    assert.match(code, /globalThis\.__substore_dispatch__ = dispatch;/);
    assert.doesNotMatch(code, /\$done\(/);
});

test('express 缺失时 buildEnd 仍然报错（保留必需目标检查）', { skip: skipWithoutSource }, () => {
    const plugin = subStoreTransformPlugin();
    const context = {
        error(message) {
            throw new Error(message);
        },
    };
    const openApiPath = path.join(BACKEND_DIR, 'src/vendor/open-api.js');
    plugin.transform.call(
        context,
        fs.readFileSync(openApiPath, 'utf8'),
        normalizeId(openApiPath),
    );

    assert.throws(
        () => plugin.buildEnd.call(context),
        /必需补丁目标未进入构建图：express\.js/,
    );
});

test('runtime/*.js 的裸 require 会被替换，Workers 中不会执行 Node 分支', { skip: skipWithoutSource }, () => {
    const runtimeDir = path.join(BACKEND_DIR, 'src/runtime');
    const runtimeFiles = fs
        .readdirSync(runtimeDir)
        .filter((name) => name.endsWith('.js'));

    for (const name of runtimeFiles) {
        const code = transformBackendFile(`src/runtime/${name}`);
        assert.doesNotMatch(
            code,
            /(?<!['"`])\brequire\s*\(\s*['"`]/,
            `${name} 仍包含裸 require`,
        );
    }

    const fsCode = transformBackendFile('src/runtime/fs.js');
    assert.match(fsCode, /globalThis\.__fs_shim__/);
});

test('Peggy 解析器预编译后保留文件内包装逻辑，且不导入 peggy', { skip: skipWithoutSource }, () => {
    const parserDir = 'src/core/proxy-utils/parsers/peggy';

    for (const name of ['loon.js', 'qx.js', 'surge.js']) {
        const code = transformBackendFile(`${parserDir}/${name}`);
        assert.doesNotMatch(code, /peggy\.generate/, `${name} 仍包含 peggy.generate`);
        assert.doesNotMatch(code, /from\s+['"]peggy['"]/, `${name} 仍导入 peggy`);
        assert.match(code, /export default function getParser\(\)/, `${name} 丢失 getParser`);
    }

    const qxCode = transformBackendFile(`${parserDir}/qx.js`);
    assert.match(qxCode, /function decodeQxAlpn\(raw\)/);
    assert.match(qxCode, /const generated = \(/);

    const trojanCode = transformBackendFile(`${parserDir}/trojan-uri.js`);
    assert.match(trojanCode, /function parseTrojan\(url\)/);
    assert.doesNotMatch(trojanCode, /peggy\.generate/);
});
