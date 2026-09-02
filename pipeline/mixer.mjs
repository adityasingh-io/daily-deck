/* FALLBACK ONLY: when the chief editor's lineup is malformed, this quota
   algorithm composes the deck so an edition always ships. */

export function selectByQuota(scored, quotas) {
  const byTopic = new Map();
  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    const list = byTopic.get(item.topic) ?? [];
    if (list.length < (quotas[item.topic] ?? 0)) {
      if (list.filter((c) => c.source === item.source).length < 2) {
        list.push(item);
        byTopic.set(item.topic, list);
      }
    }
  }
  return [...byTopic.values()].flat();
}

export function interleave(items, quotas) {
  const topic = (t) => items.filter((c) => c.topic === t);
  const clusters = [
    topic("psych"),
    [...topic("books"), ...topic("philosophy")],
    topic("tech-ai"),
    [...topic("world"), ...topic("econ")],
  ];

  const ordered = [];
  let added = true;
  while (added) {
    added = false;
    for (const cluster of clusters) {
      const next = cluster.shift();
      if (next) {
        ordered.push(next);
        added = true;
      }
    }
  }
  return ordered;
}
