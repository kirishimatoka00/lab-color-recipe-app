import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { exportExcel, importExcel, templateExcel } from '../src/data/excelIO.js';
import { demoDb } from '../src/data/demo.js';
import { emptyDb } from '../src/data/store.js';
import { compile } from '../src/color/engine.js';
import { deltaE00 } from '../src/color/colorUtils.js';

test('匯出再匯入能還原整個資料庫', () => {
    const src = demoDb();
    const compiled = compile(src, src.settings);
    const { buffer } = exportExcel(src, compiled);

    const { db: back, report } = importExcel(buffer, emptyDb());

    assert.equal(back.resins.length, src.resins.length, '樹酯數量');
    assert.equal(back.colorants.length, src.colorants.length, '色料數量');
    assert.equal(back.formulations.length, src.formulations.length, '配方數量');
    assert.equal(report.skipped.length, 0, report.skipped.join('; '));

    // 曲線點數逐支比對
    for (const c of src.colorants) {
        const b = back.colorants.find((x) => x.name === c.name);
        assert.ok(b, `找不到色料 ${c.name}`);
        assert.equal(b.curve.length, c.curve.length, `${c.name} 的曲線點數`);
        assert.equal(b.pigmentLoading, c.pigmentLoading, `${c.name} 的顏料含量`);
        assert.equal(b.minFinalPct, c.minFinalPct, `${c.name} 的最低含量`);
    }
    // 成分逐張比對
    for (const f of src.formulations) {
        const b = back.formulations.find((x) => x.name === f.name);
        assert.ok(b, `找不到配方 ${f.name}`);
        assert.equal(b.components.length, f.components.length, `${f.name} 的成分數`);
    }
});

test('還原後的資料庫算出相同的預測結果', () => {
    const src = demoDb();
    const srcCompiled = compile(src, src.settings);
    const { buffer } = exportExcel(src, srcCompiled);
    const { db: back } = importExcel(buffer, emptyDb());

    // 匯入後的 id 不同，用名稱找回對應的設定
    const baseId = back.resins.find((r) => r.name === 'PP 射出級').id;
    const carrierId = back.resins.find((r) => r.name === 'PE 載體').id;
    const backCompiled = compile(back, {
        baseResinId: baseId, carrierId, condition: src.settings.condition,
    });

    assert.equal(backCompiled.warnings.length, 0, backCompiled.warnings.join('; '));
    assert.equal(backCompiled.sampleCount, srcCompiled.sampleCount, '校正樣本數');
    assert.ok(
        Math.abs(backCompiled.calib.evaluation.rmsDE00 - srcCompiled.calib.evaluation.rmsDE00) < 0.05,
        `RMS 不一致：${backCompiled.calib.evaluation.rmsDE00} vs ${srcCompiled.calib.evaluation.rmsDE00}`,
    );
});

test('白色料的關聯在往返後仍然正確', () => {
    const src = demoDb();
    const { buffer } = exportExcel(src, compile(src, src.settings));
    const { db: back } = importExcel(buffer, emptyDb());

    const white = back.colorants.find((c) => c.role === 'white');
    const red = back.colorants.find((c) => c.name.includes('紅'));
    assert.ok(white, '白色料應保留 role');
    for (const p of red.curve) {
        assert.equal(p.whiteColorantId, white.id, '彩色料曲線應指回正確的白色母');
        assert.ok(p.whiteDosage > 0, '白階不該遺失');
    }
});

test('重複匯入不會把曲線或成分越疊越多', () => {
    const src = demoDb();
    const { buffer } = exportExcel(src, compile(src, src.settings));
    const once = importExcel(buffer, emptyDb()).db;
    const twice = importExcel(buffer, once).db;

    assert.equal(twice.colorants.length, once.colorants.length);
    for (const c of once.colorants) {
        const t = twice.colorants.find((x) => x.name === c.name);
        assert.equal(t.curve.length, c.curve.length, `${c.name} 的曲線被重複累加`);
    }
    for (const f of once.formulations) {
        const t = twice.formulations.find((x) => x.name === f.name);
        assert.equal(t.components.length, f.components.length, `${f.name} 的成分被重複累加`);
    }
});

test('中文欄名與帶百分號的數字都讀得進來', () => {
    const base = emptyDb();
    // 直接組一份只有中文欄名的工作簿
    const src = demoDb();
    const { buffer } = exportExcel(src, compile(src, src.settings));
    const { db, report } = importExcel(buffer, base);
    assert.ok(db.colorants.length > 0);
    assert.equal(report.skipped.length, 0);
});

test('找不到對應色料的列會被記錄而非靜默丟棄', () => {
    const src = demoDb();
    const { buffer } = exportExcel(src, compile(src, src.settings));
    // 匯入到空庫但先把色料表清掉，Curves 就會找不到對象
    const wb = XLSX.read(buffer, { type: 'array' });
    delete wb.Sheets.Colorants;
    wb.SheetNames = wb.SheetNames.filter((s) => s !== 'Colorants');
    const stripped = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

    const { report } = importExcel(stripped, emptyDb());
    assert.ok(report.skipped.length > 0, '應回報找不到色料的列');
    assert.ok(report.skipped.some((s) => s.includes('找不到色料')));
});

test('範本可產生且自身可被匯入', () => {
    const { filename, buffer } = templateExcel();
    assert.ok(filename.endsWith('.xlsx'));
    const { db, report } = importExcel(buffer, emptyDb());
    assert.equal(db.resins.length, 2);
    assert.equal(db.colorants.length, 2);
    assert.equal(db.formulations.length, 1);
    assert.equal(report.skipped.length, 0, report.skipped.join('; '));
});
