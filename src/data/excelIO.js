/**
 * Excel 匯出入
 *
 * 五個工作表，匯出後可以直接再匯入（round-trip）。
 * 欄名同時接受中英文，因為現場的既有表單大多是中文。
 *
 *   Resins       樹酯
 *   Colorants    色料主檔
 *   Curves       濃度曲線（每列一個資料點）
 *   Formulations 配方主檔
 *   Components   配方成分（每列一個成分）
 *
 * 工作表之間用「名稱」而不是內部 id 串接，使用者才改得動。
 * 匯入時以名稱比對既有資料：對得上就更新，對不上就新增。
 */

import * as XLSX from '@e965/xlsx';
import {
    makeResin, makeColorant, makeCurvePoint, makeFormulation,
    COLORANT_TYPE, COLORANT_ROLE, RECIPE_MODE, effectiveConcentrations,
} from './schema.js';

/** 欄名對照：接受的別名 → 標準鍵 */
const ALIASES = {
    name: ['name', '名稱', '品名'],
    grade: ['grade', '牌號'],
    usage: ['usage', '用途'],
    mfi: ['mfi', 'MFI'],
    blankL: ['blankL', '本色L', 'L'],
    blankA: ['blankA', '本色a', 'a'],
    blankB: ['blankB', '本色b', 'b'],
    note: ['note', '備註'],

    code: ['code', '編號'],
    type: ['type', '型態'],
    role: ['role', '角色'],
    pigmentLoading: ['pigmentLoading', '顏料含量', '含量'],
    carrier: ['carrier', '載體', '載體樹酯'],
    minFinalPct: ['minFinalPct', '最低含量'],
    maxFinalPct: ['maxFinalPct', '最高含量'],
    supplier: ['supplier', '供應商'],

    colorant: ['colorant', '色料'],
    dosage: ['dosage', '添加量', '色母添加'],
    whiteColorant: ['whiteColorant', '白色料', '白色母'],
    whiteDosage: ['whiteDosage', '白添加量', '白添加'],
    condition: ['condition', '量測條件', '條件'],

    date: ['date', '日期'],
    mode: ['mode', '配方形式'],
    baseResin: ['baseResin', '基礎樹酯'],
    letdown: ['letdown', 'letdown%', '母粒添加量'],
    status: ['status', '狀態'],
    measuredL: ['measuredL', '實測L'],
    measuredA: ['measuredA', '實測a'],
    measuredB: ['measuredB', '實測b'],

    formulation: ['formulation', '配方'],
    value: ['value', '用量'],
};

/** 從一列資料裡找出某個欄位，容忍別名與大小寫 */
function pick(row, key) {
    for (const alias of ALIASES[key] || [key]) {
        if (row[alias] !== undefined && row[alias] !== '') return row[alias];
    }
    const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [String(k).toLowerCase().trim(), v]));
    for (const alias of ALIASES[key] || [key]) {
        const v = lower[alias.toLowerCase()];
        if (v !== undefined && v !== '') return v;
    }
    return undefined;
}

const num = (v, d = null) => {
    if (v === undefined || v === null || v === '') return d;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[%,\s]/g, ''));
    return Number.isNaN(n) ? d : n;
};
const str = (v, d = '') => (v === undefined || v === null ? d : String(v).trim());

/* ------------------------------------------------------------------ *
 * 匯出
 * ------------------------------------------------------------------ */

