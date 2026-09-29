/** Nominal typing for ids and other primitives (e.g. `type FileId = Brand<string, 'FileId'>`). */
export type Brand<T, B extends string> = T & { readonly __brand: B };
