/* Deterministic deck assembly: quota per topic, best score first,
   then interleave clusters so the feed alternates flavors. */

export function mixDeck(scored, wildcards, quotas) {
  const byTopic = new Map();
  for (const card of scored.sort((a, b) => b.score - a.score)) {
    const list = byTopic.get(card.topic) ?? [];
    if (list.length < (quotas[card.topic] ?? 0)) {
      // max 2 cards per source per deck, so no feed gets monotone
      if (list.filter((c) => c.source === card.source).length < 2) {
        list.push(card);
        byTopic.set(card.topic, list);
      }
    }
  }

  const clusters = [
    [...(byTopic.get("psych") ?? [])],
    [...(byTopic.get("books") ?? []), ...(byTopic.get("philosophy") ?? [])],
    [...(byTopic.get("tech-craft") ?? []), ...(byTopic.get("tech-ai") ?? [])],
    [...(byTopic.get("world") ?? []), ...(byTopic.get("econ") ?? [])],
    wildcards.slice(0, quotas.wildcard ?? 4),
  ];

  const deck = [];
  let added = true;
  while (added) {
    added = false;
    for (const cluster of clusters) {
      const next = cluster.shift();
      if (next) {
        const { score, ...card } = next;
        deck.push(card);
        added = true;
      }
    }
  }
  return deck;
}