export function exportExcel(db, compiled = null) {
    const resinName = (id) => db.resins.find((r) => r.id === id)?.name || '';
    const colorantName = (id) => db.colorants.find((c) => c.id === id)?.name || '';

    const resins = db.resins.map((r) => ({
        名稱: r.name, 牌號: r.grade, 用途: r.usage, MFI: r.mfi ?? '',
        本色L: r.blankLab?.l ?? '', 本色a: r.blankLab?.a ?? '', 本色b: r.blankLab?.b ?? '',
        備註: r.note,
    }));

    const colorants = db.colorants.map((c) => ({
        名稱: c.name, 編號: c.code, 型態: c.type, 角色: c.role,
        顏料含量: c.pigmentLoading, 載體: resinName(c.carrierId),
        最低含量: c.minFinalPct, 最高含量: c.maxFinalPct ?? '',
        供應商: c.supplier, 備註: c.note,
        擬合形式: compiled?.models?.[c.id]?.form ?? '',
        擬合R2: compiled?.models?.[c.id]?.r2 ? Math.min(...compiled.models[c.id].r2).toFixed(4) : '',
    }));

    const curves = [];
    for (const c of db.colorants) {
        for (const p of c.curve) {
            curves.push({
                色料: c.name, 添加量: p.dosage,
                白色母: colorantName(p.whiteColorantId), 白添加量: p.whiteDosage,
                L: p.lab.l, a: p.lab.a, b: p.lab.b,
                量測條件: p.condition, 備註: p.note,
            });
        }
    }

    const formulations = db.formulations.map((f) => {
        const row = {
            名稱: f.name, 日期: f.date, 配方形式: f.mode,
            基礎樹酯: resinName(f.baseResinId), 載體: resinName(f.carrierId),
            letdown: f.letdown, 狀態: f.status, 量測條件: f.condition,
            實測L: f.measuredLab?.l ?? '', 實測a: f.measuredLab?.a ?? '', 實測b: f.measuredLab?.b ?? '',
            備註: f.note,
        };
        // 預測結果只是參考，匯入時會忽略
        if (compiled) {
            try {
                const eff = effectiveConcentrations(f, compiled.colorantsById);
                row['顏料總量'] = eff.reduce((s, x) => s + x.c, 0).toFixed(4);
            } catch { /* 資料不完整時略過 */ }
        }
        return row;
    });

    const components = [];
    for (const f of db.formulations) {
        const eff = compiled ? effectiveConcentrations(f, compiled.colorantsById) : null;
        f.components.forEach((comp, i) => {
            components.push({
                配方: f.name, 色料: colorantName(comp.colorantId), 用量: comp.value,
                有效濃度: eff ? Number(eff[i].c.toFixed(5)) : '',
            });
        });
    }

    // 設定也要進去，不然匯出的檔案少了「這批資料是在什麼條件下成立的」
    const settings = [
        { 項目: 'baseResin', 值: resinName(db.settings?.baseResinId), 說明: '基礎樹酯（以名稱對應）' },
        { 項目: 'carrier', 值: resinName(db.settings?.carrierId), 說明: '母粒載體（以名稱對應）' },
        { 項目: 'condition', 值: db.settings?.condition ?? '', 說明: '量測條件；只有相同條件的配方會一起校正' },
        { 項目: 'maxTotalC', 值: db.settings?.maxTotalC ?? '', 說明: '顏料總量上限 wt%，空白為不限' },
        { 項目: 'deltaEThreshold', 值: db.settings?.deltaEThreshold ?? 1, 說明: 'ΔE00 合格門檻，只影響顯示顏色' },
        { 項目: 'schemaVersion', 值: db.version ?? 1, 說明: '資料結構版本，請勿修改' },
    ];

    const wb = XLSX.utils.book_new();
    const add = (rows, sheet) =>
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet);
    add(settings, 'Settings');
    add(resins, 'Resins');
    add(colorants, 'Colorants');
    add(curves, 'Curves');
    add(formulations, 'Formulations');
    add(components, 'Components');

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    return {
        filename: `recipe_data_${stamp}.xlsx`,
        buffer: XLSX.write(wb, { bookType: 'xlsx', type: 'array' }),
    };
}

/* ------------------------------------------------------------------ *
 * 匯入
 * ------------------------------------------------------------------ */

/**
 * 以名稱比對合併到現有資料庫：同名更新，新名新增。
 * @returns {{db, report:{added:object, updated:object, skipped:string[]}}}
 */
