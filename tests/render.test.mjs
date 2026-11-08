/**
 * 元件冒煙測試。
 * 用 esbuild 轉譯 JSX，再以 react-dom/server 渲染成字串。
 * 抓的是「元件會不會直接炸掉」這類錯誤：缺少的 import、undefined 解構、
 * 壞掉的 props 傳遞。這些在純函式測試裡看不到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENTRY = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import RecipeView from '../src/views/RecipeView.jsx';
import LibraryView from '../src/views/LibraryView.jsx';
import HistoryView from '../src/views/HistoryView.jsx';
import { compile } from '../src/color/engine.js';
import { demoDb } from '../src/data/demo.js';
import { emptyDb } from '../src/data/store.js';

export function renderAll(db) {
  const compiled = compile(db, db.settings);
  const out = {};
  out.recipe  = renderToString(React.createElement(RecipeView,
      { db, compiled, settings: db.settings, onSettings: () => {} }));
  out.library = renderToString(React.createElement(LibraryView,
      { db, compiled, onChange: () => {} }));
  out.history = renderToString(React.createElement(HistoryView,
      { db, compiled, settings: db.settings, onChange: () => {} }));
  out.warnings = compiled.warnings;
  out.modelCount = Object.keys(compiled.models).length;
  out.sampleCount = compiled.sampleCount;
  out.rms = compiled.calib.evaluation.rmsDE00;
  out.strengths = compiled.calib.strengths;
  return out;
}
export { demoDb, emptyDb };
`;

let mod;

test('建置測試套件', async () => {
    // 必須放在專案目錄內，否則 node 解析不到 node_modules 裡的 react
    const entry = join(process.cwd(), 'tests', '.entry.jsx');
    writeFileSync(entry, ENTRY);
    const outfile = join(process.cwd(), 'tests', '.bundle.mjs');
    await build({
        entryPoints: [entry], outfile, bundle: true, format: 'esm',
        platform: 'node', jsx: 'automatic', logLevel: 'silent',
        external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
        loader: { '.css': 'empty' },
    });
    mod = await import(`file://${outfile}`);
    assert.ok(mod.renderAll);
});

test('空資料庫不會崩潰', () => {
    const out = mod.renderAll(mod.emptyDb());
    assert.ok(out.recipe.includes('色料資料庫') || out.recipe.length > 100);
    assert.ok(out.library.length > 100);
    assert.ok(out.history.length > 100);
});

test('範例資料可完整建模並渲染', () => {
    const db = mod.demoDb();
    const out = mod.renderAll(db);

    assert.equal(out.modelCount, 5, '白 + 四支彩色料');
    assert.equal(out.warnings.length, 0, out.warnings.join('; '));
    assert.equal(out.sampleCount, 6, '六張歷史配方都該進校正集');

    for (const key of ['recipe', 'library', 'history']) {
        assert.ok(out[key].length > 500, `${key} 渲染結果過短`);
        assert.ok(!out[key].includes('NaN'), `${key} 含 NaN`);
        assert.ok(!out[key].includes('undefined'), `${key} 含 undefined`);
    }
});

test('範例資料的校正能壓低誤差並抓到刻意加入的色力偏差', () => {
    const out = mod.renderAll(mod.demoDb());
    // demo.js 對紅設 0.88、黃設 1.14
    assert.ok(Math.abs(out.strengths.col_red - 0.88) < 0.08, `red=${out.strengths.col_red}`);
    assert.ok(Math.abs(out.strengths.col_yellow - 1.14) < 0.08, `yellow=${out.strengths.col_yellow}`);
    assert.ok(out.rms < 1.0, `校正後 RMS ΔE00=${out.rms} 應小於 1`);
});
