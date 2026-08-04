import { createLogger } from './logger.js';

const log = createLogger('perf');

const markers = new Map();
const measures = [];

export function startMark(name) {
    markers.set(name, performance.now());
}

export function endMark(name, logIt = true) {
    const start = markers.get(name);
    if (!start) return null;
    const duration = performance.now() - start;
    markers.delete(name);
    if (logIt) {
        log.info(`${name}: ${duration.toFixed(2)}ms`);
    }
    measures.push({ name, duration, time: Date.now() });
    if (measures.length > 100) measures.shift();
    return duration;
}

export function withPerf(fn, name) {
    return async (...args) => {
        startMark(name || fn.name);
        try {
            const result = await fn(...args);
            endMark(name || fn.name);
            return result;
        } catch (e) {
            endMark(name || fn.name);
            throw e;
        }
    };
}

export function getPerfStats() {
    if (measures.length === 0) return null;
    const byName = {};
    for (const m of measures) {
        if (!byName[m.name]) byName[m.name] = { count: 0, total: 0, max: 0, min: Infinity };
        byName[m.name].count++;
        byName[m.name].total += m.duration;
        byName[m.name].max = Math.max(byName[m.name].max, m.duration);
        byName[m.name].min = Math.min(byName[m.name].min, m.duration);
    }
    for (const name of Object.keys(byName)) {
        byName[name].avg = byName[name].total / byName[name].count;
    }
    return byName;
}

export function logPerfStats() {
    const stats = getPerfStats();
    if (!stats) {
        log.info('无性能数据');
        return;
    }
    console.table(
        Object.entries(stats).map(([name, s]) => ({
            name,
            count: s.count,
            avg: s.avg.toFixed(2) + 'ms',
            max: s.max.toFixed(2) + 'ms',
            min: s.min.toFixed(2) + 'ms',
        }))
    );
}

if (typeof window !== 'undefined') {
    window.__perf = { startMark, endMark, getPerfStats, logPerfStats };
}