export function importExcel(arrayBuffer, db) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const sheet = (name) => {
        const key = wb.SheetNames.find((s) => s.toLowerCase() === name.toLowerCase());
        return key ? XLSX.utils.sheet_to_json(wb.Sheets[key], { defval: '' }) : [];
    };

    const report = { added: {}, updated: {}, skipped: [] };
    const bump = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };

    const resins = [...db.resins];
    const colorants = [...db.colorants];
    const formulations = [...db.formulations];

    const findResin = (name) => resins.find((r) => r.name === str(name));
    const findColorant = (name) => colorants.find((c) => c.name === str(name));

    // --- Resins ---
    for (const row of sheet('Resins')) {
        const name = str(pick(row, 'name'));
        if (!name) continue;
        const l = num(pick(row, 'blankL')), a = num(pick(row, 'blankA')), b = num(pick(row, 'blankB'));
        const patch = {
            name, grade: str(pick(row, 'grade')), usage: str(pick(row, 'usage'), 'both'),
            mfi: num(pick(row, 'mfi')), note: str(pick(row, 'note')),
            blankLab: l != null && a != null && b != null ? { l, a, b } : null,
        };
        const existing = findResin(name);
        if (existing) { Object.assign(existing, patch); bump(report.updated, '樹酯'); }
        else { resins.push(makeResin(patch)); bump(report.added, '樹酯'); }
    }

    // --- Colorants ---
    for (const row of sheet('Colorants')) {
        const name = str(pick(row, 'name'));
        if (!name) continue;
        const carrier = findResin(pick(row, 'carrier'));
        const rawType = str(pick(row, 'type')).toUpperCase();
        const rawRole = str(pick(row, 'role')).toLowerCase();
        const patch = {
            name, code: str(pick(row, 'code')),
            type: rawType.includes('RAW') || rawType.includes('色粉') ? COLORANT_TYPE.RAW : COLORANT_TYPE.SPD,
            role: rawRole.includes('white') || rawRole.includes('白') ? COLORANT_ROLE.WHITE : COLORANT_ROLE.CHROMATIC,
            pigmentLoading: num(pick(row, 'pigmentLoading'), 20),
            carrierId: carrier?.id ?? null,
            minFinalPct: num(pick(row, 'minFinalPct'), 0),
            maxFinalPct: num(pick(row, 'maxFinalPct')),
            supplier: str(pick(row, 'supplier')), note: str(pick(row, 'note')),
        };
        const existing = findColorant(name);
        if (existing) { Object.assign(existing, patch); bump(report.updated, '色料'); }
        else { colorants.push(makeColorant(patch)); bump(report.added, '色料'); }
    }

    // --- Curves：整支色料的曲線以匯入內容取代，避免重複累加 ---
    const curveRows = sheet('Curves');
    if (curveRows.length) {
        const touched = new Set();
        for (const row of curveRows) {
            const col = findColorant(pick(row, 'colorant'));
            if (!col) { report.skipped.push(`曲線：找不到色料「${str(pick(row, 'colorant'))}」`); continue; }
            if (!touched.has(col.id)) { col.curve = []; touched.add(col.id); }
            const l = num(pick(row, 'blankL')), a = num(pick(row, 'blankA')), b = num(pick(row, 'blankB'));
            if (l == null || a == null || b == null) {
                report.skipped.push(`曲線：「${col.name}」有一列缺少 Lab`); continue;
            }
            const white = findColorant(pick(row, 'whiteColorant'));
            col.curve.push(makeCurvePoint({
                dosage: num(pick(row, 'dosage'), 0),
                whiteColorantId: white?.id ?? null,
                whiteDosage: num(pick(row, 'whiteDosage'), 0),
                lab: { l, a, b },
                condition: str(pick(row, 'condition')),
                note: str(pick(row, 'note')),
            }));
            bump(report.added, '曲線點');
        }
        for (const id of touched) {
            const c = colorants.find((x) => x.id === id);
            c.curve.sort((p, q) => p.dosage - q.dosage);
        }
    }

    // --- Formulations ---
    for (const row of sheet('Formulations')) {
        const name = str(pick(row, 'name'));
        if (!name) continue;
        const l = num(pick(row, 'measuredL')), a = num(pick(row, 'measuredA')), b = num(pick(row, 'measuredB'));
        const rawMode = str(pick(row, 'mode')).toLowerCase();
        const patch = {
            name, date: str(pick(row, 'date'), new Date().toISOString().slice(0, 10)),
            mode: rawMode.includes('master') || rawMode.includes('母粒') ? RECIPE_MODE.MASTERBATCH : RECIPE_MODE.DIRECT,
            baseResinId: findResin(pick(row, 'baseResin'))?.id ?? null,
            carrierId: findResin(pick(row, 'carrier'))?.id ?? null,
            letdown: num(pick(row, 'letdown'), 100),
            status: str(pick(row, 'status'), '試打'),
            condition: str(pick(row, 'condition')),
            note: str(pick(row, 'note')),
            measuredLab: l != null && a != null && b != null ? { l, a, b } : null,
        };
        const existing = formulations.find((f) => f.name === name);
        if (existing) { Object.assign(existing, patch, { components: existing.components }); bump(report.updated, '配方'); }
        else { formulations.push(makeFormulation({ ...patch, components: [] })); bump(report.added, '配方'); }
    }

    // --- Components：同樣整張配方取代 ---
    const compRows = sheet('Components');
    if (compRows.length) {
        const touched = new Set();
        for (const row of compRows) {
            const fName = str(pick(row, 'formulation'));
            const f = formulations.find((x) => x.name === fName);
            if (!f) { report.skipped.push(`成分：找不到配方「${fName}」`); continue; }
            const col = findColorant(pick(row, 'colorant'));
            if (!col) { report.skipped.push(`成分：找不到色料「${str(pick(row, 'colorant'))}」`); continue; }
            if (!touched.has(f.id)) { f.components = []; touched.add(f.id); }
            f.components.push({ colorantId: col.id, value: num(pick(row, 'value'), 0) });
            bump(report.added, '成分');
        }
    }

    // --- Settings：最後讀，因為要用名稱對應到上面剛建好的樹酯 ---
    let settings = { ...db.settings };
    const settingRows = sheet('Settings');
    if (settingRows.length) {
        const kv = {};
        for (const row of settingRows) {
            const k = str(row['項目'] ?? row.key ?? row.Key ?? row.item);
            if (k) kv[k] = row['值'] ?? row.value ?? row.Value ?? '';
        }
        const byName = (n) => resins.find((r) => r.name === str(n))?.id ?? null;
        if ('baseResin' in kv) settings.baseResinId = byName(kv.baseResin);
        if ('carrier' in kv) settings.carrierId = byName(kv.carrier);
        if ('condition' in kv) settings.condition = str(kv.condition);
        if ('maxTotalC' in kv) settings.maxTotalC = num(kv.maxTotalC);
        if ('deltaEThreshold' in kv) settings.deltaEThreshold = num(kv.deltaEThreshold, 1);
        bump(report.updated, '設定');
    }

    return { db: { ...db, resins, colorants, formulations, settings }, report };
}

