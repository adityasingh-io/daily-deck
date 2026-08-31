/* Quota-aware selection (before the expensive writer pass) and
   cluster interleaving (after it). */

export function selectByQuota(scored, quotas) {
  const byTopic = new Map();
  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    const list = byTopic.get(item.topic) ?? [];
    if (list.length < (quotas[item.topic] ?? 0)) {
      // max 2 per source per deck, so no feed gets monotone
      if (list.filter((c) => c.source === item.source).length < 2) {
        list.push(item);
        byTopic.set(item.topic, list);
      }
    }
  }
  return [...byTopic.values()].flat();
}

export function interleave(cards, wildcards, quotas) {
  const topic = (t) => cards.filter((c) => c.topic === t);
  const clusters = [
    topic("psych"),
    [...topic("books"), ...topic("philosophy")],
    [...topic("tech-craft"), ...topic("tech-ai")],
    [...topic("world"), ...topic("econ")],
    wildcards.slice(0, quotas.wildcard ?? 4),
  ];

  const deck = [];
  let added = true;
  while (added) {
    added = false;
    for (const cluster of clusters) {
      const next = cluster.shift();
      if (next) {
        const { score, fullInFeed, ...card } = next;
        deck.push(card);
        added = true;
      }
    }
  }
  return deck;
}
