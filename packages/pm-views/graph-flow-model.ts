import type { Edge, Node, Position } from '@xyflow/react';
import type { GraphData, GraphLink, GraphNode } from '../pm-schema/graph.ts';

export type GraphDirection = 'RIGHT' | 'DOWN';
export const GRAPH_NODE_WIDTH = 252;
export const GRAPH_NODE_HEIGHT = 112;
export type GraphFlowNode = Node<{ entity: GraphNode; degree: number }, 'entity'>;
export type GraphFlowEdge = Edge<{ kind: string; lane: number; parallelCount: number }, 'relationship'>;
export interface GraphFlowModel {
  nodes: GraphFlowNode[];
  edges: GraphFlowEdge[];
  neighbors: Map<string, Set<string>>;
}

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const compareLinks = (left: GraphLink, right: GraphLink) => compareText(left.source, right.source)
  || compareText(left.target, right.target) || compareText(left.kind, right.kind) || compareText(left.id, right.id);

/**
 * Adapt authorized DTOs without sharing mutable node/edge objects with React Flow.
 * Each lane is measured in the canonical (lexically smaller to larger ID) pair
 * direction. A renderer using a directed-edge normal must negate a reverse
 * edge's lane. Self-reference lanes are instead zero-based nested loop indices.
 */
export function buildFlowGraph(data: GraphData, direction: GraphDirection): GraphFlowModel {
  const entities = [...data.nodes].sort((left, right) => compareText(left.id, right.id));
  const neighbors = new Map(entities.map(node => [node.id, new Set<string>()]));
  const degrees = new Map<string, number>();
  const groups = new Map<string, GraphLink[]>();
  for (const link of [...data.links].sort(compareLinks)) {
    neighbors.get(link.source)?.add(link.target);
    neighbors.get(link.target)?.add(link.source);
    degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
    if (link.target !== link.source) degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
    const pair = link.source <= link.target ? [link.source, link.target] : [link.target, link.source];
    const key = JSON.stringify(pair);
    const group = groups.get(key);
    if (group) group.push(link); else groups.set(key, [link]);
  }

  // Keep a usable non-overlapping grid even when the worker cannot lay out.
  // Transposing its row/column progression also makes the fallback directional.
  const columns = Math.max(1, Math.ceil(Math.sqrt(entities.length)));
  const nodes: GraphFlowNode[] = entities.map((entity, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return {
      id: entity.id,
      type: 'entity',
      position: {
        x: (direction === 'RIGHT' ? column : row) * (GRAPH_NODE_WIDTH + 100),
        y: (direction === 'RIGHT' ? row : column) * (GRAPH_NODE_HEIGHT + 88),
      },
      // Position is a string enum; type-only imports keep this adapter runnable
      // in pure Node regression tests without loading React Flow or React.
      sourcePosition: (direction === 'RIGHT' ? 'right' : 'bottom') as Position,
      targetPosition: (direction === 'RIGHT' ? 'left' : 'top') as Position,
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
      style: { width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT },
      data: { entity: { ...entity }, degree: degrees.get(entity.id) ?? 0 },
      deletable: false,
      connectable: false,
    };
  });
  const edges: GraphFlowEdge[] = [];
  for (const group of groups.values()) {
    group.forEach((link, index) => edges.push({
      id: link.id,
      type: 'relationship',
      source: link.source,
      target: link.target,
      sourceHandle: 'out',
      targetHandle: 'in',
      data: {
        kind: link.kind,
        lane: link.source === link.target ? index : index - (group.length - 1) / 2,
        parallelCount: group.length,
      },
      deletable: false,
      reconnectable: false,
    }));
  }
  edges.sort((left, right) => compareText(left.id, right.id));
  return { nodes, edges, neighbors };
}
