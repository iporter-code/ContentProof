import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
export default function GraphCanvas({
  nodes,
  edges,
  onOpen,
}: {
  nodes: Node[];
  edges: Edge[];
  onOpen: (id: string) => void;
}) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges.map((edge) => ({
        ...edge,
        markerEnd: { type: MarkerType.ArrowClosed },
      }))}
      fitView
      onNodeDoubleClick={(_, node) => onOpen(node.id)}
    >
      <Background gap={24} color="#d7e2dc" />
      <Controls />
    </ReactFlow>
  );
}
