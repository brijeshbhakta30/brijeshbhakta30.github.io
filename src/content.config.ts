import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const writing = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/writing' }),
  schema: z.object({
    title: z.string(),
    permalink: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    category: z.string(),
    tags: z.array(z.string()).min(1),
    draft: z.boolean().default(false),
  }),
});

export const collections = { writing };
