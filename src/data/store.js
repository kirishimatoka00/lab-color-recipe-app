/**
 * 資料儲存：localStorage + JSON 全備份。
 * 沿用 lab-color-app 的作法，純前端、無後端。
 */

import { makeResin, makeColorant, makeFormulation } from './schema.js';

const KEY = 'recipe_db_v1';
export const SCHEMA_VERSION = 1;

export const emptyDb = () => ({
    version: SCHEMA_VERSION,
    resins: [],
    colorants: [],
    formulations: [],
    settings: {
        baseResinId: null,
        carrierId: null,
        condition: '',
        maxTotalC: null,
        deltaEThreshold: 1.0,
    },
});

export function loadDb() {
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return emptyDb();
        return migrate(JSON.parse(raw));
    } catch (e) {
        console.warn('讀取資料失敗，改用空資料庫', e);
        return emptyDb();
    }
}

export function saveDb(db) {
    try {
        window.localStorage.setItem(KEY, JSON.stringify(db));
        return true;
    } catch (e) {
        console.warn('儲存失敗（可能超出瀏覽器容量）', e);
        return false;
    }
}

/** 版本遷移。目前只有 v1，先把掛鉤留著。 */
export function migrate(db) {
    const base = emptyDb();
    const out = {
        ...base, ...db,
        settings: { ...base.settings, ...(db.settings || {}) },
        resins: (db.resins || []).map(makeResin),
        colorants: (db.colorants || []).map(makeColorant),
        formulations: (db.formulations || []).map(makeFormulation),
    };
    out.version = SCHEMA_VERSION;
    return out;
}

/* ------------------------------------------------------------------ *
 * JSON 備份
 * ------------------------------------------------------------------ */

export function exportJson(db) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    return {
        filename: `recipe_backup_${stamp}.json`,
        content: JSON.stringify({ ...db, exportedAt: new Date().toISOString() }, null, 2),
    };
}

export function importJson(text) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('檔案格式不是有效的 JSON 物件');
    if (!Array.isArray(parsed.colorants) && !Array.isArray(parsed.formulations)) {
        throw new Error('檔案裡找不到 colorants 或 formulations，可能不是本程式的備份檔');
    }
    return migrate(parsed);
}

/** 觸發瀏覽器下載 */
export function download(filename, content, type = 'application/json') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default { KEY, SCHEMA_VERSION, emptyDb, loadDb, saveDb, migrate, exportJson, importJson, download };
