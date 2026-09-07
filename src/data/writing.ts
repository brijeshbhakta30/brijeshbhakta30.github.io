import { getCollection, type CollectionEntry } from 'astro:content';

export type WritingPost = CollectionEntry<'writing'>;

const shouldShowPost = (post: WritingPost) =>
  import.meta.env.DEV || !post.data.draft;

export const sortPostsByPublishedDate = (posts: WritingPost[]) =>
  posts.toSorted(
    (a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf(),
  );

export const getWritingPosts = async () =>
  sortPostsByPublishedDate(
    (await getCollection('writing')).filter(shouldShowPost),
  );

export const getWritingTopics = (posts: WritingPost[]) =>
  [...new Set(posts.flatMap((post) => post.data.tags))].sort();
