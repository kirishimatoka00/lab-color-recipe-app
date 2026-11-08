import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import './index.css';

import { loadDb, saveDb, exportJson, importJson, download, emptyDb } from './data/store.js';
import { exportExcel, importExcel, templateExcel } from './data/excelIO.js';
import { compile } from './color/engine.js';
import RecipeView from './views/RecipeView.jsx';
import LibraryView from './views/LibraryView.jsx';
import HistoryView from './views/HistoryView.jsx';
import { Button, Select, Warnings } from './components/ui.jsx';
import { demoDb } from './data/demo.js';

const TABS = [
    { id: 'recipe', label: '配方工作台' },
    { id: 'library', label: '色料資料庫' },
    { id: 'history', label: '歷史配方' },
];

function App() {
    const [db, setDb] = React.useState(() => loadDb());
    const [tab, setTab] = React.useState('recipe');
    const fileRef = React.useRef(null);
    const xlsxRef = React.useRef(null);

    // 存檔節流：輸入過程不要每個按鍵都寫 localStorage
    React.useEffect(() => {
        const t = setTimeout(() => saveDb(db), 400);
        return () => clearTimeout(t);
    }, [db]);

    const settings = db.settings;
    const setSettings = (patch) => setDb((d) => ({ ...d, settings: { ...d.settings, ...patch } }));

    const compiled = React.useMemo(
        () => compile(db, settings),
        [db.resins, db.colorants, db.formulations, settings.baseResinId, settings.carrierId, settings.condition],
    );

    const handleImport = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const next = importJson(String(reader.result));
                if (window.confirm('匯入會取代目前所有資料，確定要繼續嗎？')) setDb(next);
            } catch (err) {
                window.alert(`匯入失敗：${err.message}`);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const handleExcelImport = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const { db: next, report } = importExcel(reader.result, db);
                const lines = [
                    ...Object.entries(report.added).map(([k, v]) => `新增 ${k} ${v} 筆`),
                    ...Object.entries(report.updated).map(([k, v]) => `更新 ${k} ${v} 筆`),
                ];
                const skipped = report.skipped.length
                    ? `\n\n略過 ${report.skipped.length} 列：\n${report.skipped.slice(0, 8).join('\n')}`
                    : '';
                setDb(next);
                window.alert(`${lines.join('\n') || '沒有讀到可用資料'}${skipped}`);
            } catch (err) {
                window.alert(`Excel 匯入失敗：${err.message}`);
            }
        };
        reader.readAsArrayBuffer(file);
        e.target.value = '';
    };

    const saveXlsx = ({ filename, buffer }) =>
        download(filename, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const baseResins = db.resins.filter((r) => r.usage !== 'carrier');
    const carriers = db.resins.filter((r) => r.usage !== 'base');

    return (
        <div className="flex h-full flex-col bg-slate-100 font-[Roboto,system-ui,sans-serif]">
            <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-300 bg-white px-4 py-2">
                <h1 className="text-sm font-semibold text-slate-800">配色配方預測</h1>

                <nav className="flex gap-1 rounded-lg bg-slate-100 p-1">
                    {TABS.map((t) => (
                        <button key={t.id} onClick={() => setTab(t.id)}
                            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                                tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                            {t.label}
                        </button>
                    ))}
                </nav>

                <div className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span>基礎樹酯</span>
                    <Select value={settings.baseResinId || ''} className="w-36 py-1 text-[11px]"
                        onChange={(e) => setSettings({ baseResinId: e.target.value || null })}>
                        <option value="">未指定</option>
                        {baseResins.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </Select>
                    <span>載體</span>
                    <Select value={settings.carrierId || ''} className="w-32 py-1 text-[11px]"
                        onChange={(e) => setSettings({ carrierId: e.target.value || null })}>
                        <option value="">未指定</option>
                        {carriers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </Select>
                </div>

                <div className="ml-auto flex items-center gap-2">
                    {db.colorants.length === 0 && (
                        <Button onClick={() => setDb(demoDb())}>載入範例資料</Button>
                    )}
                    <Button onClick={() => saveXlsx(exportExcel(db, compiled))}>匯出 Excel</Button>
                    <Button onClick={() => xlsxRef.current?.click()}>匯入 Excel</Button>
                    <Button variant="ghost" onClick={() => saveXlsx(templateExcel())}>空白範本</Button>
                    <span className="mx-1 h-4 w-px bg-slate-200" />
                    <Button onClick={() => {
                        const { filename, content } = exportJson(db);
                        download(filename, content);
                    }}>匯出備份</Button>
                    <Button onClick={() => fileRef.current?.click()}>匯入備份</Button>
                    <Button variant="danger" onClick={() => {
                        if (window.confirm('清除所有資料？這個動作無法復原。')) setDb(emptyDb());
                    }}>清空</Button>
                    <input ref={fileRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
                    <input ref={xlsxRef} type="file" accept=".xlsx,.xls" onChange={handleExcelImport} className="hidden" />
                </div>
            </header>

            {compiled.warnings.length > 0 && (
                <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
                    <Warnings items={compiled.warnings} />
                </div>
            )}

            <main className="min-h-0 flex-1 overflow-hidden">
                {tab === 'recipe' && (
                    <RecipeView db={db} compiled={compiled} settings={settings} onSettings={setSettings} />
                )}
                {tab === 'library' && (
                    <LibraryView db={db} compiled={compiled} onChange={setDb} />
                )}
                {tab === 'history' && (
                    <HistoryView db={db} compiled={compiled} settings={settings} onChange={setDb} />
                )}
            </main>
        </div>
    );
}

createRoot(document.getElementById('root')).render(<App />);
