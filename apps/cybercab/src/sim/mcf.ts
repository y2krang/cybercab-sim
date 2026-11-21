// A small min-cost flow solver (spec section 8: rebalancing "min-cost flow, own
// small solver"). Successive shortest paths with Dijkstra and node potentials;
// all edge costs are non-negative, so no negative-cycle handling is needed.

export class MinCostFlow {
  private readonly head: number[];
  private readonly to: number[] = [];
  private readonly cap: number[] = [];
  private readonly cost: number[] = [];
  private readonly next: number[] = [];

  constructor(readonly n: number) {
    this.head = new Array(n).fill(-1);
  }

  /** Add an edge u -> v; returns its index (use flowOn(index) after run). */
  addEdge(u: number, v: number, cap: number, cost: number): number {
    if (cost < 0) throw new Error('MinCostFlow needs non-negative costs');
    const e = this.to.length;
    this.to.push(v, u);
    this.cap.push(cap, 0);
    this.cost.push(cost, -cost);
    this.next.push(this.head[u], this.head[v]);
    this.head[u] = e;
    this.head[v] = e + 1;
    return e;
  }

  /** Flow sent along edge e. */
  flowOn(e: number): number {
    return this.cap[e + 1];
  }

  /** Send up to maxFlow from s to t at least total cost. */
  run(s: number, t: number, maxFlow = Infinity): { flow: number; cost: number } {
    const n = this.n;
    const pot = new Float64Array(n);
    const dist = new Float64Array(n);
    const prevE = new Int32Array(n);
    let flow = 0;
    let total = 0;
    // Binary heap of [dist, node].
    const hd: number[] = [];
    const hn: number[] = [];
    const push = (d: number, v: number) => {
      let i = hd.length;
      hd.push(d); hn.push(v);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hd[p] <= hd[i]) break;
        [hd[p], hd[i]] = [hd[i], hd[p]]; [hn[p], hn[i]] = [hn[i], hn[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const d = hd[0];
      const v = hn[0];
      const ld = hd.pop()!;
      const lv = hn.pop()!;
      if (hd.length) {
        hd[0] = ld; hn[0] = lv;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < hd.length && hd[l] < hd[m]) m = l;
          if (r < hd.length && hd[r] < hd[m]) m = r;
          if (m === i) break;
          [hd[m], hd[i]] = [hd[i], hd[m]]; [hn[m], hn[i]] = [hn[i], hn[m]];
          i = m;
        }
      }
      return [d, v];
    };

    while (flow < maxFlow) {
      dist.fill(Infinity);
      prevE.fill(-1);
      dist[s] = 0;
      push(0, s);
      while (hd.length) {
        const [d, u] = pop();
        if (d > dist[u]) continue;
        for (let e = this.head[u]; e >= 0; e = this.next[e]) {
          if (this.cap[e] <= 0) continue;
          const v = this.to[e];
          const nd = d + this.cost[e] + pot[u] - pot[v];
          if (nd < dist[v] - 1e-9) {
            dist[v] = nd;
            prevE[v] = e;
            push(nd, v);
          }
        }
      }
      if (dist[t] === Infinity) break;
      for (let v = 0; v < n; v++) if (dist[v] < Infinity) pot[v] += dist[v];
      let push2 = maxFlow - flow;
      for (let v = t; v !== s; v = this.to[prevE[v] ^ 1]) push2 = Math.min(push2, this.cap[prevE[v]]);
      for (let v = t; v !== s; v = this.to[prevE[v] ^ 1]) {
        const e = prevE[v];
        this.cap[e] -= push2;
        this.cap[e ^ 1] += push2;
        total += push2 * this.cost[e];
      }
      flow += push2;
    }
    return { flow, cost: total };
  }
}