/** 空白範本，給還沒有資料的人照著填 */
export function templateExcel() {
    const wb = XLSX.utils.book_new();
    const add = (rows, sheet) =>
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet);

    add([
        { 項目: 'baseResin', 值: 'PP 射出級', 說明: '基礎樹酯（以名稱對應）' },
        { 項目: 'carrier', 值: 'PE 載體', 說明: '母粒載體（以名稱對應）' },
        { 項目: 'condition', 值: '2mm 射出板 / SCI', 說明: '量測條件；只有相同條件的配方會一起校正' },
        { 項目: 'maxTotalC', 值: '', 說明: '顏料總量上限 wt%，空白為不限' },
        { 項目: 'deltaEThreshold', 值: 1, 說明: 'ΔE00 合格門檻' },
    ], 'Settings');
    add([{ 名稱: 'PP 射出級', 牌號: 'H1500', 用途: 'base', MFI: 12, 本色L: 92.4, 本色a: -0.7, 本色b: 2.6, 備註: '' },
         { 名稱: 'PE 載體', 牌號: 'LDPE', 用途: 'carrier', MFI: '', 本色L: '', 本色a: '', 本色b: '', 備註: '' }], 'Resins');
    add([{ 名稱: '白 SPD', 編號: 'W-50', 型態: 'SPD', 角色: 'white', 顏料含量: 50, 載體: 'PE 載體', 最低含量: 0.1, 最高含量: '', 供應商: '', 備註: '' },
         { 名稱: '紅 SPD', 編號: 'R-25', 型態: 'SPD', 角色: 'chromatic', 顏料含量: 25, 載體: 'PE 載體', 最低含量: 0.02, 最高含量: '', 供應商: '', 備註: '' }], 'Colorants');
    add([{ 色料: '紅 SPD', 添加量: 1, 白色母: '白 SPD', 白添加量: 4, L: 70, a: 35, b: 12, 量測條件: '2mm 射出板 / SCI', 備註: '' }], 'Curves');
    add([{ 名稱: '範例配方', 日期: '2026-01-01', 配方形式: 'direct', 基礎樹酯: 'PP 射出級', 載體: 'PE 載體', letdown: 100, 狀態: '試打', 量測條件: '2mm 射出板 / SCI', 實測L: 70, 實測a: 35, 實測b: 12, 備註: '' }], 'Formulations');
    add([{ 配方: '範例配方', 色料: '紅 SPD', 用量: 1 }], 'Components');

    return {
        filename: 'recipe_template.xlsx',
        buffer: XLSX.write(wb, { bookType: 'xlsx', type: 'array' }),
    };
}

export default { exportExcel, importExcel, templateExcel };
