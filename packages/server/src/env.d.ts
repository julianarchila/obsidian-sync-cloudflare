// Alchemy uses import.meta.url as the Worker entrypoint.
interface ImportMeta {
  readonly url: string;
}
