export type ProjectItem = {
  slug: string;
  area: string;
  tech: string;
  title: string;
  description: string;
  featured?: boolean;
};

export const projects: ProjectItem[] = [
  {
    slug: 'business-banking',
    area: 'Mobile banking',
    tech: 'React Native · TypeScript',
    title: 'Business banking',
    description:
      'A production mobile banking application spanning accounts, transactions, payments, authentication, security, support, and native platform integrations across iOS and Android.',
    featured: true,
  },
  {
    slug: 'mortgage-loan-readiness',
    area: 'Lending automation',
    tech: 'React · Node.js · Serverless',
    title: 'Mortgage loan readiness',
    description:
      'A lending platform that brought loans together from multiple origination systems, validated MISMO data, identified missing information, and guided loan officers through pricing, underwriting, and lender submission while keeping the originating system in sync.',
    featured: true,
  },
  {
    slug: 'vehicle-auctions',
    area: 'Marketplace',
    tech: 'React · Node.js · GraphQL',
    title: 'Real-time vehicle auctions',
    description:
      'A marketplace for listing and auctioning vehicles through timed, real-time bidding, with seller profiles, follows, activity feeds, payments, and email notifications.',
    featured: true,
  },
  {
    slug: 'mortgage-point-of-sale',
    area: 'Mortgage origination',
    tech: 'React · Node.js · PostgreSQL',
    title: 'Mortgage point of sale',
    description:
      'A borrower-facing loan application that captured financial, employment, property, asset, liability, and co-borrower information, then transformed it into MISMO 3.4 files ready for submission to loan origination systems.',
    featured: true,
  },
  {
    slug: 'workplace-operations',
    area: 'Workplace tools',
    tech: 'React · Node.js · PostgreSQL',
    title: 'Workplace operations',
    description:
      'An employee platform combining custom calendar and recurring event scheduling, video conferencing, attendance, leave tracking, and shared contacts in one connected workspace.',
    featured: true,
  },
  {
    slug: 'server-administration',
    area: 'Backend / Operations',
    tech: 'MEAN stack · SQL Server',
    title: 'Server administration',
    description:
      'A system for monitoring registered SQL Server instances through scheduled health checks, dashboards, and administrative inventory controls.',
  },
  {
    slug: 'identity-access-management',
    area: 'Backend / Identity',
    tech: 'Java · Python · Node.js',
    title: 'Identity and access management',
    description:
      'A central authentication platform supporting single sign-on, social authentication, custom authentication flows, and identity integrations across multiple applications.',
  },
  {
    slug: 'investment-portfolio-management',
    area: 'Web / Finance',
    tech: 'React · Data visualization',
    title: 'Investment portfolio management',
    description:
      'A wealth-management interface covering portfolio views, financial dashboards, charts, reporting, and billing information across different time periods.',
  },
  {
    slug: 'online-tutoring-platform',
    area: 'Web / Marketplace',
    tech: 'MEAN stack · Stripe Connect',
    title: 'Online tutoring platform',
    description:
      'Tutor discovery, availability, booking, virtual classroom access, payments, and administrative verification in one marketplace.',
  },
  {
    slug: 'ip-camera-service',
    area: 'Mobile / Connected devices',
    tech: 'Mobile app · Node.js',
    title: 'IP camera service',
    description:
      'Backend services for a mobile security product supporting camera access, sharing, events, and remote footage.',
  },
  {
    slug: 'local-services-platform',
    area: 'Mobile / On demand',
    tech: 'Mobile app · Node.js · Stripe Connect',
    title: 'Local services platform',
    description:
      'A request and notification workflow connecting customers with service providers, with payments handled through provider-managed Stripe accounts.',
  },
];

export const featuredProjects = projects.filter(
  (project) => project.featured,
);
