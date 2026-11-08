import React from 'react';
import {
    Card, Button, Field, NumberInput, TextInput, Select, LabInput, Swatch, Empty, fmt,
} from '../components/ui.jsx';
import {
    makeColorant, makeResin, makeCurvePoint, COLORANT_TYPE, COLORANT_ROLE, ADDITIVE_TYPE,
    dosageToC,
} from '../data/schema.js';

/**
 * 色料與樹酯資料庫。
 * 濃度曲線以「色母添加量」輸入（現場量測就是這樣記的），
 * 畫面上同步顯示換算後的顏料有效濃度，避免兩者搞混。
 */
export default function LibraryView({ db, compiled, onChange }) {
    const [tab, setTab] = React.useState('colorants');
    const [editing, setEditing] = React.useState(null);

    const update = (patch) => onChange({ ...db, ...patch });

    return (
        <div className="grid h-full grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-[360px_minmax(0,1fr)]">
            <div className="space-y-3">
                <div className="flex gap-1 rounded-lg surface-3 p-1">
                    {[['colorants', `色料 ${db.colorants.length}`], ['resins', `樹酯 ${db.resins.length}`]].map(([id, label]) => (
                        <button key={id} onClick={() => { setTab(id); setEditing(null); }}
                            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${
                                tab === id ? 'surface text-main shadow-sm' : 'text-muted'}`}>
                            {label}
                        </button>
                    ))}
                </div>

                {tab === 'colorants' ? (
                    <Card title="色料（SPD / 色粉）" right={
                        <Button variant="primary" onClick={() => {
                            const c = makeColorant({ name: '新色料' });
                            update({ colorants: [...db.colorants, c] });
                            setEditing(c.id);
                        }}>新增</Button>
                    }>
                        {db.colorants.length === 0 ? <Empty>尚未建立色料</Empty> : (
                            <div className="space-y-1">
                                {db.colorants.map((c) => {
                                    const m = compiled.models[c.id];
                                    return (
                                        <button key={c.id} onClick={() => setEditing(c.id)}
                                            className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left ${
                                                editing === c.id ? 'accent-edge accent-soft' : 'border-base hover-row'}`}>
                                            <Swatch lab={c.curve?.[c.curve.length - 1]?.lab} size={20} />
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate text-xs font-medium text-sub">{c.name || '(未命名)'}</div>
                                                <div className="text-[10px] text-faint">
                                                    含量 {fmt(c.pigmentLoading, 1)}% · {c.curve.length} 點
                                                    {c.role === COLORANT_ROLE.WHITE && ' · 白'}
                                                </div>
                                            </div>
                                            {m ? (
                                                <span className="shrink-0 text-[10px] text-good">已建模</span>
                                            ) : (
                                                <span className="shrink-0 text-[10px] text-ghost">資料不足</span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </Card>
                ) : (
                    <Card title="樹酯（基礎 / 載體）" right={
                        <Button variant="primary" onClick={() => {
                            const r = makeResin({ name: '新樹酯' });
                            update({ resins: [...db.resins, r] });
                            setEditing(r.id);
                        }}>新增</Button>
                    }>
                        {db.resins.length === 0 ? <Empty>尚未建立樹酯</Empty> : (
                            <div className="space-y-1">
                                {db.resins.map((r) => (
                                    <button key={r.id} onClick={() => setEditing(r.id)}
                                        className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left ${
                                            editing === r.id ? 'accent-edge accent-soft' : 'border-base hover-row'}`}>
                                        <Swatch lab={r.blankLab} size={20} />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-xs font-medium text-sub">{r.name || '(未命名)'}</div>
                                            <div className="text-[10px] text-faint">
                                                {r.grade || '—'} · {r.blankLab ? '已量測本色' : '未量測本色'}
                                            </div>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </Card>
                )}
            </div>

            <div>
                {tab === 'colorants' ? (
                    <ColorantEditor
                        colorant={db.colorants.find((c) => c.id === editing)}
                        db={db} compiled={compiled}
                        onSave={(next) => update({ colorants: db.colorants.map((c) => (c.id === next.id ? next : c)) })}
                        onDelete={(id) => { update({ colorants: db.colorants.filter((c) => c.id !== id) }); setEditing(null); }}
                    />
                ) : (
                    <ResinEditor
                        resin={db.resins.find((r) => r.id === editing)}
                        onSave={(next) => update({ resins: db.resins.map((r) => (r.id === next.id ? next : r)) })}
                        onDelete={(id) => { update({ resins: db.resins.filter((r) => r.id !== id) }); setEditing(null); }}
                    />
                )}
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */

function ResinEditor({ resin, onSave, onDelete }) {
    if (!resin) return <Card title="樹酯"><Empty>選一個樹酯，或新增一個</Empty></Card>;
    const set = (patch) => onSave({ ...resin, ...patch });

    return (
        <Card title="樹酯設定" right={<Button variant="danger" onClick={() => onDelete(resin.id)}>刪除</Button>}>
            <div className="grid grid-cols-2 gap-3">
                <Field label="名稱"><TextInput value={resin.name} onChange={(e) => set({ name: e.target.value })} /></Field>
                <Field label="牌號"><TextInput value={resin.grade} onChange={(e) => set({ grade: e.target.value })} /></Field>
                <Field label="用途">
                    <Select value={resin.usage} onChange={(e) => set({ usage: e.target.value })}>
                        <option value="both">基礎樹酯與載體皆可</option>
                        <option value="base">只當基礎樹酯</option>
                        <option value="carrier">只當母粒載體</option>
                    </Select>
                </Field>
                <Field label="MFI"><NumberInput value={resin.mfi ?? ''} onChange={(v) => set({ mfi: v })} /></Field>
            </div>

            <div className="mt-3 rounded-md border border-base p-2">
                <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-medium text-sub">未著色本色 Lab</span>
                    {resin.blankLab
                        ? <Button variant="ghost" onClick={() => set({ blankLab: null })}>清除</Button>
                        : <Button onClick={() => set({ blankLab: { l: 92, a: -0.6, b: 2.4 } })}>填入</Button>}
                </div>
                {resin.blankLab
                    ? <LabInput lab={resin.blankLab} onChange={(v) => set({ blankLab: v })} />
                    : <p className="text-[11px] text-faint">
                        沒有本色量測值時會套用預設值，預測會帶系統性偏差。量一片未著色的板最有效。
                    </p>}
            </div>

            <Field label="備註" className="mt-3">
                <TextInput value={resin.note} onChange={(e) => set({ note: e.target.value })} />
            </Field>
        </Card>
    );
}

/* ------------------------------------------------------------------ */

function ColorantEditor({ colorant, db, compiled, onSave, onDelete }) {
    if (!colorant) return <Card title="色料"><Empty>選一支色料，或新增一支</Empty></Card>;
    const set = (patch) => onSave({ ...colorant, ...patch });
    const model = compiled.models[colorant.id];
    const whites = db.colorants.filter((c) => c.role === COLORANT_ROLE.WHITE && c.id !== colorant.id);

    const setPoint = (id, patch) =>
        set({ curve: colorant.curve.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

    return (
        <div className="space-y-3">
            <Card title="色料設定" right={<Button variant="danger" onClick={() => onDelete(colorant.id)}>刪除</Button>}>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Field label="名稱" className="col-span-2">
                        <TextInput value={colorant.name} onChange={(e) => set({ name: e.target.value })} />
                    </Field>
                    <Field label="編號">
                        <TextInput value={colorant.code} onChange={(e) => set({ code: e.target.value })} />
                    </Field>
                    <Field label="供應商">
                        <TextInput value={colorant.supplier} onChange={(e) => set({ supplier: e.target.value })} />
                    </Field>

                    <Field label="型態">
                        <Select value={colorant.type} onChange={(e) => {
                            const t = e.target.value;
                            set({ type: t, pigmentLoading: t === COLORANT_TYPE.RAW ? 100 : colorant.pigmentLoading });
                        }}>
                            <option value={COLORANT_TYPE.SPD}>SPD 單色色母</option>
                            <option value={COLORANT_TYPE.RAW}>單一色粉</option>
                        </Select>
                    </Field>
                    <Field label="角色" hint="白會以散射模型處理">
                        <Select value={colorant.role} onChange={(e) => set({ role: e.target.value })}>
                            <option value={COLORANT_ROLE.CHROMATIC}>彩色 / 黑</option>
                            <option value={COLORANT_ROLE.WHITE}>白（TiO₂）</option>
                        </Select>
                    </Field>
                    <Field label="顏料含量 wt%" hint="顏料佔本色母的重量比">
                        <NumberInput value={colorant.pigmentLoading}
                            onChange={(v) => set({ pigmentLoading: v })}
                            disabled={colorant.type === COLORANT_TYPE.RAW} />
                    </Field>
                    <Field label="載體樹酯">
                        <Select value={colorant.carrierId || ''} onChange={(e) => set({ carrierId: e.target.value || null })}>
                            <option value="">（無 / 色粉）</option>
                            {db.resins.filter((r) => r.usage !== 'base').map((r) =>
                                <option key={r.id} value={r.id}>{r.name}</option>)}
                        </Select>
                    </Field>

                    <Field label="最低含量 wt%" hint="顏料在最終製品的下限">
                        <NumberInput value={colorant.minFinalPct} onChange={(v) => set({ minFinalPct: v })} />
                    </Field>
                    <Field label="最高含量 wt%" hint="留空不限">
                        <NumberInput value={colorant.maxFinalPct ?? ''} onChange={(v) => set({ maxFinalPct: v })} />
                    </Field>
                </div>

                <AdditiveEditor additives={colorant.additives} onChange={(a) => set({ additives: a })} />
            </Card>

            <Card
                title={`濃度曲線（${colorant.curve.length} 點）`}
                right={
                    <div className="flex items-center gap-2">
                        {model && (
                            <span className="text-[11px] text-muted">
                                擬合：{{ linear: '線性', power: '冪次', pchip: 'PCHIP' }[model.form] || model.form}
                                {model.r2 && ` · R² ${Math.min(...model.r2).toFixed(3)}`}
                            </span>
                        )}
                        <Button variant="primary" onClick={() => set({
                            curve: [...colorant.curve, makeCurvePoint({
                                dosage: colorant.curve.length ? colorant.curve[colorant.curve.length - 1].dosage * 2 : 1,
                                lab: { l: 50, a: 0, b: 0 },
                            })],
                        })}>新增一點</Button>
                    </div>
                }
            >
                <p className="mb-2 text-[11px] text-muted">
                    至少 3 點才能建模，最多 12 點。
                    {colorant.role !== COLORANT_ROLE.WHITE && ' 若樣品含白，請一併填白色母的添加量，否則跨白階預測會失準。'}
                </p>

                {colorant.curve.length === 0 ? <Empty>尚未輸入資料點</Empty> : (
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="border-b border-base text-left text-[10px] uppercase text-faint">
                                <th className="py-1">色母添加 wt%</th>
                                <th className="py-1 text-right">顏料濃度</th>
                                {colorant.role !== COLORANT_ROLE.WHITE && <th className="py-1">白色母</th>}
                                {colorant.role !== COLORANT_ROLE.WHITE && <th className="py-1">白添加 wt%</th>}
                                <th className="py-1">量測 Lab</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {colorant.curve.map((p) => (
                                <tr key={p.id} className="border-b border-slate-100 last:border-0">
                                    <td className="py-1.5 pr-2">
                                        <NumberInput value={p.dosage} onChange={(v) => setPoint(p.id, { dosage: v })}
                                            className="w-24 py-0.5 text-right font-mono text-[11px]" />
                                    </td>
                                    <td className="py-1.5 pr-2 text-right font-mono text-[11px] text-muted">
                                        {fmt(dosageToC(p.dosage, colorant))}%
                                    </td>
                                    {colorant.role !== COLORANT_ROLE.WHITE && (
                                        <td className="py-1.5 pr-2">
                                            <Select value={p.whiteColorantId || ''}
                                                onChange={(e) => setPoint(p.id, { whiteColorantId: e.target.value || null })}
                                                className="py-0.5 text-[11px]">
                                                <option value="">無白</option>
                                                {whites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                                            </Select>
                                        </td>
                                    )}
                                    {colorant.role !== COLORANT_ROLE.WHITE && (
                                        <td className="py-1.5 pr-2">
                                            <NumberInput value={p.whiteDosage} onChange={(v) => setPoint(p.id, { whiteDosage: v })}
                                                disabled={!p.whiteColorantId}
                                                className="w-20 py-0.5 text-right font-mono text-[11px]" />
                                        </td>
                                    )}
                                    <td className="py-1.5 pr-2">
                                        <div className="flex items-center gap-1">
                                            <Swatch lab={p.lab} size={22} />
                                            {['l', 'a', 'b'].map((k) => (
                                                <NumberInput key={k} value={p.lab[k]}
                                                    onChange={(v) => setPoint(p.id, { lab: { ...p.lab, [k]: v } })}
                                                    className="w-16 py-0.5 text-center font-mono text-[11px]" />
                                            ))}
                                        </div>
                                    </td>
                                    <td className="py-1.5 text-right">
                                        <Button variant="ghost"
                                            onClick={() => set({ curve: colorant.curve.filter((x) => x.id !== p.id) })}>
                                            刪除
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}

                {colorant.curve.length > 0 && colorant.curve.length < 3 && (
                    <p className="mt-2 text-[11px] text-warn">還差 {3 - colorant.curve.length} 點才能建模。</p>
                )}
            </Card>
        </div>
    );
}

function AdditiveEditor({ additives, onChange }) {
    return (
        <div className="mt-3 rounded-md border border-base p-2">
            <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-medium text-sub">添加劑（光學上視為透明，只計入重量）</span>
                <Button onClick={() => onChange([...additives, { type: ADDITIVE_TYPE.WAX, name: '', pct: 0 }])}>新增</Button>
            </div>
            {additives.length === 0 ? (
                <p className="text-[11px] text-faint">無</p>
            ) : additives.map((a, i) => (
                <div key={i} className="mb-1 flex items-center gap-2">
                    <Select value={a.type} className="w-24 py-1 text-[11px]"
                        onChange={(e) => onChange(additives.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                        <option value={ADDITIVE_TYPE.WAX}>Wax</option>
                        <option value={ADDITIVE_TYPE.AO}>AO</option>
                        <option value={ADDITIVE_TYPE.OTHER}>其他</option>
                    </Select>
                    <TextInput value={a.name} placeholder="品名" className="flex-1 py-1 text-[11px]"
                        onChange={(e) => onChange(additives.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    <NumberInput value={a.pct} className="w-20 py-1 text-right text-[11px]"
                        onChange={(v) => onChange(additives.map((x, j) => (j === i ? { ...x, pct: v } : x)))} />
                    <span className="text-[11px] text-faint">%</span>
                    <Button variant="ghost" onClick={() => onChange(additives.filter((_, j) => j !== i))}>×</Button>
                </div>
            ))}
        </div>
    );
}
