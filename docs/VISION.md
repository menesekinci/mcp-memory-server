# Product Vision

Codex MCP Memory Server should become a fresh, compact, ranked, evidence-backed code context layer for coding agents.

The goal is not to replace source inspection. The goal is to make the discovery and narrowing phase cheap, reliable, and low-noise so an agent reads exact source only after the relevant symbol, file, or line range is known.

## Desired Agent Experience

An agent should prefer this MCP over broad shell search because it can:

- Find the relevant source area with fewer tool calls and fewer tokens.
- Avoid stale or unsynchronized context.
- See why a result matched before reading source.
- Read only selected symbol bodies, callers, tests, decisions, or risk packets.
- Trust that compact memory and decision data is current or clearly marked as stale.

## Product Principles

- Freshness is a contract, not a best effort. Results that may be stale must say so.
- Compact output is the default. Full source bodies are opt-in.
- Fewer high-value tools are better than many narrow tools.
- Memory must reduce confusion, not preserve every old statement forever.
- Every major claim should be benchmarked by task outcome, not only by output size.
- Real repository dogfooding matters more than synthetic success.
- Privacy controls must be explicit because source bodies can be stored locally.

## Target Architecture Direction

```text
SQLite symbol index + call graph + memory
        ->
freshness-aware ranked context engine
        ->
small stable MCP tool surface
        ->
agent reads less, trusts more, succeeds faster
```

## Strategic Pillars

1. Freshness and sync guarantees.
2. A smaller agent-facing tool surface.
3. Ranked context retrieval with evidence.
4. Read-context packets that replace broad file reads.
5. Memory lifecycle controls that prevent old decisions from polluting current work.
6. Real-repository validation and task-success benchmarks.
7. Privacy and body-storage policy.
8. Setup, doctor, and onboarding polish.

