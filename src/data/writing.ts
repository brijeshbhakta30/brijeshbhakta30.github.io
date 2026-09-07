import { type CollectionEntry, getCollection } from 'astro:content';

export type WritingPost = CollectionEntry<'writing'>;

const shouldShowPost = (post: WritingPost) =>
  import.meta.env.DEV || !post.data.draft;

export const sortPostsByPublishedDate = (posts: WritingPost[]) =>
  posts.toSorted(
    (a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf(),
  );

export const getWritingPosts = async () => {
  const posts = await getCollection('writing');
  const activePosts = posts.filter(post => shouldShowPost(post));
  return sortPostsByPublishedDate(activePosts);
}

export const getWritingTopics = (posts: WritingPost[]) =>
  [...new Set(posts.flatMap((post) => post.data.tags))]
    .toSorted((a, b) => a.localeCompare(b));
