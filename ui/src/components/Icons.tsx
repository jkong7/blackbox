import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 14, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const I = {
  overview: (p: P) => (
    <Svg {...p}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </Svg>
  ),
  traces: (p: P) => (
    <Svg {...p}>
      <path d="M2 3.5h7M4 8h8M6 12.5h8" />
    </Svg>
  ),
  sessions: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 3.5h8a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H6l-2.5 2v-2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" />
      <path d="M13.5 6.5v4a1 1 0 0 1-1 1h-.5" />
    </Svg>
  ),
  issues: (p: P) => (
    <Svg {...p}>
      <path d="M8 1.8l6.2 11a.8.8 0 0 1-.7 1.2h-11a.8.8 0 0 1-.7-1.2z" />
      <path d="M8 6v3.2M8 11.4v.1" />
    </Svg>
  ),
  agents: (p: P) => (
    <Svg {...p}>
      <circle cx="4" cy="4" r="2" />
      <circle cx="12" cy="4" r="2" />
      <circle cx="8" cy="12" r="2" />
      <path d="M5.2 5.6L7 10.3M10.8 5.6L9 10.3M6 4h4" />
    </Svg>
  ),
  evals: (p: P) => (
    <Svg {...p}>
      <path d="M3 8.5l3 3 7-7" />
    </Svg>
  ),
  annotate: (p: P) => (
    <Svg {...p}>
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
    </Svg>
  ),
  datasets: (p: P) => (
    <Svg {...p}>
      <ellipse cx="8" cy="3.8" rx="5" ry="1.8" />
      <path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" />
    </Svg>
  ),
  connect: (p: P) => (
    <Svg {...p}>
      <path d="M6 10l4-4M7 3.5l1-1a3 3 0 0 1 4.5 4.5l-1 1M9 12.5l-1 1A3 3 0 0 1 3.5 9l1-1" />
    </Svg>
  ),
  search: (p: P) => (
    <Svg {...p}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </Svg>
  ),
  sun: (p: P) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
    </Svg>
  ),
  moon: (p: P) => (
    <Svg {...p}>
      <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z" />
    </Svg>
  ),
  system: (p: P) => (
    <Svg {...p}>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14" />
    </Svg>
  ),
  chevronRight: (p: P) => (
    <Svg {...p}>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </Svg>
  ),
  chevronDown: (p: P) => (
    <Svg {...p}>
      <path d="M3.5 6L8 10.5 12.5 6" />
    </Svg>
  ),
  chevronLeft: (p: P) => (
    <Svg {...p}>
      <path d="M10 3.5L5.5 8 10 12.5" />
    </Svg>
  ),
  copy: (p: P) => (
    <Svg {...p}>
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </Svg>
  ),
  check: (p: P) => (
    <Svg {...p}>
      <path d="M3 8.5l3 3 7-7" />
    </Svg>
  ),
  x: (p: P) => (
    <Svg {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  ),
  plus: (p: P) => (
    <Svg {...p}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  ),
  play: (p: P) => (
    <Svg {...p}>
      <path d="M4.5 3l8 5-8 5z" />
    </Svg>
  ),
  sparkle: (p: P) => (
    <Svg {...p}>
      <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2L12 12M4 12l1.8-1.8M10.2 5.8L12 4" />
    </Svg>
  ),
  inbox: (p: P) => (
    <Svg {...p}>
      <path d="M2 9l2-6h8l2 6v4H2zM2 9h3.5l1 1.5h3l1-1.5H14" />
    </Svg>
  ),
  filter: (p: P) => (
    <Svg {...p}>
      <path d="M2 3h12l-4.5 5.5V13l-3-1.5v-3z" />
    </Svg>
  ),
  external: (p: P) => (
    <Svg {...p}>
      <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    </Svg>
  ),
  alert: (p: P) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5M8 10.8v.1" />
    </Svg>
  ),
  flag: (p: P) => (
    <Svg {...p}>
      <path d="M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8" />
    </Svg>
  ),
  dot: (p: P) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
    </Svg>
  ),
  agent: (p: P) => (
    <Svg {...p}>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2.5V5M6 9h.01M10 9h.01" />
    </Svg>
  ),
  llm: (p: P) => (
    <Svg {...p}>
      <path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z" />
    </Svg>
  ),
  tool: (p: P) => (
    <Svg {...p}>
      <path d="M10 2.5a3.5 3.5 0 0 0-3.3 4.6L2.5 11.3l2.2 2.2 4.2-4.2A3.5 3.5 0 0 0 13.5 6l-2 2-2-.5-.5-2 2-2a3.5 3.5 0 0 0-1-.5z" />
    </Svg>
  ),
  mcp: (p: P) => (
    <Svg {...p}>
      <path d="M5.5 2.5v3M10.5 2.5v3M3.5 5.5h9v2.5a4.5 4.5 0 0 1-9 0zM8 12.5v1.5" />
    </Svg>
  ),
  memory: (p: P) => (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
      <path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" />
    </Svg>
  ),
  retriever: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 4h6M2.5 7.5h4M2.5 11h3" />
      <circle cx="10.5" cy="9.5" r="2.5" />
      <path d="M12.3 11.3L14 13" />
    </Svg>
  ),
  embedding: (p: P) => (
    <Svg {...p}>
      <circle cx="4" cy="11" r="1.2" />
      <circle cx="8" cy="5" r="1.2" />
      <circle cx="12" cy="9" r="1.2" />
      <path d="M2 14h12M2 2v12" />
    </Svg>
  ),
  handoff: (p: P) => (
    <Svg {...p}>
      <path d="M2 5.5h9.5M9 3l2.5 2.5L9 8M14 10.5H4.5M7 8l-2.5 2.5L7 13" />
    </Svg>
  ),
  guardrail: (p: P) => (
    <Svg {...p}>
      <path d="M8 1.8l5 2v4c0 3.2-2.2 5.3-5 6.4-2.8-1.1-5-3.2-5-6.4v-4z" />
    </Svg>
  ),
  chain: (p: P) => (
    <Svg {...p}>
      <rect x="1.5" y="5.5" width="6" height="5" rx="2.5" />
      <rect x="8.5" y="5.5" width="6" height="5" rx="2.5" />
    </Svg>
  ),
  evaluator: (p: P) => (
    <Svg {...p}>
      <path d="M3 13h10M5 13V8M8 13V4M11 13V6.5" />
    </Svg>
  ),
  span: (p: P) => (
    <Svg {...p}>
      <rect x="2" y="6" width="12" height="4" rx="1" />
    </Svg>
  ),
  graph: (p: P) => (
    <Svg {...p}>
      <circle cx="3.5" cy="8" r="1.8" />
      <circle cx="12.5" cy="4" r="1.8" />
      <circle cx="12.5" cy="12" r="1.8" />
      <path d="M5.2 7.3l5.6-2.6M5.2 8.7l5.6 2.6" />
    </Svg>
  ),
  tree: (p: P) => (
    <Svg {...p}>
      <path d="M3 2.5v9.5h3M3 7h3M8 3h6M8 7h6M8 12h6" />
    </Svg>
  ),
  layers: (p: P) => (
    <Svg {...p}>
      <path d="M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3" />
    </Svg>
  ),
  trash: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />
    </Svg>
  ),
  edit: (p: P) => (
    <Svg {...p}>
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
    </Svg>
  ),
  refresh: (p: P) => (
    <Svg {...p}>
      <path d="M13.5 8A5.5 5.5 0 1 1 11.8 4M13.5 2v3h-3" />
    </Svg>
  ),
  user: (p: P) => (
    <Svg {...p}>
      <circle cx="8" cy="5.5" r="2.8" />
      <path d="M2.5 14c.6-2.8 2.8-4.3 5.5-4.3s4.9 1.5 5.5 4.3" />
    </Svg>
  ),
  clock: (p: P) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </Svg>
  ),
  coins: (p: P) => (
    <Svg {...p}>
      <ellipse cx="6.5" cy="5" rx="4" ry="2" />
      <path d="M2.5 5v3c0 1.1 1.8 2 4 2M10.5 5v1" />
      <ellipse cx="10" cy="10" rx="4" ry="2" />
      <path d="M6 10v2c0 1.1 1.8 2 4 2s4-.9 4-2v-2" />
    </Svg>
  ),
  terminal: (p: P) => (
    <Svg {...p}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.5L6.5 8.5 4.5 10.5M8.5 10.5h3" />
    </Svg>
  ),
};

export type IconName = keyof typeof I;
