import React from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Text, Line } from '@react-three/drei';
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { labToRgbNormalized } from '../color/colorUtils.js';

/**
 * Lab 空間 3D 視圖。
 * 座標對應沿用 lab-color-app：X = a*，Y = L*，Z = b*，
 * L 置中到 0（即 Y = L − 50），這樣旋轉時重心才在畫面中間。
 */

const toXYZ = (p) => [p.a, p.l - 50, p.b];

function GamutHull({ points, opacity = 0.18 }) {
    const geometry = React.useMemo(() => {
        if (!points || points.length < 4) return null;
        // 點太多時抽樣，凸包只需要外殼，全部丟進去只是浪費
        const step = Math.max(1, Math.ceil(points.length / 1200));
        const vs = [];
        for (let i = 0; i < points.length; i += step) {
            const [x, y, z] = toXYZ(points[i]);
            vs.push(new THREE.Vector3(x, y, z));
        }
        try {
            return new ConvexGeometry(vs);
        } catch {
            return null; // 點共面時 ConvexGeometry 會丟錯
        }
    }, [points]);

    React.useEffect(() => () => geometry?.dispose(), [geometry]);
    if (!geometry) return null;

    return (
        <>
            <mesh geometry={geometry}>
                <meshStandardMaterial
                    color="#60a5fa" transparent opacity={opacity}
                    side={THREE.DoubleSide} depthWrite={false} roughness={0.6}
                />
            </mesh>
            <lineSegments>
                <wireframeGeometry args={[geometry]} />
                <lineBasicMaterial color="#3b82f6" transparent opacity={0.15} />
            </lineSegments>
        </>
    );
}

function PointCloud({ points, max = 2500 }) {
    const geometry = React.useMemo(() => {
        if (!points?.length) return null;
        const step = Math.max(1, Math.ceil(points.length / max));
        const pos = [], col = [];
        for (let i = 0; i < points.length; i += step) {
            const p = points[i];
            const [x, y, z] = toXYZ(p);
            pos.push(x, y, z);
            const [r, g, b] = labToRgbNormalized(p.l, p.a, p.b);
            col.push(r, g, b);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        return g;
    }, [points, max]);

    React.useEffect(() => () => geometry?.dispose(), [geometry]);
    if (!geometry) return null;

    return (
        <points geometry={geometry}>
            <pointsMaterial size={1.6} vertexColors sizeAttenuation transparent opacity={0.55} />
        </points>
    );
}

function Marker({ lab, label, shape = 'sphere', color, size = 3 }) {
    if (!lab) return null;
    const [x, y, z] = toXYZ(lab);
    const fill = `rgb(${labToRgbNormalized(lab.l, lab.a, lab.b).map((v) => Math.round(v * 255)).join(',')})`;
    return (
        <group position={[x, y, z]}>
            <mesh>
                {shape === 'box'
                    ? <boxGeometry args={[size * 1.6, size * 1.6, size * 1.6]} />
                    : <sphereGeometry args={[size, 20, 20]} />}
                <meshStandardMaterial color={fill} roughness={0.35} />
            </mesh>
            <mesh>
                {shape === 'box'
                    ? <boxGeometry args={[size * 1.75, size * 1.75, size * 1.75]} />
                    : <sphereGeometry args={[size * 1.12, 20, 20]} />}
                <meshBasicMaterial color={color} wireframe />
            </mesh>
            {label && (
                <Text position={[0, size + 4, 0]} fontSize={4.5} color={color} anchorX="center">
                    {label}
                </Text>
            )}
        </group>
    );
}

function Axes({ range = 60 }) {
    const grey = '#94a3b8';
    const ticks = [];
    for (let v = -range; v <= range; v += 20) {
        if (v === 0) continue;
        ticks.push(
            <Text key={`a${v}`} position={[v, -52, 0]} fontSize={3.4} color={grey} anchorX="center">{v}</Text>,
        );
    }
    for (let l = 0; l <= 100; l += 20) {
        ticks.push(
            <Text key={`l${l}`} position={[-range - 7, l - 50, 0]} fontSize={3.4} color={grey} anchorX="center">{l}</Text>,
        );
    }
    return (
        <>
            <Line points={[[-range, -50, 0], [range, -50, 0]]} color={grey} lineWidth={1} />
            <Line points={[[0, -50, -range], [0, -50, range]]} color={grey} lineWidth={1} />
            <Line points={[[0, -50, 0], [0, 50, 0]]} color={grey} lineWidth={1} />
            <Text position={[range + 8, -50, 0]} fontSize={5} color="#dc2626" anchorX="center">+a*</Text>
            <Text position={[-range - 8, -50, 0]} fontSize={5} color="#16a34a" anchorX="center">−a*</Text>
            <Text position={[0, -50, range + 8]} fontSize={5} color="#ca8a04" anchorX="center">+b*</Text>
            <Text position={[0, -50, -range - 8]} fontSize={5} color="#2563eb" anchorX="center">−b*</Text>
            <Text position={[0, 56, 0]} fontSize={5} color={grey} anchorX="center">L* 100</Text>
            <gridHelper args={[range * 2, 12, '#e2e8f0', '#eef2f7']} position={[0, -50, 0]} />
            {ticks}
        </>
    );
}

export default function Lab3D({
    gamutPoints = [], target = null, predicted = null, corrections = null,
    showCloud = true, showHull = true, height = 420,
}) {
    const corrColors = { C1: '#f97316', C2: '#06b6d4', C3: '#22c55e' };
    const range = React.useMemo(() => {
        let m = 40;
        for (const p of [...gamutPoints, target, predicted].filter(Boolean)) {
            m = Math.max(m, Math.abs(p.a), Math.abs(p.b));
        }
        return Math.ceil((m * 1.1) / 20) * 20;
    }, [gamutPoints, target, predicted]);

    return (
        <div style={{ height }} className="overflow-hidden rounded-md border border-slate-200 bg-slate-50">
            <Canvas camera={{ position: [120, 80, 140], fov: 45 }} dpr={[1, 2]}>
                <ambientLight intensity={0.85} />
                <directionalLight position={[80, 120, 60]} intensity={0.7} />
                <Axes range={range} />
                {showHull && <GamutHull points={gamutPoints} />}
                {showCloud && <PointCloud points={gamutPoints} />}

                {corrections && target && ['C1', 'C2', 'C3'].map((k) => {
                    const c = corrections[k];
                    if (!c) return null;
                    return (
                        <group key={k}>
                            <Line points={[toXYZ(target), toXYZ(c)]} color={corrColors[k]} lineWidth={1.5} dashed dashSize={2} gapSize={1.5} />
                            <Marker lab={c} label={k} color={corrColors[k]} size={2} />
                        </group>
                    );
                })}

                <Marker lab={predicted} label="預測" color="#0f172a" />
                <Marker lab={target} label="目標" color="#dc2626" shape="box" />

                <OrbitControls enablePan enableZoom makeDefault />
            </Canvas>
        </div>
    );
}
