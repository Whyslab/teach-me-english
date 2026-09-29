// Инкрементальная синхронизация: какие слова изменились с последнего
// подтверждения сервера. Без DOM и сети — тестируется напрямую.
//
// Раньше клиент после каждого ответа слал весь словарь (100–400 КБ для колоды A1),
// а сервер удалял и заново записывал все строки. Хуже того, при загрузке
// страницы серверная копия затирала локальную — ответы, сделанные, пока сервер
// перезапускался, пропадали. Теперь клиент помнит, какую версию каждого слова
// сервер уже подтвердил, и шлёт только разницу.

// Отпечаток слова: любое изменение любого поля меняет строку.
export function fingerprint(word) {
    return JSON.stringify(word);
}

// synced: Map<id, fingerprint> — версии, подтверждённые сервером.
// Возвращает { upserts: слова, которых нет на сервере или которые изменились,
//              deletes: id слов, удалённых локально, но ещё существующих на сервере }.
export function computeChanges(words, synced) {
    const upserts = [];
    const present = new Set();
    for (const w of words) {
        present.add(w.id);
        if (synced.get(w.id) !== fingerprint(w)) upserts.push(w);
    }
    const deletes = [];
    for (const id of synced.keys()) {
        if (!present.has(id)) deletes.push(id);
    }
    return { upserts, deletes };
}

// После успешной отправки: сервер теперь знает эти версии.
// sent — то, что реально ушло (отпечатки сняты в момент отправки: слово могло
// измениться, пока запрос был в пути, и тогда оно останется «грязным»).
export function applyConfirmed(synced, sent) {
    for (const [id, fp] of sent.upserts) synced.set(id, fp);
    for (const id of sent.deletes) synced.delete(id);
}

export function snapshotFor(changes) {
    return {
        upserts: changes.upserts.map(w => [w.id, fingerprint(w)]),
        deletes: [...changes.deletes],
    };
}

export function isEmpty(changes) {
    return changes.upserts.length === 0 && changes.deletes.length === 0;
}

// sendBeacon принимает не больше 64 КБ; оставляем запас.
export const BEACON_LIMIT = 60 * 1024;
