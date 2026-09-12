export type ToolItem = {
  href: string;
  category: string;
  title: string;
  description: string;
};

export const tools: ToolItem[] = [
  {
    href: '/tools/scrum-poker',
    category: 'Collaboration',
    title: 'Scrum Poker',
    description:
      'Peer-to-peer planning poker with room links, hidden votes, reveal controls, and round statistics.',
  },
  {
    href: '/tools/wheel-of-names',
    category: 'Facilitation',
    title: 'Wheel of Names',
    description:
      'A simple random name picker for stand-ups, workshops, games, and anywhere you need to choose someone fairly.',
  },
];
